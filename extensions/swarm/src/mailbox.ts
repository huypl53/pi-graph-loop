// === swarm/mailbox.ts — auto-extracted from index.ts (verbatim bodies) ===
import { defineTool, CONFIG_DIR_NAME, truncateHead, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, writeFile, appendFile, rm, stat, rename, readdir, realpath, open } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import type { MessageRecord, MessageResponseStatus, MessageStatus, Paths, SwarmMessage, SwarmState, TaskState } from "./types.ts";
import { SEND_SETTLE_MS, MAX_REINJECTS } from "./constants.ts";
import { appendJsonl, mailboxPath, readState, trace, withLock, writeState } from "./state.ts";
import { buildSystemDelivery } from "./delivery.ts";
import { capturePane, isPanePiLike, sendToPane, tmux } from "./tmux.ts";
import { currentAgentId, currentModel, currentProvider } from "./session.ts";
import { ensureOrchestrator } from "./identity.ts";
import { now, safeId, sleep } from "./utils.ts";
import { pumpOrchestratorMailbox, reconcile } from "./reconcile.ts";

export function upsertMessageRecord(state: SwarmState, msg: SwarmMessage, status: MessageStatus, patch: Partial<MessageRecord> = {}) {
	const ts = now();
	const prev = state.messages[msg.id];
	const requiresResponse = msg.requiresResponse ?? prev?.requiresResponse ?? false;
	const response = patch.response || prev?.response || (requiresResponse
		? { status: "missing" as MessageResponseStatus, missingAt: ts }
		: { status: "not_required" as MessageResponseStatus });
	state.messages[msg.id] = {
		id: msg.id,
		from: msg.from,
		to: msg.to,
		createdAt: prev?.createdAt || msg.createdAt,
		queuedAt: prev?.queuedAt,
		attempts: prev?.attempts ?? 0,
		requiresAck: msg.requiresAck,
		requiresResponse,
		response,
		conversationId: msg.conversationId,
		replyTo: msg.replyTo,
		lastError: prev?.lastError,
		lastAck: prev?.lastAck,
		ttlMs: msg.ttlMs,
		idempotencyKey: msg.idempotencyKey,
		...prev,
		...patch,
		status,
		updatedAt: ts,
	};
}

export function isResponseTrackingActive(rec: Pick<MessageRecord, "status" | "lastAck" | "requiresResponse">) {
	return rec.requiresResponse && rec.status !== "dead_letter" && rec.status !== "queued" && (rec.status !== "failed" || Boolean(rec.lastAck));
}

export function responseMissingRecords(st: SwarmState, agentId: string) {
	return Object.values(st.messages || {}).filter((m) =>
		m.to === agentId &&
		isResponseTrackingActive(m) &&
		m.response?.status !== "verified" &&
		m.response?.status !== "waived"
	);
}

export function verifiedResponseCount(st: SwarmState, agentId: string) {
	return Object.values(st.messages || {}).filter((m) => m.to === agentId && m.requiresResponse && m.response?.status === "verified").length;
}

export function validateResultMessage(st: SwarmState, rec: MessageRecord, resultMessageId: string, agentId: string) {
	const result = st.messages[resultMessageId];
	if (!result) throw new Error(`INVALID_RESULT_MESSAGE: resultMessageId ${resultMessageId} does not exist in swarm state.`);
	if (result.from !== agentId) throw new Error(`INVALID_RESULT_MESSAGE: result ${resultMessageId} was sent by ${result.from}, not ${agentId}.`);
	if (result.to !== rec.from) throw new Error(`INVALID_RESULT_MESSAGE: result ${resultMessageId} is addressed to ${result.to}, expected original sender ${rec.from}.`);
	const linked = result.replyTo === rec.id || (Boolean(result.conversationId) && result.conversationId === rec.conversationId);
	if (!linked) throw new Error(`INVALID_RESULT_MESSAGE: result ${resultMessageId} must replyTo ${rec.id} or share conversationId ${rec.conversationId || "(none)"}.`);
	return result;
}

