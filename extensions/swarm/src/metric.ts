// === swarm/metric.ts — auto-extracted from index.ts (verbatim bodies) ===
import { join, dirname, relative, sep } from "node:path";
import type { IterationBest, IterationSession, MemoryRecord, MetricContract, Paths, RunRecord } from "./types.ts";
import { MEMORY_POLICY_DOC } from "./constants.ts";
import { checkEvidenceRefs, latestMemories, verifyEvidenceDigests } from "./state.ts";
import { tmux } from "./tmux.ts";

export function evidenceRequirementMatches(required: string, refs: string[]): boolean {
	const normalized = required.replace(/^\.\//, "");
	return refs.some((ref) => {
		const candidate = ref.replace(/^\.\//, "");
		if (candidate === normalized) return true;
		return !normalized.includes("/") && candidate.split("/").pop() === normalized;
	});
}

export function metricValueMatchesContract(value: unknown, contract: MetricContract): boolean {
	if (contract.primaryMetric.valueType === "number") return typeof value === "number" && Number.isFinite(value);
	if (contract.primaryMetric.valueType === "boolean") return typeof value === "boolean";
	if (contract.primaryMetric.valueType === "string") return typeof value === "string";
	return false;
}

export function validateRunAgainstContract(run: RunRecord | undefined, contract: MetricContract | undefined): string[] {
	const reasons: string[] = [];
	if (!run) return ["run record does not exist"];
	if (!contract) return ["metric contract does not exist"];
	if (run.status !== "done") reasons.push(`run status is '${run.status || "(none)"}' (must be done)`);
	const verdict = (run.verdict || "").toLowerCase();
	if (verdict !== "pass" && verdict !== "approved") reasons.push(`run verdict is '${run.verdict || "(none)"}' (must be pass or approved)`);
	if (run.metricContractId !== contract.id) reasons.push(`run metricContractId is '${run.metricContractId || "(none)"}' (must be '${contract.id}')`);
	const contractVersion = contract.version || 1;
	if ((run.metricContractVersion || 0) !== contractVersion) reasons.push(`run metric contract version is '${run.metricContractVersion || "(none)"}' (current is ${contractVersion})`);
	const value = run.metrics?.[contract.primaryMetric.id];
	if (!metricValueMatchesContract(value, contract)) reasons.push(`primary metric '${contract.primaryMetric.id}' is missing or not a valid ${contract.primaryMetric.valueType}`);
	return reasons;
}

// Evidence-backed memory gate. It validates terminal run quality, metric-contract/version binding,
// required evidence, immutable evidence digests, and reconstructability for code/config changes.
export async function evaluateMemoryGate(opts: { cwd: string; run?: RunRecord; contract?: MetricContract; evidenceRefs: string[] }): Promise<{ accepted: boolean; reasons: string[] }> {
	const { run, contract, evidenceRefs, cwd } = opts;
	const reasons = validateRunAgainstContract(run, contract);
	if (!evidenceRefs || evidenceRefs.length === 0) {
		reasons.push("no evidenceRefs supplied");
	} else {
		const ev = await checkEvidenceRefs(cwd, evidenceRefs);
		if (!ev.ok) reasons.push(...ev.reasons);
		for (const required of contract?.evidenceRequired || []) {
			if (!evidenceRequirementMatches(required, evidenceRefs)) reasons.push(`required evidence is missing: ${required}`);
		}
		reasons.push(...await verifyEvidenceDigests(cwd, evidenceRefs, run?.evidenceDigests));
		const inputs = run?.inputs || {};
		const describesChange = Boolean(inputs.change || inputs.strategy || inputs.codeChanged || inputs.configChanged);
		const hasCommitRange = Boolean(run?.git?.baseCommit && run?.git?.headCommit && run.git.baseCommit !== run.git.headCommit);
		const hasDiff = evidenceRefs.some((r) => /\.(patch|diff)$/i.test(r));
		if (describesChange && !hasCommitRange && !hasDiff) reasons.push("code/config-changing run must include a .patch/.diff ref or distinct git base/head commits");
	}
	return { accepted: reasons.length === 0, reasons };
}

// ---- Iteration loop V1 helpers (file-backed session over metric/run/memory; no daemon, no graph cycles) ----

// The SINGLE place "best"/"improvement" is decided. Only terminal, passing/approved runs bound to
// the current metric-contract version and carrying a correctly typed primary metric are eligible.
export function computeIterationBest(entries: { runId: string; label?: string }[], runById: Map<string, RunRecord>, contract: MetricContract): IterationBest {
	const metricId = contract.primaryMetric.id;
	const direction = contract.primaryMetric.direction;
	const mmc = contract.primaryMetric.minimumMeaningfulChange;
	const target = contract.primaryMetric.target;
	const warnings: string[] = [];
	if (direction === "target" && typeof target !== "number") warnings.push("direction=target but contract has no primaryMetric.target; falling back to maximize");
	const effDir = direction === "target" && typeof target !== "number" ? "maximize" : direction;
	const perRun = entries.map((e) => {
		const r = runById.get(e.runId);
		const raw = r?.metrics?.[metricId];
		const present = raw !== undefined && raw !== null;
		const exclusionReasons = validateRunAgainstContract(r, contract);
		return { runId: e.runId, label: e.label, value: present ? (raw as number | boolean) : undefined, present, eligible: exclusionReasons.length === 0, exclusionReasons };
	});
	const eligible = perRun.filter((p) => p.eligible);
	const num = eligible.filter((p) => typeof p.value === "number").map((p) => ({ runId: p.runId, label: p.label, value: p.value as number }));
	const missingCount = perRun.filter((p) => !p.present).length;
	const invalidCount = perRun.filter((p) => !p.eligible).length;
	for (const p of perRun) if (!p.eligible) warnings.push(`run '${p.runId}' excluded: ${p.exclusionReasons.join("; ")}`);
	const baselineEntry = entries[0];
	const baselineResult = perRun[0];
	const baselineValue = baselineResult?.eligible ? baselineResult.value : undefined;
	let bestRunId: string | undefined;
	let bestValue: number | boolean | undefined;
	let improvement: number | undefined;
	let passingCount: number | undefined;
	let meaningful = false;
	if (effDir === "passfail") {
		const passing = eligible.filter((p) => p.value === true);
		passingCount = passing.length;
		bestRunId = passing[0]?.runId;
		bestValue = passing.length > 0 ? true : undefined;
		meaningful = passing.length > 0 && baselineValue !== true;
	} else if (num.length > 0) {
		let pick: { runId: string; value: number };
		if (effDir === "minimize") pick = num.reduce((a, b) => (b.value < a.value ? b : a));
		else if (effDir === "target" && typeof target === "number") pick = num.reduce((a, b) => (Math.abs(b.value - target) < Math.abs(a.value - target) ? b : a));
		else pick = num.reduce((a, b) => (b.value > a.value ? b : a)); // maximize / target-fallback
		bestRunId = pick.runId;
		bestValue = pick.value;
		if (typeof baselineValue === "number") {
			if (effDir === "target" && typeof target === "number") improvement = Math.abs(baselineValue - target) - Math.abs(pick.value - target);
			else if (effDir === "minimize") improvement = baselineValue - pick.value;
			else improvement = pick.value - baselineValue; // maximize
			meaningful = improvement > 0 && (typeof mmc !== "number" || improvement >= mmc);
		} else {
			meaningful = true; // gained a valid value where baseline was missing/invalid
		}
	}
	return { metricId, direction, target, bestRunId, bestValue, baselineRunId: baselineEntry?.runId, baselineValue, improvement, passingCount, meaningful, missingCount, invalidCount, perRun, warnings };
}

export function runSummary(run: RunRecord | undefined, metricId: string) {
	if (!run) return undefined;
	return { runId: run.runId, primaryMetricValue: run.metrics?.[metricId], verdict: run.verdict, gitHeadCommit: run.git?.headCommit, evidenceRefs: run.evidenceRefs || [], recordedAt: run.recordedAt };
}

// ─────────────────────────────────────────────────────────────────────────────
// V1.5 iteration proposal loop. Opt-in post-iteration wrapper that runs ONLY after a loop-enabled
// task reaches terminal DONE completion. Default tasks (no `loop` config) are completely unaffected.
// No daemon, no automatic graph cycle: the orchestrator manually synthesizes the next plan.
// State is file-backed under .pi/swarm/loops/<taskId>.* and human-readable artifacts under the task
// artifact folder. Refresh is best-effort (tmux /new + identity reload) and never corrupts loop state.
// ─────────────────────────────────────────────────────────────────────────────

// Next-iteration retrieval bundle: best run summary + active memories that still pass the evidence
// gate. Ranking is deterministic: pinned first, then confidence, then recency. Scope matches kind+id.
// The bundle also surfaces `memoryPolicyRef` so the next-iteration agent is pointed at the policy.
export async function buildIterationContext(p: Paths, session: IterationSession, runById: Map<string, RunRecord>, contract: MetricContract, best: IterationBest, memoryLimit = 10) {
	const metricId = contract.primaryMetric.id;
	const bestRun = best.bestRunId ? runById.get(best.bestRunId) : undefined;
	const baselineRun = session.baselineRunId ? runById.get(session.baselineRunId) : (session.iterations[0] ? runById.get(session.iterations[0].runId) : undefined);
	const lastEntry = session.iterations[session.iterations.length - 1];
	const lastRun = lastEntry ? runById.get(lastEntry.runId) : undefined;
	const memories = await latestMemories(p);
	const cwd = dirname(dirname(p.root));
	const scope = session.scope || { kind: "metric-contract", id: session.metricContractId };
	const candidates = memories
		.filter((m) => m.status === "active")
		.filter((m) => session.pinnedMemoryIds.includes(m.memoryId) || (m.scope?.kind === scope.kind && m.scope?.id === scope.id))
		.sort((a, b) => {
			const ap = session.pinnedMemoryIds.includes(a.memoryId) ? 1 : 0;
			const bp = session.pinnedMemoryIds.includes(b.memoryId) ? 1 : 0;
			if (ap !== bp) return bp - ap;
			if ((a.confidence || 0) !== (b.confidence || 0)) return (b.confidence || 0) - (a.confidence || 0);
			return (b.updatedAt || "").localeCompare(a.updatedAt || "");
		});
	const picked: MemoryRecord[] = [];
	const excludedMemories: { memoryId: string; reasons: string[] }[] = [];
	for (const m of candidates) {
		const run = runById.get(m.sourceRunId);
		const gate = await evaluateMemoryGate({ cwd, run, contract, evidenceRefs: m.evidenceRefs || [] });
		if (!gate.accepted) {
			excludedMemories.push({ memoryId: m.memoryId, reasons: gate.reasons });
			continue;
		}
		picked.push(m);
		if (picked.length >= memoryLimit) break;
	}
	const hint = `direction=${contract.primaryMetric.direction}; best=${best.bestRunId || "(none)"}${best.improvement !== undefined ? ` improvement=${best.improvement}` : ""}; meaningful=${best.meaningful}`;
	return {
		best: runSummary(bestRun, metricId),
		baseline: runSummary(baselineRun, metricId),
		last: runSummary(lastRun, metricId),
		memories: picked.map((m) => ({ memoryId: m.memoryId, claim: m.claim, sourceRunId: m.sourceRunId, evidenceRefs: m.evidenceRefs || [], scope: m.scope, confidence: m.confidence })),
		excludedMemories,
		memoryPolicyRef: MEMORY_POLICY_DOC,
		hint,
	};
}
