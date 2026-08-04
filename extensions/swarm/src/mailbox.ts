// === swarm/mailbox.ts — auto-extracted from index.ts (verbatim bodies) ===
import { defineTool, CONFIG_DIR_NAME, truncateHead, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, writeFile, appendFile, rm, stat, rename, readdir, realpath } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import type { MessageRecord, MessageResponseStatus, MessageStatus, Paths, SwarmMessage, SwarmState, TaskState } from "./types.ts";
import { SEND_SETTLE_MS } from "./constants.ts";
import { appendJsonl, mailboxPath, readState, trace, withLock, writeState } from "./state.ts";
import { buildSystemDelivery } from "./delivery.ts";
import { capturePane, sendToPane, tmux } from "./tmux.ts";
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

export function responseMissingRecords(st: SwarmState, agentId: string) {
	return Object.values(st.messages || {}).filter((m) =>
		m.to === agentId &&
		m.requiresResponse &&
		m.status !== "dead_letter" &&
		m.status !== "failed" &&
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

export async function readMailbox(p: Paths, agentId: string): Promise<SwarmMessage[]> {
	const file = mailboxPath(p, agentId);
	if (!existsSync(file)) return [];
	const raw = await readFile(file, "utf8");
	return raw.split(/\n+/).filter(Boolean).map((line) => JSON.parse(line));
}

export async function deliver(pi: ExtensionAPI, p: Paths, state: SwarmState, msg: SwarmMessage) {
	const agent = state.agents[msg.to];
	if (!agent) return { delivered: false, reason: "unknown agent" };
	// Mailbox-only recipients (e.g. the orchestrator pseudo-agent) have no swarm tmux pane. The
	// message is already persisted in the mailbox; treat this as successful mailbox delivery, not
	// a tmux injection failure. The recipient surfaces it via the orchestrator auto-pump
	// (pumpOrchestratorMailbox, on session_start/agent_settled/interval) or swarm_check_mailbox;
	// callers must NOT pre-mark it delivered (see deliverMessageLocked) so the pump can surface it.
	if (!agent.tmuxTarget || agent.tmuxTarget === "unknown") {
		return { delivered: true, mailboxOnly: true, reason: "recipient has no tmux pane (mailbox-only)" };
	}
	if (agent.status !== "running") return { delivered: false, reason: "target agent not running" };
	const before = await capturePane(pi, p, msg.to, agent.tmuxTarget, `deliver-${msg.id}-before`);
	await sendToPane(pi, agent.tmuxTarget, buildSystemDelivery(msg));
	await sleep(SEND_SETTLE_MS);
	const after = await capturePane(pi, p, msg.to, agent.tmuxTarget, `deliver-${msg.id}-after`);
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
		const existing = Object.values(st.messages).find(
			(r) => r.from === from && r.to === to && r.idempotencyKey === params.idempotencyKey
		);
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