// O(1) idempotency lookup (issue C): returns the existing record for from+to+key, using + lazily
// building a state-level index instead of an O(M) scan inside the lock. The index is rebuilt whenever
// the message count changed since it was last built (cheap single pass amortized across lookups).
export function findIdempotentMessage(st: SwarmState, from: string, to: string, key: string): MessageRecord | undefined {
	const count = Object.keys(st.messages || {}).length;
	let index = st.idempotencyIndex;
	if (!index || st.idempotencyIndexCount !== count) {
		index = {};
		for (const rec of Object.values(st.messages || {})) {
			if (rec.idempotencyKey) index[`${rec.from}\u0000${rec.to}\u0000${rec.idempotencyKey}`] = rec.id;
		}
		st.idempotencyIndex = index;
		st.idempotencyIndexCount = count;
	}
	const id = index[`${from}\u0000${to}\u0000${key}`];
	if (!id) return undefined;
	const rec = st.messages[id];
	// Guard against staleness: if the indexed id no longer resolves, rebuild once.
	if (!rec) {
		delete index[`${from}\u0000${to}\u0000${key}`];
		return undefined;
	}
	return rec;
}

// Incremental mailbox read (issue B): parse only lines appended since the byte `offset`, avoiding a
// full-file parse per pump tick on unbounded orchestrator mailboxes. Falls back to a full read (and
// returns its length) when the file shrank or no checkpoint exists. Returns the parsed messages and
// the new offset to persist as the checkpoint.
export async function readMailboxSince(p: Paths, agentId: string, offset: number, maxLines = 500): Promise<{ messages: SwarmMessage[]; offset: number; truncated: boolean }> {
	const file = mailboxPath(p, agentId);
	if (!existsSync(file)) return { messages: [], offset: 0, truncated: false };
	let size = 0;
	try { size = (await stat(file)).size; } catch { return { messages: [], offset: 0, truncated: false }; }
	if (size < offset || offset <= 0) {
		// No/shrunk checkpoint: full read, bounded to the last maxLines lines.
		const all = await readMailbox(p, agentId);
		const keep = all.length > maxLines ? all.slice(all.length - maxLines) : all;
		return { messages: keep, offset: size, truncated: all.length > keep.length };
	}
	if (size === offset) return { messages: [], offset, truncated: false };
	const fd = await open(file, "r");
	try {
		const buf = Buffer.alloc(size - offset);
		await fd.read(buf, 0, buf.length, offset);
		let text = buf.toString("utf8");
		// A trailing partial line (writer mid-append) is left for the next tick: only parse complete lines.
		let complete = size;
		if (!text.endsWith("\n")) {
			const lastNl = text.lastIndexOf("\n");
			if (lastNl < 0) return { messages: [], offset, truncated: false };
			text = text.slice(0, lastNl + 1);
			complete = offset + lastNl + 1;
		}
		const out: SwarmMessage[] = [];
		let bad = 0;
		for (const line of text.split("\n").filter(Boolean)) {
			try { out.push(JSON.parse(line) as SwarmMessage); } catch { bad++; }
		}
		if (bad) await trace(p, "mailbox.corrupt_lines_ignored", { agentId, file, bad, incremental: true }).catch(() => {});
		// Bound the parse per tick (protects a huge single append between ticks).
		const truncated = out.length > maxLines;
		const keep = truncated ? out.slice(out.length - maxLines) : out;
		return { messages: keep, offset: truncated ? size : complete, truncated };
	} finally {
		await fd.close();
	}
}

// Stat-gated mailbox read (issue B): the orchestrator pump ticks every ~5s; re-parsing the whole
// (unbounded) mailbox JSONL each tick is pure waste when nothing was appended. Cache the last full
// parse per file identity (size + mtime) in-process and re-read only when the file changed. Semantics
// are IDENTICAL to readMailbox — same messages, same order — so the pump's window/retrigger logic
// (which needs the historical tail) is unchanged.
const mailboxReadCache = new Map<string, { size: number; mtimeMs: number; msgs: SwarmMessage[] }>();
export async function readMailboxCached(p: Paths, agentId: string): Promise<SwarmMessage[]> {
	const file = mailboxPath(p, agentId);
	if (!existsSync(file)) return [];
	let s: { size: number; mtimeMs: number };
	try { s = await stat(file); } catch { return readMailbox(p, agentId); }
	const hit = mailboxReadCache.get(file);
	if (hit && hit.size === s.size && hit.mtimeMs === s.mtimeMs) return hit.msgs;
	const msgs = await readMailbox(p, agentId);
	mailboxReadCache.set(file, { size: s.size, mtimeMs: s.mtimeMs, msgs });
	return msgs;
}

