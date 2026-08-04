// === swarm/tools/metrics.ts — tool registrations (verbatim from index.ts) ===
import { Type } from "typebox";
import { defineTool, CONFIG_DIR_NAME, truncateHead, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, writeFile, appendFile, rm, stat, rename, readdir, realpath } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname, relative, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { IterationEntry, IterationSession, MemoryRecord, MetricContract, RunRecord } from "../types.ts";
import { METRIC_ID_RE, RUN_STATUSES, RUN_VERDICTS } from "../constants.ts";
import { appendJsonl, atomicWriteFile, captureEvidenceDigests, captureGitCommit, ensureDirs, iterationFile, latestMemories, latestRuns, paths, readIteration, readJsonlLatestById, readMetricContract, readState, trace, withLock, writeIteration } from "../state.ts";
import { buildIterationContext, computeIterationBest, evaluateMemoryGate, metricValueMatchesContract, validateRunAgainstContract } from "../metric.ts";
import { currentAgentId } from "../session.ts";
import { isSafeRelativePath, now, safeId, textResult } from "../utils.ts";

export function registerMetricsTools(pi: ExtensionAPI) {
	pi.registerTool(defineTool({
		name: "swarm_metric_define",
		label: "Swarm Metric Define",
		description: "Create or replace a project-specific metric contract under .pi/swarm/metrics/<id>.json. The project defines the metric (e.g. quality_score); the harness never hard-codes accuracy/latency/cost. No daemon, no value extraction in V1.",
		promptGuidelines: ["Use `swarm_metric_define` to author a project metric contract before recording runs against it."],
		parameters: Type.Object({
			id: Type.String({ description: "Safe metric id matching /^[a-z0-9_-]+$/." }),
			title: Type.String({ description: "Human-readable metric title." }),
			primaryMetric: Type.Object({
				id: Type.String({ description: "Metric identifier, e.g. quality_score." }),
				direction: Type.String({ description: "maximize | minimize | target | passfail." }),
				valueType: Type.String({ description: "number | boolean | string." }),
				source: Type.Object({
					type: Type.String({ description: "artifact | command | report | reviewer | external." }),
					artifactPath: Type.Optional(Type.String({ description: "Artifact path when type=artifact." })),
					jsonPath: Type.Optional(Type.String({ description: "JSON path into the artifact, e.g. $.quality_score." })),
					command: Type.Optional(Type.String({ description: "Command source (stored, not auto-run in V1)." })),
				}),
				minimumMeaningfulChange: Type.Optional(Type.Number()),
				target: Type.Optional(Type.Number({ description: "Goal value when direction=target." })),
			}),
			validityRules: Type.Optional(Type.Array(Type.String())),
			evidenceRequired: Type.Optional(Type.Array(Type.String({ description: "Artifact refs required to promote memory from runs against this contract." }))),
			notes: Type.Optional(Type.String()),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const p = paths(ctx.cwd);
			await ensureDirs(p);
			if (!METRIC_ID_RE.test(params.id)) throw new Error(`INVALID_METRIC_ID: id must match /^[a-z0-9_-]+$/ (got '${params.id}')`);
			if (!["maximize", "minimize", "target", "passfail"].includes(params.primaryMetric.direction)) throw new Error(`INVALID_DIRECTION: primaryMetric.direction must be one of maximize|minimize|target|passfail`);
			if (!["number", "boolean", "string"].includes(params.primaryMetric.valueType)) throw new Error(`INVALID_VALUE_TYPE: primaryMetric.valueType must be one of number|boolean|string`);
			if (params.primaryMetric.direction === "passfail" && params.primaryMetric.valueType !== "boolean") throw new Error("INVALID_METRIC_SHAPE: passfail direction requires valueType=boolean");
			if (["maximize", "minimize", "target"].includes(params.primaryMetric.direction) && params.primaryMetric.valueType !== "number") throw new Error(`INVALID_METRIC_SHAPE: ${params.primaryMetric.direction} direction requires valueType=number`);
			if (params.primaryMetric.direction === "target" && typeof params.primaryMetric.target !== "number") throw new Error("INVALID_METRIC_SHAPE: target direction requires primaryMetric.target");
			if (!params.primaryMetric.id?.trim()) throw new Error("INVALID_PRIMARY_METRIC: primaryMetric.id is required");
			const ts = now();
			const file = join(p.metricsDir, `${params.id}.json`);
			const prevExists = existsSync(file);
			let prev: MetricContract | undefined;
			if (prevExists) { try { prev = JSON.parse(await readFile(file, "utf8")) as MetricContract; } catch { prev = undefined; } }
			const contract: MetricContract = {
				id: params.id,
				title: params.title,
				version: (prev?.version || 0) + 1,
				primaryMetric: params.primaryMetric,
				validityRules: params.validityRules,
				evidenceRequired: params.evidenceRequired,
				notes: params.notes,
				status: "active",
				createdAt: prev?.createdAt || ts,
				updatedAt: ts,
			};
			await atomicWriteFile(file, `${JSON.stringify(contract, null, 2)}\n`);
			await trace(p, "metric.define", { id: contract.id, replaced: prevExists });
			return textResult(`${prevExists ? "Replaced" : "Created"} metric contract '${contract.id}' at ${relative(ctx.cwd, file)}.`, { contract, path: relative(ctx.cwd, file) });
		},
	}))

	pi.registerTool(defineTool({
		name: "swarm_metric_get",
		label: "Swarm Metric Get",
		description: "Read a project-specific metric contract by id.",
		promptGuidelines: ["Use `swarm_metric_get` to inspect a metric contract before recording or comparing runs."],
		parameters: Type.Object({
			id: Type.String({ description: "Metric contract id." }),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const p = paths(ctx.cwd);
			const file = join(p.metricsDir, `${safeId(params.id)}.json`);
			await trace(p, "metric.get", { id: params.id });
			if (!existsSync(file)) throw new Error(`METRIC_NOT_FOUND: no contract for id '${params.id}' at ${relative(ctx.cwd, file)}`);
			const contract = JSON.parse(await readFile(file, "utf8")) as MetricContract;
			return textResult(JSON.stringify(contract, null, 2), { contract, path: relative(ctx.cwd, file) });
		},
	}))

	pi.registerTool(defineTool({
		name: "swarm_run_record",
		label: "Swarm Run Record",
		description: "Append one append-only run record to .pi/swarm/runs/runs.jsonl with best-effort git capture and safe evidence refs. Existence of evidence is NOT required to record a run, but it IS required to promote memory.",
		promptGuidelines: ["Use `swarm_run_record` to durably log a run (with metrics, evidence refs, git commit) before proposing memory from it."],
		parameters: Type.Object({
			runId: Type.Optional(Type.String({ description: "Safe run id; generated as run-<timestamp>-<rand> if omitted." })),
			metricContractId: Type.Optional(Type.String()),
			taskId: Type.Optional(Type.String()),
			nodeId: Type.Optional(Type.String()),
			agentId: Type.Optional(Type.String()),
			model: Type.Optional(Type.String()),
			provider: Type.Optional(Type.String()),
			status: Type.String({ description: "running | done | blocked | failed." }),
			verdict: Type.Optional(Type.String({ description: "pass | fail | approved | rejected | blocked." })),
			metrics: Type.Optional(Type.Record(Type.String(), Type.Any({ description: "Free-form { metricId: value }; project-defined." }))),
			inputs: Type.Optional(Type.Record(Type.String(), Type.Any({ description: "Summary of what was run." }))),
			evidenceRefs: Type.Optional(Type.Array(Type.String({ description: "Safe relative paths (no .., no absolute)." }))),
			notes: Type.Optional(Type.String()),
			startedAt: Type.Optional(Type.String()),
			endedAt: Type.Optional(Type.String()),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const p = paths(ctx.cwd);
			await ensureDirs(p);
			if (!RUN_STATUSES.has(params.status)) throw new Error(`INVALID_RUN_STATUS: status must be one of ${Array.from(RUN_STATUSES).join("|")}`);
			if (params.verdict && !RUN_VERDICTS.has(params.verdict)) throw new Error(`INVALID_RUN_VERDICT: verdict must be one of ${Array.from(RUN_VERDICTS).join("|")}`);
			if (params.runId && !METRIC_ID_RE.test(params.runId)) throw new Error(`INVALID_RUN_ID: runId must match /^[a-z0-9_-]+$/ (got '${params.runId}')`);
			for (const ref of params.evidenceRefs || []) if (!isSafeRelativePath(ref)) throw new Error(`UNSAFE_EVIDENCE_REF: evidence refs must be relative with no '..': ${ref}`);
			const contract = params.metricContractId ? await readMetricContract(p, params.metricContractId) : undefined;
			if (params.metricContractId && !contract) throw new Error(`METRIC_NOT_FOUND: metric contract '${params.metricContractId}' does not exist`);
			const ts = now();
			const runId = params.runId || `run-${ts.replace(/[-:.TZ]/g, "").slice(0, 14)}-${randomUUID().slice(0, 6)}`;
			const [git, evidenceDigests] = await Promise.all([
				captureGitCommit(pi),
				captureEvidenceDigests(ctx.cwd, params.evidenceRefs || []),
			]);
			const rec: RunRecord = {
				runId,
				metricContractId: params.metricContractId,
				metricContractVersion: contract?.version || (contract ? 1 : undefined),
				taskId: params.taskId,
				nodeId: params.nodeId,
				agentId: params.agentId || currentAgentId(),
				model: params.model,
				provider: params.provider,
				status: params.status,
				verdict: params.verdict,
				metrics: params.metrics as Record<string, number | boolean | string> | undefined,
				inputs: params.inputs as Record<string, unknown> | undefined,
				evidenceRefs: params.evidenceRefs,
				evidenceDigests,
				notes: params.notes,
				startedAt: params.startedAt || ts,
				endedAt: params.endedAt || ts,
				git,
				recordedAt: ts,
			};
			if (contract && rec.metrics?.[contract.primaryMetric.id] !== undefined && !metricValueMatchesContract(rec.metrics[contract.primaryMetric.id], contract)) {
				throw new Error(`INVALID_PRIMARY_METRIC: '${contract.primaryMetric.id}' must be a valid ${contract.primaryMetric.valueType}`);
			}
			if (rec.status === "done" && (rec.verdict === "pass" || rec.verdict === "approved")) {
				const validation = validateRunAgainstContract(rec, contract);
				if (validation.length) throw new Error(`INVALID_ELIGIBLE_RUN: ${validation.join("; ")}`);
			}
			await withLock(p, async () => appendJsonl(join(p.runsDir, "runs.jsonl"), rec));
			await trace(p, "run.record", { runId: rec.runId, metricContractId: rec.metricContractId, metricContractVersion: rec.metricContractVersion, taskId: rec.taskId, status: rec.status, verdict: rec.verdict, gitAvailable: git.available, evidenceDigestCount: evidenceDigests.length });
			return textResult(`Recorded run '${rec.runId}' (${rec.status}${rec.verdict ? `, ${rec.verdict}` : ""}). Git: ${git.available ? git.headCommit : "unavailable"}. Evidence digests: ${evidenceDigests.length}.`, { run: rec, path: relative(ctx.cwd, join(p.runsDir, "runs.jsonl")) });
		},
	}))

	pi.registerTool(defineTool({
		name: "swarm_run_get",
		label: "Swarm Run Get",
		description: "Read the latest record for a runId from .pi/swarm/runs/runs.jsonl (append-only; latest line per runId wins).",
		promptGuidelines: ["Use `swarm_run_get` to inspect a run before proposing memory or comparing runs."],
		parameters: Type.Object({
			runId: Type.String({ description: "Run id to read." }),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const p = paths(ctx.cwd);
			const file = join(p.runsDir, "runs.jsonl");
			await trace(p, "run.get", { runId: params.runId });
			const latest = await readJsonlLatestById<RunRecord>(file, "runId");
			const run = latest.find((r) => r.runId === params.runId);
			if (!run) throw new Error(`RUN_NOT_FOUND: no run record for runId '${params.runId}'`);
			return textResult(JSON.stringify(run, null, 2), { run, path: relative(ctx.cwd, file) });
		},
	}))

	pi.registerTool(defineTool({
		name: "swarm_run_compare",
		label: "Swarm Run Compare",
		description: "Compare two or more recorded runs against an optional metric id. Generic: never ranks by a hard-coded metric. If a shared metric contract is linked, its direction wins; otherwise higherBetter is only a hint.",
		promptGuidelines: ["Use `swarm_run_compare` to summarize metric deltas across runs."],
		parameters: Type.Object({
			runIds: Type.Array(Type.String(), { description: "Two or more run ids to compare." }),
			metricId: Type.Optional(Type.String({ description: "Which metric from run.metrics to compare. If omitted, all metrics are summarized." })),
			higherBetter: Type.Optional(Type.Boolean({ description: "Hint only; the linked contract's direction wins when present." })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const p = paths(ctx.cwd);
			const file = join(p.runsDir, "runs.jsonl");
			if (!params.runIds || params.runIds.length < 2) throw new Error("Compare requires at least two runIds");
			const latest = await readJsonlLatestById<RunRecord>(file, "runId");
			const byId = new Map(latest.map((r) => [r.runId, r] as const));
			let direction: string | undefined;
			let contractId: string | undefined;
			for (const id of params.runIds) { const r = byId.get(id); if (r?.metricContractId) { contractId = r.metricContractId; break; } }
			if (contractId) {
				const cfile = join(p.metricsDir, `${safeId(contractId)}.json`);
				if (existsSync(cfile)) { try { direction = (JSON.parse(await readFile(cfile, "utf8")) as MetricContract).primaryMetric.direction; } catch { /* ignore */ } }
			}
			const higherBetter = direction ? direction === "maximize" : params.higherBetter !== false;
			const first = params.runIds[0];
			const metricIds = params.metricId ? [params.metricId] : Array.from(new Set(params.runIds.flatMap((id) => Object.keys(byId.get(id)?.metrics || {}))));
			const rows = metricIds.map((mid) => {
				const values = params.runIds.map((id) => { const v = byId.get(id)?.metrics?.[mid]; return { runId: id, value: v, present: v !== undefined && v !== null }; });
				const num = values.filter((v) => typeof v.value === "number").map((v) => ({ runId: v.runId, value: v.value as number }));
				const best = num.length ? (higherBetter ? num.reduce((a, b) => (b.value > a.value ? b : a)) : num.reduce((a, b) => (b.value < a.value ? b : a))).runId : undefined;
				return { metricId: mid, values, bestRunId: best, baselineRunId: first, baselineValue: byId.get(first)?.metrics?.[mid], direction: direction || (higherBetter ? "higher-better(hint)" : "lower-better(hint)") };
			});
			await trace(p, "run.compare", { runIds: params.runIds, metricIds, contractId, direction });
			return textResult(JSON.stringify({ contractId, direction, compared: params.runIds, metrics: rows }, null, 2), { contractId, runIds: params.runIds, metrics: rows, path: relative(ctx.cwd, file) });
		},
	}))

	pi.registerTool(defineTool({
		name: "swarm_memory_propose",
		label: "Swarm Memory Propose",
		description: "Propose an evidence-backed memory claim sourced from a run. Runs the evidence gate; on failure the record is still appended as 'rejected' with a rejectionReason (auditable) but never auto-activates.",
		promptGuidelines: ["Use `swarm_memory_propose` after a passing/approved run with complete file-backed evidence. Pane-only/ack-only claims are rejected."],
		parameters: Type.Object({
			claim: Type.String({ description: "The memory claim text." }),
			sourceRunId: Type.String({ description: "Run id the claim is sourced from; must exist in runs.jsonl." }),
			evidenceRefs: Type.Optional(Type.Array(Type.String({ description: "Defaults to the source run's evidenceRefs." }))),
			scope: Type.Optional(Type.Object({ kind: Type.Optional(Type.String()), id: Type.Optional(Type.String()) })),
			confidence: Type.Optional(Type.Number({ description: "0..1, default 0.5." })),
			notes: Type.Optional(Type.String()),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const p = paths(ctx.cwd);
			await ensureDirs(p);
			const file = join(p.runsDir, "runs.jsonl");
			const memFile = join(p.memoryDir, "memory.jsonl");
			const latest = await readJsonlLatestById<RunRecord>(file, "runId");
			const run = latest.find((r) => r.runId === params.sourceRunId);
			const contract = run?.metricContractId ? await readMetricContract(p, run.metricContractId) : undefined;
			const evidenceRefs = (params.evidenceRefs && params.evidenceRefs.length ? params.evidenceRefs : run?.evidenceRefs) || [];
			for (const ref of evidenceRefs) if (!isSafeRelativePath(ref)) throw new Error(`UNSAFE_EVIDENCE_REF: ${ref}`);
			const gate = await evaluateMemoryGate({ cwd: ctx.cwd, run, contract, evidenceRefs });
			const ts = now();
			const memoryId = `mem-${ts.replace(/[-:.TZ]/g, "").slice(0, 14)}-${randomUUID().slice(0, 6)}`;
			const rec: MemoryRecord = {
				memoryId,
				claim: params.claim,
				sourceRunId: params.sourceRunId,
				evidenceRefs,
				scope: params.scope || (contract ? { kind: "metric-contract", id: contract.id } : undefined),
				confidence: typeof params.confidence === "number" ? Math.max(0, Math.min(1, params.confidence)) : 0.5,
				status: gate.accepted ? "proposed" : "rejected",
				rejectionReason: gate.accepted ? undefined : gate.reasons.join("; "),
				notes: params.notes,
				createdAt: ts,
				updatedAt: ts,
			};
			await withLock(p, async () => appendJsonl(memFile, rec));
			await trace(p, "memory.propose", { memoryId, sourceRunId: params.sourceRunId, metricContractId: contract?.id, accepted: gate.accepted, status: rec.status });
			return textResult(`${gate.accepted ? "Proposed" : "Rejected (audited)"} memory '${memoryId}' from run '${params.sourceRunId}'.${gate.accepted ? "" : ` Reasons: ${gate.reasons.join("; ")}`}`, { memory: rec, gate, path: relative(ctx.cwd, memFile) });
		},
	}))

	pi.registerTool(defineTool({
		name: "swarm_memory_search",
		label: "Swarm Memory Search",
		description: "File-backed substring + scope filter over memory records (no vector DB/embeddings). Returns latest-per-memoryId matching filters.",
		promptGuidelines: ["Use `swarm_memory_search` to find active/proposed/rejected memory by query or scope."],
		parameters: Type.Object({
			query: Type.Optional(Type.String({ description: "Case-insensitive substring over claim/notes." })),
			scopeId: Type.Optional(Type.String()),
			kind: Type.Optional(Type.String()),
			status: Type.Optional(Type.String({ description: "proposed | active | rejected | expired." })),
			limit: Type.Optional(Type.Number()),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const p = paths(ctx.cwd);
			const memFile = join(p.memoryDir, "memory.jsonl");
			let records = await readJsonlLatestById<MemoryRecord>(memFile, "memoryId");
			if (params.query) { const q = params.query.toLowerCase(); records = records.filter((r) => `${r.claim || ""} ${r.notes || ""}`.toLowerCase().includes(q)); }
			if (params.scopeId) records = records.filter((r) => r.scope?.id === params.scopeId);
			if (params.kind) records = records.filter((r) => r.scope?.kind === params.kind);
			if (params.status) records = records.filter((r) => r.status === params.status);
			records = records.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || "")).slice(0, Math.max(1, Math.min(200, params.limit || 20)));
			await trace(p, "memory.search", { query: params.query, scopeId: params.scopeId, kind: params.kind, status: params.status, count: records.length });
			return textResult(JSON.stringify({ count: records.length, records }, null, 2), { count: records.length, records, path: relative(ctx.cwd, memFile) });
		},
	}))

	pi.registerTool(defineTool({
		name: "swarm_memory_accept",
		label: "Swarm Memory Accept",
		description: "Role-gated reviewer/orchestrator transition: proposed memory to active/rejected (or active to rejected). Rechecks run, contract version, required evidence, digests, and reconstructability before activation.",
		promptGuidelines: ["Use `swarm_memory_accept` to promote a proposed memory after review; it re-runs the evidence gate before activating."],
		parameters: Type.Object({
			memoryId: Type.String({ description: "Memory id to transition." }),
			status: Type.String({ description: "active | rejected." }),
			reviewedBy: Type.Optional(Type.String({ description: "Defaults to the current agent id." })),
			note: Type.Optional(Type.String()),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const p = paths(ctx.cwd);
			await ensureDirs(p);
			if (params.status !== "active" && params.status !== "rejected") throw new Error(`INVALID_STATUS: status must be active or rejected (got '${params.status}')`);
			const memFile = join(p.memoryDir, "memory.jsonl");
			const runsFile = join(p.runsDir, "runs.jsonl");
			const me = currentAgentId();
			const rec = await withLock(p, async () => {
				const st = await readState(p, ctx.cwd);
				const roleKind = me === "orchestrator" ? "orchestrator" : st.agents[me]?.roleKind;
				if (roleKind !== "orchestrator" && roleKind !== "reviewer") throw new Error(`MEMORY_REVIEW_FORBIDDEN: agent '${me}' (${roleKind || "unknown"}) is not reviewer/orchestrator`);
				if (params.reviewedBy && params.reviewedBy !== me && me !== "orchestrator") throw new Error("REVIEWER_IMPERSONATION_FORBIDDEN: only orchestrator may override reviewedBy");
				const latest = await readJsonlLatestById<MemoryRecord>(memFile, "memoryId");
				const prev = latest.find((r) => r.memoryId === params.memoryId);
				if (!prev) throw new Error(`MEMORY_NOT_FOUND: no memory record for memoryId '${params.memoryId}'`);
				if (params.status === "active" && prev.status !== "proposed") throw new Error(`INVALID_MEMORY_TRANSITION: only proposed memory can become active (current=${prev.status})`);
				if (params.status === "rejected" && prev.status !== "proposed" && prev.status !== "active") throw new Error(`INVALID_MEMORY_TRANSITION: only proposed/active memory can become rejected (current=${prev.status})`);
				if (params.status === "active") {
					const runLatest = await readJsonlLatestById<RunRecord>(runsFile, "runId");
					const run = runLatest.find((r) => r.runId === prev.sourceRunId);
					const contract = run?.metricContractId ? await readMetricContract(p, run.metricContractId) : undefined;
					const gate = await evaluateMemoryGate({ cwd: ctx.cwd, run, contract, evidenceRefs: prev.evidenceRefs || [] });
					if (!gate.accepted) throw new Error(`GATE_FAILED: cannot activate memory '${params.memoryId}': ${gate.reasons.join("; ")}`);
				}
				const ts = now();
				const next: MemoryRecord = {
					...prev,
					status: params.status,
					reviewedBy: params.reviewedBy || me,
					notes: params.note ? `${prev.notes || ""}\n${params.note}`.trim() : prev.notes,
					updatedAt: ts,
				};
				await appendJsonl(memFile, next);
				return next;
			});
			await trace(p, "memory.accept", { memoryId: rec.memoryId, status: rec.status, reviewedBy: rec.reviewedBy });
			return textResult(`Memory '${rec.memoryId}' is now ${rec.status} (reviewed by ${rec.reviewedBy}).`, { memory: rec, path: relative(ctx.cwd, memFile) });
		},
	}))

	pi.registerTool(defineTool({
		name: "swarm_iteration_create",
		label: "Swarm Iteration Create",
		description: "Create a file-backed iteration session over an existing metric contract under .pi/swarm/iterations/<id>.json. Stores ids only (references runs/memories, never duplicates). No daemon, no graph cycles.",
		promptGuidelines: ["Use `swarm_iteration_create` to start an evidence-backed optimization session over a metric contract; pass an optional baselineRunId and pinned memoryIds."],
		parameters: Type.Object({
			id: Type.Optional(Type.String({ description: "Safe iteration id; generated as iter-<timestamp>-<rand> if omitted." })),
			metricContractId: Type.String({ description: "Required metric contract id; drives best/improvement derivation." }),
			goal: Type.Optional(Type.String()),
			scope: Type.Optional(Type.Object({ kind: Type.Optional(Type.String()), id: Type.Optional(Type.String()) })),
			baselineRunId: Type.Optional(Type.String({ description: "Optional existing run id to seed as baseline (validated to exist)." })),
			memoryIds: Type.Optional(Type.Array(Type.String({ description: "Initial pinned active memories (validated to exist)." }))),
			notes: Type.Optional(Type.String()),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const p = paths(ctx.cwd);
			await ensureDirs(p);
			const ts = now();
			const result = await withLock(p, async () => {
				const contract = await readMetricContract(p, params.metricContractId);
				if (!contract) throw new Error(`METRIC_NOT_FOUND: metric contract '${params.metricContractId}' does not exist; create it with swarm_metric_define first`);
				const runs = await latestRuns(p);
				const runById = new Map(runs.map((r) => [r.runId, r] as const));
				const memories = await latestMemories(p);
				const memoryById = new Map(memories.map((m) => [m.memoryId, m] as const));
				const iterations: IterationEntry[] = [];
				if (params.baselineRunId) {
					const baseline = runById.get(params.baselineRunId);
					if (!baseline) throw new Error(`RUN_NOT_FOUND: baseline run '${params.baselineRunId}' does not exist`);
					const validation = validateRunAgainstContract(baseline, contract);
					if (validation.length) throw new Error(`INVALID_BASELINE_RUN: ${validation.join("; ")}`);
					iterations.push({ index: 1, runId: params.baselineRunId, label: "baseline", recordedAt: ts });
				}
				const pinned: string[] = [];
				for (const mid of params.memoryIds || []) {
					const memory = memoryById.get(mid);
					if (!memory) throw new Error(`MEMORY_NOT_FOUND: memory '${mid}' does not exist`);
					if (memory.status !== "active") throw new Error(`MEMORY_NOT_ACTIVE: memory '${mid}' is ${memory.status}`);
					if (!pinned.includes(mid)) pinned.push(mid);
				}
				const iterationId = params.id && METRIC_ID_RE.test(params.id) ? params.id : `iter-${ts.replace(/[-:.TZ]/g, "").slice(0, 14)}-${randomUUID().slice(0, 6)}`;
				if (await readIteration(p, iterationId)) throw new Error(`ITERATION_EXISTS: session '${iterationId}' already exists`);
				const session: IterationSession = {
					iterationId,
					metricContractId: params.metricContractId,
					goal: params.goal,
					scope: params.scope || { kind: "metric-contract", id: params.metricContractId },
					baselineRunId: params.baselineRunId,
					iterations,
					pinnedMemoryIds: pinned,
					status: "active",
					notes: params.notes,
					createdAt: ts,
					updatedAt: ts,
				};
				if (iterations.length) session.bestRunId = computeIterationBest(iterations, runById, contract).bestRunId;
				await writeIteration(p, session);
				return { session };
			});
			await trace(p, "iteration.create", { iterationId: result.session.iterationId, metricContractId: params.metricContractId, baselineRunId: params.baselineRunId });
			return textResult(`Created iteration '${result.session.iterationId}' over metric '${params.metricContractId}' with ${result.session.iterations.length} run(s) and ${result.session.pinnedMemoryIds.length} pinned memory/memories.`, { iteration: result.session, path: relative(ctx.cwd, iterationFile(p, result.session.iterationId)) });
		},
	}))

	pi.registerTool(defineTool({
		name: "swarm_iteration_record",
		label: "Swarm Iteration Record",
		description: "Append a unique, valid terminal run bound to the iteration's metric contract/version, then recompute best/improvement. Failed/running/cross-contract runs are rejected; optional pinned memories must be active.",
		promptGuidelines: ["Use `swarm_iteration_record` after a new run to add it to a session and recompute the contract-driven best/improvement."],
		parameters: Type.Object({
			iterationId: Type.String({ description: "Iteration session id." }),
			runId: Type.String({ description: "Existing run id to add (validated to exist in runs.jsonl)." }),
			label: Type.Optional(Type.String()),
			memoryIds: Type.Optional(Type.Array(Type.String({ description: "Additional active memories to pin (validated to exist)." }))),
			notes: Type.Optional(Type.String()),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const p = paths(ctx.cwd);
			await ensureDirs(p);
			const result = await withLock(p, async () => {
				const session = await readIteration(p, params.iterationId);
				if (!session) throw new Error(`ITERATION_NOT_FOUND: session '${params.iterationId}' does not exist`);
				const contract = await readMetricContract(p, session.metricContractId);
				if (!contract) throw new Error(`METRIC_NOT_FOUND: contract '${session.metricContractId}' no longer exists`);
				const runs = await latestRuns(p);
				const runById = new Map(runs.map((r) => [r.runId, r] as const));
				if (!runById.has(params.runId)) throw new Error(`RUN_NOT_FOUND: run '${params.runId}' does not exist`);
				const warnings: string[] = [];
				const run = runById.get(params.runId)!;
				const validation = validateRunAgainstContract(run, contract);
				if (validation.length) throw new Error(`INVALID_ITERATION_RUN: ${validation.join("; ")}`);
				if (session.iterations.some((entry) => entry.runId === params.runId)) throw new Error(`DUPLICATE_ITERATION_RUN: run '${params.runId}' is already recorded`);
				const ts = now();
				session.iterations.push({ index: session.iterations.length + 1, runId: params.runId, label: params.label, recordedAt: ts });
				const memories = await latestMemories(p);
				const memoryById = new Map(memories.map((m) => [m.memoryId, m] as const));
				for (const mid of params.memoryIds || []) {
					const memory = memoryById.get(mid);
					if (!memory) throw new Error(`MEMORY_NOT_FOUND: memory '${mid}' does not exist`);
					if (memory.status !== "active") throw new Error(`MEMORY_NOT_ACTIVE: memory '${mid}' is ${memory.status}`);
					if (!session.pinnedMemoryIds.includes(mid)) session.pinnedMemoryIds.push(mid);
				}
				if (params.notes) session.notes = session.notes ? `${session.notes}\n${params.notes}` : params.notes;
				const best = computeIterationBest(session.iterations, runById, contract);
				session.bestRunId = best.bestRunId;
				await writeIteration(p, session);
				return { session, best, warnings };
			});
			for (const w of result.warnings) await trace(p, "iteration.record.warning", { iterationId: params.iterationId, runId: params.runId, warning: w });
			await trace(p, "iteration.record", { iterationId: params.iterationId, runId: params.runId, bestRunId: result.best.bestRunId, meaningful: result.best.meaningful });
			return textResult(`Recorded run '${params.runId}' as iteration ${result.session.iterations.length} of '${params.iterationId}'. Best=${result.best.bestRunId || "(none)"}${result.best.improvement !== undefined ? `, improvement=${result.best.improvement}` : ""}, meaningful=${result.best.meaningful}.${result.warnings.length ? ` Warnings: ${result.warnings.join("; ")}` : ""}`, { iteration: result.session, best: result.best, warnings: result.warnings });
		},
	}))

	pi.registerTool(defineTool({
		name: "swarm_iteration_status",
		label: "Swarm Iteration Status",
		description: "Read an iteration session plus the derived best/improvement roll-up (contract-driven, generic). Optionally include the next-iteration context bundle.",
		promptGuidelines: ["Use `swarm_iteration_status` to inspect the best run, improvement vs baseline, and missing-metric counts for a session."],
		parameters: Type.Object({
			iterationId: Type.String({ description: "Iteration session id." }),
			includeContext: Type.Optional(Type.Boolean({ description: "If true, also return the next-iteration context bundle (best/last/memories)." })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const p = paths(ctx.cwd);
			const session = await readIteration(p, params.iterationId);
			if (!session) throw new Error(`ITERATION_NOT_FOUND: session '${params.iterationId}' does not exist`);
			const contract = await readMetricContract(p, session.metricContractId);
			if (!contract) throw new Error(`METRIC_NOT_FOUND: contract '${session.metricContractId}' no longer exists`);
			const runs = await latestRuns(p);
			const runById = new Map(runs.map((r) => [r.runId, r] as const));
			const best = computeIterationBest(session.iterations, runById, contract);
			let contextBundle: Awaited<ReturnType<typeof buildIterationContext>> | undefined = undefined;
			if (params.includeContext) contextBundle = await buildIterationContext(p, session, runById, contract, best, 10);
			await trace(p, "iteration.status", { iterationId: params.iterationId, bestRunId: best.bestRunId, meaningful: best.meaningful, includeContext: Boolean(params.includeContext) });
			return textResult(JSON.stringify({ iteration: session, derived: best, context: contextBundle }, null, 2), { iteration: session, derived: best, context: contextBundle, path: relative(ctx.cwd, iterationFile(p, params.iterationId)) });
		},
	}))

	pi.registerTool(defineTool({
		name: "swarm_iteration_context",
		label: "Swarm Iteration Context",
		description: "Next-iteration retrieval: previous best run plus active memories matching scope kind+id or pinned. Memories are revalidated against contract/evidence digests and ranked pinned-first, confidence, recency; stale memories are excluded with reasons.",
		promptGuidelines: ["Use `swarm_iteration_context` to build the carry-forward bundle (best run + active memories) for the next iteration."],
		parameters: Type.Object({
			iterationId: Type.String({ description: "Iteration session id." }),
			memoryLimit: Type.Optional(Type.Number({ description: "Max active memories to return. Default 10." })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const p = paths(ctx.cwd);
			const session = await readIteration(p, params.iterationId);
			if (!session) throw new Error(`ITERATION_NOT_FOUND: session '${params.iterationId}' does not exist`);
			const contract = await readMetricContract(p, session.metricContractId);
			if (!contract) throw new Error(`METRIC_NOT_FOUND: contract '${session.metricContractId}' no longer exists`);
			const runs = await latestRuns(p);
			const runById = new Map(runs.map((r) => [r.runId, r] as const));
			const best = computeIterationBest(session.iterations, runById, contract);
			const context = await buildIterationContext(p, session, runById, contract, best, Math.max(1, Math.min(100, params.memoryLimit || 10)));
			await trace(p, "iteration.context", { iterationId: params.iterationId, bestRunId: best.bestRunId, memoryCount: context.memories.length });
			return textResult(JSON.stringify({ iterationId: params.iterationId, metricContractId: session.metricContractId, context }, null, 2), { iterationId: params.iterationId, context });
		},
	}))
}
