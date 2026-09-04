import { Type } from "typebox";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createReadStream, createWriteStream, existsSync, statSync } from "node:fs";
import { mkdir, readFile, readdir, rm, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { Readable } from "node:stream";
import { createGunzip, createGzip } from "node:zlib";
import { createInterface } from "node:readline";
import { pipeline } from "node:stream/promises";
import type { Paths, SwarmState } from "../types.ts";
import { DEFAULT_TRACE_KEEP_GENERATIONS, DEFAULT_TRACE_RETENTION_MS, DEFAULT_TRACE_ROTATE_BYTES } from "../constants.ts";
import { paths, readState, trace } from "../state.ts";
import { readCommitEvidence } from "../taskgraph.ts";
import { textResult } from "../utils.ts";
import { wrapSwarmToolInvocation } from "./wrapper.ts";

export type AuditEventFilter = {
	event?: string;
	since?: string | number;
	until?: string | number;
	agent?: string;
	task?: string;
	cid?: string;
	limit?: number;
};

type AuditTimelineStage = { stage: string; ts: string; source: "record" | "trace"; detail?: string };

function toMs(input: string | number | undefined): number | undefined {
	if (input === undefined || input === null || input === "") return undefined;
	if (typeof input === "number" && Number.isFinite(input)) return input;
	const n = Number(input);
	if (Number.isFinite(n)) return n;
	const t = Date.parse(String(input));
	return Number.isFinite(t) ? t : undefined;
}

function eventMatches(rec: any, opts: AuditEventFilter, payload?: string): boolean {
	if (!rec || typeof rec !== "object") return false;
	const serialized = payload ?? JSON.stringify(rec);
	if (opts.event) {
		if (opts.event.endsWith(".") || opts.event.endsWith("*")) {
			const prefix = opts.event.replace(/[.*]+$/, "");
			if (!String(rec.event || "").startsWith(prefix)) return false;
		} else if (String(rec.event || "") !== opts.event) return false;
	}
	const ts = toMs(rec.ts);
	const since = toMs(opts.since);
	const until = toMs(opts.until);
	if (since !== undefined && (ts === undefined || ts < since)) return false;
	if (until !== undefined && (ts === undefined || ts > until)) return false;
	if (opts.agent) {
		const a = String(opts.agent);
		const agentMatch = [rec.agentId, rec.by, rec.from, rec.to].some((v) => String(v || "") === a) || serialized.includes(`"agentId":"${a}"`) || serialized.includes(`"from":"${a}"`) || serialized.includes(`"to":"${a}"`);
		if (!agentMatch) return false;
	}
	if (opts.task) {
		if (String(rec.taskId || "") !== opts.task && !serialized.includes(`"taskId":"${opts.task}"`)) return false;
	}
	if (opts.cid) {
		if (String(rec.cid || rec.conversationId || "") !== opts.cid && !serialized.includes(`"cid":"${opts.cid}"`) && !serialized.includes(`"conversationId":"${opts.cid}"`)) return false;
	}
	return true;
}

function normalizeEvent(rec: any) {
	return { ts: rec.ts, event: rec.event, detail: rec };
}

async function openTraceInput(file: string) {
	const input = createReadStream(file, { encoding: "utf8" });
	if (!file.endsWith(".gz")) return input;
	const gunzip = createGunzip();
	input.pipe(gunzip);
	return gunzip.setEncoding("utf8");
}

async function readTraceFile(file: string, opts: AuditEventFilter, stopAfterLimit = true) {
	const out: any[] = [];
	let scanned = 0;
	if (!existsSync(file)) return { out, scanned };
	const input = await openTraceInput(file);
	const rl = createInterface({ input, crlfDelay: Infinity });
	for await (const line of rl) {
		scanned++;
		if (!line || !String(line).trim()) continue;
		let rec: any;
		try { rec = JSON.parse(String(line)); } catch { continue; }
		const serialized = JSON.stringify(rec);
		if (!eventMatches(rec, opts, serialized)) continue;
		out.push(normalizeEvent(rec));
		if (stopAfterLimit && opts.limit && out.length >= opts.limit) break;
	}
	return { out, scanned };
}

function messageStageList(st: SwarmState, messageId: string) {
	const rec = st.messages?.[messageId];
	if (!rec) return { messageId, stages: [], gaps: ["message_missing"] as string[], record: undefined };
	const stages: AuditTimelineStage[] = [];
	const add = (stage: string, ts?: string, source: "record" | "trace" = "record", detail?: string) => {
		if (!ts) return;
		stages.push({ stage, ts, source, detail });
	};
	add("created", rec.createdAt, "record");
	add("queued", rec.queuedAt || rec.createdAt, "record");
	add("mailbox_delivered", rec.mailboxDeliveredAt, "record");
	add("injected", rec.injectedAt, "record");
	add("intercepted", rec.interceptedAt, "record");
	add("acked", rec.ackedAt, "record", rec.lastAck?.status || undefined);
	add("response_verified", rec.response?.verifiedAt, "record");
	add("response_sent", rec.response?.sentAt, "record");
	add("response_waived", rec.response?.waivedAt, "record");
	add("dead_letter", rec.failedAt, "record");
	stages.sort((a, b) => a.ts.localeCompare(b.ts));
	const expected = ["created", "queued", "mailbox_delivered", "injected", "acked", "response_sent"];
	const gaps = expected.filter((stage) => !stages.some((s) => s.stage === stage));
	return { messageId, stages, gaps, record: rec };
}

function probeP1(st: SwarmState, ttlMs = Number(process.env.PI_SWARM_AUDIT_MESSAGE_TTL_MS) > 0 ? Number(process.env.PI_SWARM_AUDIT_MESSAGE_TTL_MS) : 30 * 60 * 1000) {
	const nowMs = Date.now();
	return Object.values(st.messages || {}).filter((rec: any) => {
		const status = String(rec.status || "");
		const actionable = ["queued", "mailbox_delivered", "injected", "intercepted", "failed", "acked"].includes(status) && rec.lastAck?.status !== "done" && rec.response?.status !== "verified" && rec.response?.status !== "waived";
		const created = Date.parse(rec.createdAt || 0);
		return actionable && Number.isFinite(created) && nowMs - created > ttlMs;
	}).map((rec: any) => ({ messageId: rec.id, ageMs: nowMs - Date.parse(rec.createdAt || 0), status: rec.status, createdAt: rec.createdAt, updatedAt: rec.updatedAt }));
}

function probeP2(st: SwarmState) {
	return Object.values(st.messages || {}).filter((rec: any) => rec.status === "dead_letter").map((rec: any) => ({ messageId: rec.id, status: rec.status, updatedAt: rec.updatedAt, attempts: rec.attempts }));
}

function probeP3(events: any[]) {
	const hits = events.filter((e) => String(e.event || "") === "mailbox.orchestrator_pump_stuck_escalated").sort((a, b) => String(a.ts || "").localeCompare(String(b.ts || "")));
	const epochs: any[] = [];
	let current: any | undefined;
	for (const e of hits) {
		const wait = Number(e.detail?.oldestWaitMs || e.detail?.waitMs || 0);
		if (!current || Date.parse(e.ts) - Date.parse(current.lastTs) > 5_000) {
			current = { startTs: e.ts, lastTs: e.ts, count: 1, maxOldestWaitMs: wait };
			epochs.push(current);
		} else {
			current.lastTs = e.ts;
			current.count += 1;
			current.maxOldestWaitMs = Math.max(current.maxOldestWaitMs, wait);
		}
	}
	return epochs;
}

function probeP4(events: any[], thresholdN = 3, windowMs = 60_000) {
	const buckets = new Map<string, number[]>();
	for (const e of events) {
		const event = String(e.event || "");
		let key: string | undefined;
		if (event.startsWith("goal.nudge.")) key = String(e.detail?.goalId || e.detail?.cid || e.detail?.goal?.id || "goal");
		else if (event === "graph.advance_nudge_emitted" || event.startsWith("task.stall") || event.startsWith("graph.advance")) key = String(e.detail?.taskId || e.detail?.nodeId || "task");
		if (!key) continue;
		const arr = buckets.get(key) || [];
		const ts = Date.parse(e.ts || Date.now());
		if (Number.isFinite(ts)) arr.push(ts);
		buckets.set(key, arr);
	}
	return Array.from(buckets.entries()).flatMap(([key, arr]) => {
		arr.sort((a, b) => a - b);
		const bursts: any[] = [];
		for (let i = 0; i < arr.length; i++) {
			let j = i;
			while (j < arr.length && arr[j] - arr[i] <= windowMs) j++;
			const count = j - i;
			if (count > thresholdN) bursts.push({ key, count, windowMs, firstTs: new Date(arr[i]).toISOString(), lastTs: new Date(arr[j - 1]).toISOString() });
			i = j - 1;
		}
		return bursts;
	});
}

function rollupEvents(events: any[], windowMs: number) {
	const buckets = new Map<string, Record<string, number>>();
	for (const e of events) {
		const ts = Date.parse(e.ts || 0);
		if (!Number.isFinite(ts)) continue;
		const bucket = Math.floor(ts / windowMs) * windowMs;
		const key = new Date(bucket).toISOString();
		const rec = buckets.get(key) || {};
		rec[String(e.event || "unknown")] = (rec[String(e.event || "unknown")] || 0) + 1;
		buckets.set(key, rec);
	}
	return { windowMs, buckets: Array.from(buckets.entries()).sort(([a], [b]) => a.localeCompare(b)).map(([start, counts]) => ({ start, counts })) };
}

export async function readAuditEvents(p: Paths, opts: AuditEventFilter & { generations?: boolean; rollupWindowMs?: number } = {}) {
	const started = Date.now();
	const generations = opts.generations !== false;
	const filters: AuditEventFilter = { ...opts };
	const files = [p.events];
	if (generations && existsSync(join(p.traces, "events.rollup.json"))) {
		try {
			const rollup = JSON.parse(await readFile(join(p.traces, "events.rollup.json"), "utf8"));
			for (const g of rollup?.generations || []) {
				if (g?.file) files.push(String(g.file).endsWith(".gz") ? String(g.file) : join(p.traces, basename(g.file)));
			}
		} catch {}
	}
	let scanned = 0;
	const rows: any[] = [];
	for (const file of files) {
		const res = await readTraceFile(file, filters, !opts.rollupWindowMs);
		scanned += res.scanned;
		rows.push(...res.out);
		if (filters.limit && !opts.rollupWindowMs && rows.length >= filters.limit) break;
	}
	const events = filters.limit ? rows.slice(0, filters.limit) : rows;
	const source = { file: p.events, bytesScanned: files.map((f) => existsSync(f) ? statSync(f).size : 0).reduce((a, b) => a + b, 0), generationsIncluded: generations };
	return { schema: "swarm-audit/v1", generatedAt: new Date().toISOString(), mode: "events", filters, source, durationMs: Date.now() - started, counts: { events: events.length, scanned }, events, rollup: opts.rollupWindowMs ? rollupEvents(rows, opts.rollupWindowMs) : undefined };
}

export async function auditTimeline(p: Paths, messageId: string, opts: AuditEventFilter & { generations?: boolean } = {}) {
	const started = Date.now();
	const cwd = dirname(dirname(p.root));
	const st = await readState(p, cwd);
	const record = st.messages?.[messageId];
	const fileEvents = await readAuditEvents(p, { ...opts, messageId: undefined, limit: 500 });
	const traceEvents = (fileEvents.events || []).filter((e: any) => {
		const d = e.detail || e;
		return String(d.messageId || d.id || d.inboundMessageId || "") === messageId || String(d.idempotencyKey || "") === String(record?.idempotencyKey || "");
	});
	const timeline = messageStageList(st, messageId);
	const seen = new Set(timeline.stages.map((s: AuditTimelineStage) => `${s.stage}:${s.ts}:${s.source}`));
	const push = (stage: string, ts: string, source: "record" | "trace", detail?: string) => {
		const key = `${stage}:${ts}:${source}`;
		if (!seen.has(key)) {
			seen.add(key);
			timeline.stages.push({ stage, ts, source, detail });
		}
	};
	for (const ev of traceEvents) {
		const d = ev.detail || ev;
		const eventName = String(d.event || "");
		if (eventName === "message.enqueue") push("enqueue", d.ts || ev.ts, "trace", d.id);
		if (eventName === "message.mailbox_only") push("mailbox_delivered", d.ts || ev.ts, "trace", d.reason || d.id);
		if (eventName.startsWith("message.deliver")) push("mailbox_delivered", d.ts || ev.ts, "trace", d.reason || d.outcome);
		if (eventName === "message.inject.probe" || eventName === "message.inject.ok") push("injected", d.ts || ev.ts, "trace", d.outcome || d.reason);
		if (eventName === "message.input_intercept") push("intercepted", d.ts || ev.ts, "trace", d.status);
		if (eventName === "message.ack") push("acked", d.ts || ev.ts, "trace", d.status);
		if (eventName === "message.response.sent") push("response_sent", d.ts || ev.ts, "trace", d.proposal || d.advisory ? "advisory" : undefined);
		if (eventName === "message.response.verified") push("response_verified", d.ts || ev.ts, "trace", d.proposal || d.advisory ? "advisory" : undefined);
		if (eventName === "message.response.waived") push("response_waived", d.ts || ev.ts, "trace", d.by || d.waivedBy);
		if (eventName === "message.superseded") push("superseded", d.ts || ev.ts, "trace", d.supersededBy);
		if (eventName.startsWith("message.interrupt_")) push(eventName, d.ts || ev.ts, "trace", d.error || d.outcome);
	}
	timeline.stages.sort((a, b) => a.ts.localeCompare(b.ts));
	return { schema: "swarm-audit/v1", generatedAt: new Date().toISOString(), mode: "timeline", filters: { ...opts, messageId }, source: { file: p.events, bytesScanned: 0, generationsIncluded: opts.generations !== false }, durationMs: Date.now() - started, counts: { stages: timeline.stages.length, gaps: timeline.gaps.length }, timeline };
}

export async function checkInvariants(p: Paths, st: SwarmState) {
	const started = Date.now();
	const nowMs = Date.now();
	const ttlMs = Number(process.env.PI_SWARM_AUDIT_MESSAGE_TTL_MS) > 0 ? Number(process.env.PI_SWARM_AUDIT_MESSAGE_TTL_MS) : 30 * 60 * 1000;
	const violations: any[] = [];
	for (const rec of Object.values(st.messages || {}) as any[]) {
		const terminal = rec.status === "dead_letter" || rec.status === "superseded" || (rec.status === "acked" && rec.lastAck?.status === "done") || ["sent", "verified", "waived", "not_required"].includes(rec.response?.status);
		if (!terminal) {
			const age = nowMs - Date.parse(rec.createdAt || 0);
			if (age > ttlMs) violations.push({ invariant: "INV1", violated: true, evidence: [`message ${rec.id} status=${rec.status} ageMs=${age}`] });
		}
	}
	const taskIds = new Set<string>(Object.keys((st as any).tasks || {}));
	for (const entry of await readdir(p.tasksDir).catch(() => [])) taskIds.add(entry);
	for (const taskId of taskIds) {
		const file = join(p.tasksDir, taskId, "task.json");
		let task: any = (st as any).tasks?.[taskId];
		if (!task && existsSync(file)) {
			try { task = JSON.parse(await readFile(file, "utf8")); } catch { task = undefined; }
		}
		if (!task) continue;
		for (const [gateId, gate] of Object.entries(task.gates || {})) {
			if ((gate as any)?.status !== "waived") continue;
			const hasTaskProvenance = Boolean((gate as any)?.by || (gate as any)?.artifact);
			const hasMessageWaive = Object.values((st as any).messages || {}).some((rec: any) => (rec.taskId === taskId || String(rec.conversationId || "").includes(taskId)) && rec.response?.status === "waived" && rec.response?.waivedAt && rec.response?.waivedBy);
			if (!hasTaskProvenance && !hasMessageWaive) violations.push({ invariant: "INV2", violated: true, evidence: [`task ${taskId} gate ${gateId} waived without provenance`] });
		}
		if (task.status === "done") {
			const evidence = readCommitEvidence(task as any);
			if (!evidence || evidence.status === "unverified") violations.push({ invariant: "INV3", violated: true, evidence: [`task ${taskId} done without verified commit evidence`] });
		}
	}
	return { schema: "swarm-audit/v1", generatedAt: new Date().toISOString(), mode: "invariants", counts: { violations: violations.length }, durationMs: Date.now() - started, invariants: violations.length ? violations : [{ invariant: "INV1", violated: false, evidence: [] }, { invariant: "INV2", violated: false, evidence: [] }, { invariant: "INV3", violated: false, evidence: [] }] };
}

function pruneTmuxCaptures(p: Paths, retentionMs: number) {
	return readdir(p.tmuxTraces).then(async (files) => {
		let pruned = 0;
		for (const name of files) {
			const full = join(p.tmuxTraces, name);
			try {
				if (Date.now() - statSync(full).mtimeMs > retentionMs) {
					await rm(full, { force: true });
					pruned++;
				}
			} catch {}
		}
		return pruned;
	}).catch(() => 0);
}

export async function maybeRotateTraces(p: Paths, opts: { retentionMs?: number; keepGenerations?: number; rotateBytes?: number } = {}) {
	const rotateBytes = opts.rotateBytes ?? DEFAULT_TRACE_ROTATE_BYTES;
	const retentionMs = opts.retentionMs ?? DEFAULT_TRACE_RETENTION_MS;
	const keepGenerations = opts.keepGenerations ?? DEFAULT_TRACE_KEEP_GENERATIONS;
	if (!existsSync(p.events)) return { rotated: false, reason: "missing" };
	const size = statSync(p.events).size;
	if (size < rotateBytes) return { rotated: false, reason: "below_cap", size };
	const started = Date.now();
	await mkdir(p.traces, { recursive: true });
	const tmp = join(p.traces, "events.rotate.tmp");
	await rename(p.events, tmp);
	const existing = (await readdir(p.traces).catch(() => [])).filter((n) => /^events\.(\d+)\.gz$/.test(n)).map((n) => Number(n.match(/^(?:events\.)?(\d+)\.gz$/)?.[1] || 0)).sort((a, b) => a - b);
	const nextGen = (existing.at(-1) || 0) + 1;
	const outFile = join(p.traces, `events.${nextGen}.gz`);
	let bytesIn = 0;
	let lines = 0;
	let droppedByAge = 0;
	let oldestRetainedAt: string | undefined;
	let newestAt: string | undefined;
	const retained: string[] = [];
	const rl = createInterface({ input: createReadStream(tmp, { encoding: "utf8" }), crlfDelay: Infinity });
	for await (const line of rl) {
		if (!line.trim()) continue;
		bytesIn += Buffer.byteLength(line) + 1;
		lines++;
		let rec: any;
		try { rec = JSON.parse(line); } catch { continue; }
		const ts = Date.parse(rec.ts || 0);
		if (Number.isFinite(ts)) {
			oldestRetainedAt = oldestRetainedAt ? (oldestRetainedAt < rec.ts ? oldestRetainedAt : rec.ts) : rec.ts;
			newestAt = newestAt ? (newestAt > rec.ts ? newestAt : rec.ts) : rec.ts;
		}
		if (Number.isFinite(ts) && Date.now() - ts > retentionMs) {
			droppedByAge++;
			continue;
		}
		retained.push(`${JSON.stringify(rec)}\n`);
	}
	await pipeline(Readable.from(retained), createGzip(), createWriteStream(outFile));
	await rm(tmp, { force: true });
	const bytesOut = statSync(outFile).size;
	let rollup: any = { generatedAt: new Date().toISOString(), generations: [], retentionMs, keepGenerations };
	if (existsSync(join(p.traces, "events.rollup.json"))) {
		try {
			const previous = JSON.parse(await readFile(join(p.traces, "events.rollup.json"), "utf8"));
			if (previous && typeof previous === "object") {
				rollup = {
					...previous,
					generatedAt: new Date().toISOString(),
					retentionMs,
					keepGenerations,
					generations: Array.isArray(previous.generations) ? [...previous.generations] : [],
				};
			}
		} catch {}
	}
	rollup.generations.push({ file: outFile, bytesIn, bytesOut, lines, droppedByAge, oldestRetainedAt, newestAt, rotatedAt: new Date().toISOString() });
	rollup.generations = rollup.generations.slice(-keepGenerations);
	await writeFile(join(p.traces, "events.rollup.json"), JSON.stringify(rollup, null, 2) + "\n", "utf8");
	for (const old of existing.slice(0, Math.max(0, existing.length - keepGenerations))) {
		try { await rm(join(p.traces, `events.${old}.gz`), { force: true }); } catch {}
	}
	const pruned = await pruneTmuxCaptures(p, retentionMs);
	if (pruned) await trace(p, "trace.retention.tmux_pruned", { count: pruned, retentionMs }).catch(() => {});
	await trace(p, "trace.retention.rotated", { bytesIn, bytesOut, generations: nextGen, droppedByAge, oldestRetainedAt, durationMs: Date.now() - started }).catch(() => {});
	return { rotated: true, bytesIn, bytesOut, generations: nextGen, droppedByAge };
}

export function registerAuditTools(pi: ExtensionAPI) {
	pi.registerTool(defineTool({
		name: "swarm_audit",
		label: "Swarm Audit",
		description: "Read-only swarm trace audit: bounded event scanning, message timelines, anomaly probes, invariant checks, and trace rotation.",
		parameters: Type.Object({
			mode: Type.Optional(Type.String({ description: "events | timeline | probes | invariants | all | rotate" })),
			event: Type.Optional(Type.String()),
			since: Type.Optional(Type.Union([Type.String(), Type.Number()])),
			until: Type.Optional(Type.Union([Type.String(), Type.Number()])),
			agent: Type.Optional(Type.String()),
			task: Type.Optional(Type.String()),
			cid: Type.Optional(Type.String()),
			messageId: Type.Optional(Type.String()),
			limit: Type.Optional(Type.Number()),
			rollupWindowMs: Type.Optional(Type.Number()),
			generations: Type.Optional(Type.Boolean()),
			json: Type.Optional(Type.Boolean()),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return wrapSwarmToolInvocation(pi, ctx.cwd, "swarm_audit", async () => {
				const p = paths(ctx.cwd);
				const st = await readState(p, ctx.cwd);
				const mode = String(params.mode || "events");
				if (mode === "rotate") {
					const res = await maybeRotateTraces(p, {});
					return textResult(params.json ? JSON.stringify(res, null, 2) : JSON.stringify(res, null, 2), res);
				}
				const filters: AuditEventFilter = { event: params.event, since: params.since, until: params.until, agent: params.agent, task: params.task, cid: params.cid, limit: params.limit };
				if (mode === "timeline") {
					const res = await auditTimeline(p, String(params.messageId || ""), { ...filters, generations: params.generations !== false });
					return textResult(params.json ? JSON.stringify(res, null, 2) : JSON.stringify(res.timeline, null, 2), res);
				}
				if (mode === "probes") {
					const eventsRes = await readAuditEvents(p, { ...filters, generations: params.generations !== false, rollupWindowMs: params.rollupWindowMs });
					const probes = { P1: probeP1(st), P2: probeP2(st), P3: probeP3(eventsRes.events || []), P4: probeP4(eventsRes.events || []) };
					const out = { ...eventsRes, mode: "probes", probes };
					return textResult(JSON.stringify(out, null, 2), out);
				}
				if (mode === "invariants") {
					const res = await checkInvariants(p, st);
					return textResult(JSON.stringify(res, null, 2), res);
				}
				if (mode === "all") {
					const eventsRes = await readAuditEvents(p, { ...filters, generations: params.generations !== false, rollupWindowMs: params.rollupWindowMs });
					const payload = { ...eventsRes, timeline: params.messageId ? (await auditTimeline(p, String(params.messageId), { generations: params.generations !== false })).timeline : undefined, probes: { P1: probeP1(st), P2: probeP2(st), P3: probeP3(eventsRes.events || []), P4: probeP4(eventsRes.events || []) }, invariants: await checkInvariants(p, st) };
					return textResult(JSON.stringify(payload, null, 2), payload);
				}
				const res = await readAuditEvents(p, { ...filters, generations: params.generations !== false, rollupWindowMs: params.rollupWindowMs });
				return textResult(JSON.stringify(res, null, 2), res);
			});
		},
	}));
}

export const __test = { eventMatches, probeP1, probeP2, probeP3, probeP4, rollupEvents, messageStageList };