export async function readMailbox(p: Paths, agentId: string): Promise<SwarmMessage[]> {
	const file = mailboxPath(p, agentId);
	if (!existsSync(file)) return [];
	const raw = await readFile(file, "utf8");
	const out: SwarmMessage[] = [];
	let bad = 0;
	let firstBadLine = 0;
	for (const [idx, line] of raw.split(/\n+/).filter(Boolean).entries()) {
		try {
			out.push(JSON.parse(line) as SwarmMessage);
		} catch {
			bad++;
			if (!firstBadLine) firstBadLine = idx + 1;
		}
	}
	if (bad) await trace(p, "mailbox.corrupt_lines_ignored", { agentId, file, bad, firstBadLine });
	return out;
}

function buildInjectionProbe(state: SwarmState, msg: SwarmMessage, outcome: "success" | "failure", attempts: number, reinjects: number) {
	const related = Object.values(state.messages || {}).filter((rec) => rec.to === msg.to && rec.id !== msg.id);
	const successes = related.filter((rec) => rec.status === "injected" || rec.status === "mailbox_delivered" || rec.status === "intercepted").length;
	const failures = related.filter((rec) => rec.status === "failed" && !rec.lastAck).length;
	const total = successes + failures + 1;
	const failureRate = Number(((failures + (outcome === "failure" ? 1 : 0)) / total).toFixed(3));
	const successRate = Number(((successes + (outcome === "success" ? 1 : 0)) / total).toFixed(3));
	return { attempt: attempts, reinjects, retryBudget: MAX_REINJECTS, outcome, successes, failures, failureRate, successRate };
}

export async function deliver(pi: ExtensionAPI, p: Paths, state: SwarmState, msg: SwarmMessage) {
	const agent = state.agents[msg.to];
	if (!agent) {
		await trace(p, "message.inject.probe", { id: msg.id, to: msg.to, outcome: "failure", reason: "unknown agent", probe: buildInjectionProbe(state, msg, "failure", (state.messages[msg.id]?.attempts || 0) + 1, state.messages[msg.id]?.reinjects || 0) });
		return { delivered: false, reason: "unknown agent" };
	}
	// Mailbox-only recipients (e.g. the orchestrator pseudo-agent) have no swarm tmux pane. The
	// message is already persisted in the mailbox; treat this as successful mailbox delivery, not
	// a tmux injection failure. The recipient surfaces it via the orchestrator auto-pump
	// (pumpOrchestratorMailbox, on session_start/agent_settled/interval) or swarm_check_mailbox;
	// callers must NOT pre-mark it delivered (see deliverMessageLocked) so the pump can surface it.
	if (!agent.tmuxTarget || agent.tmuxTarget === "unknown") {
		await trace(p, "message.inject.probe", { id: msg.id, to: msg.to, outcome: "success", reason: "mailbox-only", probe: buildInjectionProbe(state, msg, "success", (state.messages[msg.id]?.attempts || 0) + 1, state.messages[msg.id]?.reinjects || 0) });
		return { delivered: true, mailboxOnly: true, reason: "recipient has no tmux pane (mailbox-only)" };
	}
	if (agent.status !== "running") {
		await trace(p, "message.inject.probe", { id: msg.id, to: msg.to, outcome: "failure", reason: "target agent not running", probe: buildInjectionProbe(state, msg, "failure", (state.messages[msg.id]?.attempts || 0) + 1, state.messages[msg.id]?.reinjects || 0) });
		return { delivered: false, reason: "target agent not running" };
	}
	// Issue D: a live pane that is NOT running pi (e.g. the shell after a crash/exit) must not be marked
	// delivered — send-keys would just type the base64 line into a dead prompt. Keep it retryable
	// ({delivered:false}) so reconcile re-injects once real pi is back, and use panePiLike for re-inject
	// eligibility too. Fail-open on unknown commands (see isPanePiLike).
	const panePi = await isPanePiLike(pi, agent.tmuxTarget);
	if (!panePi.piLike) {
		await trace(p, "message.inject.probe", { id: msg.id, to: msg.to, outcome: "failure", reason: `pane alive but not running pi (pane_current_command=${panePi.command || "?"})`, probe: buildInjectionProbe(state, msg, "failure", (state.messages[msg.id]?.attempts || 0) + 1, state.messages[msg.id]?.reinjects || 0) });
		return { delivered: false, reason: `pane alive but not running pi (pane_current_command=${panePi.command || "?"})` };
	}
	const before = await capturePane(pi, p, msg.to, agent.tmuxTarget, `deliver-${msg.id}-before`);
	await sendToPane(pi, agent.tmuxTarget, buildSystemDelivery(msg));
	await sleep(SEND_SETTLE_MS);
	const after = await capturePane(pi, p, msg.to, agent.tmuxTarget, `deliver-${msg.id}-after`);
	await trace(p, "message.inject.probe", { id: msg.id, to: msg.to, outcome: "success", reason: "tmux send-keys succeeded", probe: buildInjectionProbe(state, msg, "success", (state.messages[msg.id]?.attempts || 0) + 1, state.messages[msg.id]?.reinjects || 0) });
	return { delivered: true, mailboxOnly: false, before, after };
}

// Lock-free core of message enqueue+deliver. Mutates the passed-in `st` (message record, delivered[],
// orchestrator pseudo-agent) and appends to the recipient mailbox; it does NOT read/write state or
// acquire the lock. Callers that already hold the swarm lock (task tools that send within one atomic
// operation) use this directly and writeState once afterward.
export async function deliverMessageLocked(pi: ExtensionAPI, cwd: string, p: Paths, st: SwarmState, params: { to: string; body: string; subject?: string; priority?: string; conversationId?: string; replyTo?: string; requiresAck?: boolean; requiresResponse?: boolean; ttlMs?: number; idempotencyKey?: string }): Promise<{ msg: SwarmMessage; delivery: any }> {
	const to = safeId(params.to);
	const from = currentAgentId();
	if (to === "orchestrator") ensureOrchestrator(st, cwd, p);
	if (!st.agents[to]) throw new Error(`Unknown swarm agent: ${to}`);

	// Idempotency check: if from+to+idempotencyKey already exists, return existing message
	if (params.idempotencyKey) {
		const existing = findIdempotentMessage(st, from, to, params.idempotencyKey);
		if (existing) {
			const original = (await readMailbox(p, to)).find((m) => m.id === existing.id);
			if (!original) throw new Error(`Idempotency record ${existing.id} exists but mailbox entry is missing for ${to}`);
			await trace(p, "message.idempotent_reuse", { id: existing.id, from, to, idempotencyKey: params.idempotencyKey, status: existing.status });
			return { msg: original, delivery: { reused: true, delivered: existing.status === "injected" || existing.status === "intercepted" || existing.status === "acked", status: existing.status } };
		}
	}

	const createdAt = now();
	const m: SwarmMessage = {
		id: `msg-${Date.now()}-${randomUUID().slice(0, 8)}`,
		swarmId: st.swarmId,
		from,
		to,
		subject: params.subject,
		priority: params.priority || "normal",
		type: "swarm.message",
		schemaVersion: 1,
		createdAt,
		body: params.body,
		conversationId: params.conversationId,
		replyTo: params.replyTo,
		requiresAck: params.requiresAck ?? true,
		requiresResponse: params.requiresResponse ?? false,
		ttlMs: params.ttlMs,
		idempotencyKey: params.idempotencyKey,
		headers: { cwd, senderModel: currentModel(), senderProvider: currentProvider() },
	};
	upsertMessageRecord(st, m, "queued", { queuedAt: createdAt });
	await appendJsonl(mailboxPath(p, to), m);
	await trace(p, "message.enqueue", { id: m.id, from: m.from, to: m.to, subject: m.subject, priority: m.priority, conversationId: m.conversationId, replyTo: m.replyTo, requiresAck: m.requiresAck, requiresResponse: m.requiresResponse, idempotencyKey: m.idempotencyKey });
	const delivery = await deliver(pi, p, st, m);
	if (delivery?.delivered) {
		if (delivery.mailboxOnly) {
			// Mailbox-only delivery (e.g. the orchestrator has no swarm tmux pane): the message is safely
			// appended to the recipient mailbox. Do NOT pre-mark it in st.delivered[to] — that set is the
			// shared dedup/surfaced ledger, and pre-marking here would defeat the orchestrator auto-pump
			// (pumpOrchestratorMailbox) and swarm_check_mailbox(pendingOnly), which surface messages NOT yet
			// in the set. The surfacing pump / check_mailbox add to the set themselves when they surface.
			// Message lifecycle is tracked by status "mailbox_delivered" (kept off "queued"/"failed" so it is
			// not mistaken for a tmux injection failure).
			upsertMessageRecord(st, m, "mailbox_delivered", { lastError: undefined });
			await trace(p, "message.mailbox_only", { id: m.id, to: m.to, reason: delivery.reason });
		} else {
			// Injection into the recipient pane is already delivery. Mark it in state atomically with
			// enqueue+inject so pending mailbox polling does not reprocess the same message after a restart
			// or delayed poll.
			st.delivered[to] = Array.from(new Set([...(st.delivered[to] || []), m.id]));
			upsertMessageRecord(st, m, "injected", { injectedAt: now(), attempts: (st.messages[m.id]?.attempts || 0) + 1 });
		}
	} else {
		upsertMessageRecord(st, m, "failed", { failedAt: now(), attempts: (st.messages[m.id]?.attempts || 0) + 1, lastError: delivery?.reason || "delivery skipped" });
	}
	if (params.replyTo) {
		const original = st.messages[params.replyTo];
		if (original?.requiresResponse && original.to === from && original.from === to) {
			original.response = { ...(original.response || { status: "missing" as MessageResponseStatus }), status: "sent", resultMessageId: m.id, sentAt: now(), lastError: undefined };
			original.updatedAt = now();
			await trace(p, "message.response.sent", { id: original.id, resultMessageId: m.id, from, to });
		}
	}
	await trace(p, delivery?.delivered ? (delivery.mailboxOnly ? "message.deliver.mailbox_only" : "message.inject.ok") : "message.inject.skip", { id: m.id, to: m.to, delivery, markedDelivered: Boolean(delivery?.delivered), status: st.messages[m.id]?.status });
	// Orphan-spawn watchdog clear (Issue 14, B1 binding §2.2 + §2.3 collapse into one site here):
	// any successful inbound delivery (tmux-injected OR mailbox-only) is sufficient to resolve the
	// orphan — the agent now has a contractually visible message. A failed delivery does NOT clear
	// the watch (we still want to warn if the spawn was orphaned). This covers BOTH
	// swarm_send_message and swarm_assign_task (which calls deliverMessageLocked internally with
	// the assignment message), so no edit to tools/tasks.ts is required. clearOrphanWatch is
	// best-effort and idempotent. Dynamic import avoids a circular top-level import with
	// agents.ts (agents.ts -> mailbox.ts for responseMissingRecords; mailbox.ts -> agents.ts for
	// clearOrphanWatch only inside this code path). The function is small and Node ESM caches the
	// resolution, so the per-call overhead is negligible.
	if (delivery?.delivered) {
		try {
			const { clearOrphanWatch } = await import("./agents.ts");
			await clearOrphanWatch(p, st, m.to, "swarm_send_message");
		} catch { /* best-effort; never fail delivery on a watchdog bookkeeping error */ }
	}
	return { msg: m, delivery };
}

export async function enqueueAndDeliver(pi: ExtensionAPI, cwd: string, p: Paths, params: { to: string; body: string; subject?: string; priority?: string; conversationId?: string; replyTo?: string; requiresAck?: boolean; requiresResponse?: boolean; ttlMs?: number; idempotencyKey?: string }) {
	return withLock(p, async () => {
		const st = await readState(p, cwd);
		const r = await deliverMessageLocked(pi, cwd, p, st, params);
		await writeState(p, st);
		return r;
	});
}

// Mark prior OPEN assignment messages for a task/node as superseded + waived so a newer assignment
// (e.g. after stale-status repair / reassign) does not leave duplicate requiresResponse messages
// that nag response_missing or block reuse. Best-effort: never throws (assignment must still succeed).
// Source of prior ids: task.handoffs (kind="assign", toNode) — not conversationId substrings.
export async function supersedeOpenAssignments(p: Paths, st: SwarmState, task: TaskState, nodeId: string, newMsgId: string, by: string): Promise<string[]> {
	const supersededIds: string[] = [];
	try {
		const priorIds = (task.handoffs || [])
			.filter((h) => (h as Record<string, unknown>).toNode === nodeId && (h as Record<string, unknown>).kind === "assign")
			.map((h) => (h as Record<string, unknown>).messageId as string)
			.filter((mid): mid is string => Boolean(mid) && mid !== newMsgId);
		const seen = new Set<string>();
		for (const mid of new Set(priorIds)) {
			if (seen.has(mid)) continue;
			seen.add(mid);
			const rec = st.messages[mid];
			if (!rec) continue;
			// Open predicate: not already failed/dead, not completed (acked done), not already superseded.
			if (rec.status === "failed" || rec.status === "dead_letter") continue;
			if (rec.lastAck?.status === "done") continue;
			if (rec.superseded) continue;
			const ts = now();
			rec.superseded = { at: ts, by, supersededBy: newMsgId };
			// waived response excludes this message from the existing reconcile response_missing block
			// (response?.status !== "waived") and from responseMissingRecords() — no new reconcile code needed.
			rec.response = { ...(rec.response || { status: "missing" as MessageResponseStatus }), status: "waived" as MessageResponseStatus, waivedAt: ts, waivedBy: by, lastError: undefined };
			rec.updatedAt = ts;
			supersededIds.push(mid);
			await trace(p, "message.superseded", { id: mid, supersededBy: newMsgId, taskId: task.taskId, nodeId });
		}
		// If waiving cleared the assignee's last response_missing cause, unstick its runtime status.
		const assigneeId = task.nodes[nodeId]?.assignee;
		const agent = assigneeId ? st.agents[assigneeId] : undefined;
		if (agent && agent.runtimeStatus === "response_missing" && responseMissingRecords(st, assigneeId as string).length === 0) {
			agent.runtimeStatus = "idle";
			agent.updatedAt = now();
		}
	} catch (err) {
		await trace(p, "message.supersede_failed", { taskId: task.taskId, nodeId, newMsgId, error: String((err as Error)?.message || err) });
	}
	return supersededIds;
}

// Mark every assignment-class message related to a task as superseded (per-node assignment message
// ids from node.assignmentMessageId + handoff-assign message ids). Cancellation notices are
// informational (requiresAck:false/requiresResponse:false) so the worker cannot generate response
// debt on an obsolete assignment, but late progress ACKs are still rejected via the supersede
// guard in swarm_ack_message. Returns the count of messages that were newly superseded.
// Read-only on intent: mutates only MessageRecord.superseded fields + emits trace events; does not
// touch messages.delivered, agent.activeTaskIds (handled separately), or node state.
export async function supersedeTaskAssignmentMessages(p: Paths, st: SwarmState, task: TaskState, reason: string, by: string): Promise<{ supersededIds: string[]; skipped: number }> {
	const supersededIds: string[] = [];
	let skipped = 0;
	const ts = now();
	const trySupersede = async (mid: string | undefined, nodeId: string) => {
		if (!mid) return;
		if (mid.startsWith("__")) return; // never touch synthetic markers
		const rec = st.messages[mid];
		if (!rec) { skipped++; return; }
		if (rec.status === "failed" || rec.status === "dead_letter") { skipped++; return; }
		if (rec.superseded) { skipped++; return; }
		rec.superseded = { at: ts, by, supersededBy: reason };
		rec.response = { ...(rec.response || { status: "missing" as MessageResponseStatus }), status: "waived" as MessageResponseStatus, waivedAt: ts, waivedBy: by, lastError: undefined };
		rec.updatedAt = ts;
		supersededIds.push(mid);
		await trace(p, "message.superseded", { id: mid, supersededBy: reason, taskId: task.taskId, nodeId, by });
	};
	// 1. Current assignment message ids on every node (canonical, set by swarm_assign_task).
	for (const [nodeId, node] of Object.entries(task.nodes)) {
		await trySupersede(node.assignmentMessageId, nodeId);
	}
	// 2. Historical assignment handoffs. `task.handoffs` is scoped to this task by construction
	//    (only swarm_assign_task and swarm_task_message push to it, both keyed by taskId in the
	//    message envelope), and historical assign entries do NOT carry `taskId` on the handoff row
	//    itself — so we scope by membership in this task's `nodes` rather than by a handoff-row
	//    taskId predicate. Superseding a prior assignment for the SAME task by construction is
	//    exactly the right behavior; cancellation must supersede every historical assign handoff
	//    for this task, not just the most-recent node.assignmentMessageId. This matches the
	//    per-node behavior of supersedeOpenAssignments.
	const nodeIds = new Set(Object.keys(task.nodes));
	for (const h of task.handoffs || []) {
		const rec = h as Record<string, unknown>;
		if (rec.kind !== "assign") continue;
		const messageId = typeof rec.messageId === "string" ? rec.messageId : undefined;
		if (!messageId) continue;
		const toNode = typeof rec.toNode === "string" && nodeIds.has(rec.toNode) ? rec.toNode : "(historical)";
		await trySupersede(messageId, toNode);
	}
	return { supersededIds, skipped };
}
