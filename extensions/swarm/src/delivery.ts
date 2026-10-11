// === swarm/delivery.ts — auto-extracted from index.ts (verbatim bodies) ===
import { join, dirname, relative, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { SwarmMessage } from "./types/index.ts";
import { SYSTEM_END, SYSTEM_START } from "./constants.ts";
// Runtime-contract citation (retired-surface cleanup, 2026-10): the [PI-SWARM ACK REQUIRED]
// suffix below was L4 LLM-consumption content (docs/swarm/pi-runtime-contract.md §1). Its removal
// changes consumed text but adds ZERO new Pi boundary crossings (no pi.sendMessage/
// ctx.abort/ctx.reload/registerTool call sites) — no new R10-1 counter or §10 row.
import { currentAgentId } from "./session.ts";
import { logSwarmError } from "./errorlog.ts";
import { now } from "./utils.ts";

// Whether a message record is a retryable DELIVERY failure eligible for reconcile re-injection
// (and worth surfacing as "pending" in agent status). Message `status` "queued"/"failed" is
// OVERLOADED: it covers both (a) a delivery that never reached the recipient (no `lastAck` -> safe
// to re-inject once the agent is running) and (b) a message the recipient already received and
// acknowledged as failed (`lastAck` present -> terminal). The discriminator is `lastAck`: once the
// recipient has sent ANY ack (seen/processing/done/failed) the message has been delivered AND
// processed, so re-injecting it would loop — the recipient already saw it and would ack the same
// way again, escalating attempts until dead_letter. This is the fix for the ack-then-re-deliver
// loop: reconcile must only re-inject messages the recipient has NEVER acknowledged.
export function isDeliveryFailureRetryable(rec: { status: string; lastAck?: unknown }): boolean {
	return (rec.status === "queued" || rec.status === "failed") && !rec.lastAck;
}

// ---- Metric / run / memory V1 helpers (file-backed, no daemon, no vector DB) ----
// Swarm is the harness; the project defines the metric. Nothing here hard-codes accuracy/latency/cost.
// Records are append-only JSONL; memory promotion is gated on file-backed evidence that exists + reads.

export function formatSwarmMessageContent(msg: SwarmMessage) {
	// Timestamp prefix: the root can queue messages for a long time before the pump
	// surfaces them (busy deferral, back-off, restarts). Without a send-time stamp the recipient
	// cannot tell a fresh directive from one that sat in the mailbox for an hour — operators
	// repeatedly misread stale nudges as live events. Use the durable record's createdAt (fall
	// back to now for untracked deliveries) and a short local-time format that stays compact in
	// the TUI.
	const ts = new Date(msg.createdAt || Date.now());
	const stamp = `${ts.getFullYear()}-${String(ts.getMonth() + 1).padStart(2, "0")}-${String(ts.getDate()).padStart(2, "0")} ${String(ts.getHours()).padStart(2, "0")}:${String(ts.getMinutes()).padStart(2, "0")}:${String(ts.getSeconds()).padStart(2, "0")}`;
	// === gate-aware [PI-SWARM ACK REQUIRED] rendering — retired-surface cleanup (2026-10) ===
	// The manual-ack hint is removed under BOTH gates: the tool it names (swarm_ack_message) is
	// not registered, and message lifecycle is engine-derived from replies + swarm_update_task.
	// (Historical legacy: under PI_SWARM_MINIMAL_PROTOCOL=0 this used to render the full ack
	// instructions; the Phase-2/Phase-1 gating history lives in git history + minimal-protocol tests.)
	const ackLine = "";
	return `[${stamp}] Inter-agent swarm message from ${msg.from} to ${msg.to}${msg.subject ? ` (${msg.subject})` : ""}:\n\n${msg.body}${ackLine}`;
}

export function formatSwarmBatchMessageContent(msgs: SwarmMessage[]) {
	if (msgs.length === 0) return "";
	if (msgs.length === 1) return formatSwarmMessageContent(msgs[0]);

	const ts = new Date(msgs[msgs.length - 1].createdAt || Date.now());
	const stamp = `${ts.getFullYear()}-${String(ts.getMonth() + 1).padStart(2, "0")}-${String(ts.getDate()).padStart(2, "0")} ${String(ts.getHours()).padStart(2, "0")}:${String(ts.getMinutes()).padStart(2, "0")}:${String(ts.getSeconds()).padStart(2, "0")}`;

	// [PI-SWARM ACK REQUIRED] line retired (2026-10 cleanup) — engine-derived lifecycle.
	const items = msgs.map((m, idx) => {
		const prio = m.priority && m.priority !== "normal" ? ` | Priority: ${m.priority}` : "";
		const subj = m.subject ? ` (${m.subject})` : "";
		return `--- [${idx + 1}/${msgs.length}] From ${m.from} to ${m.to}${subj}${prio} [${m.id}] ---\n${m.body.trim()}`;
	});

	return `[${stamp}] Inter-agent swarm batch delivery for ${msgs[0].to} (${msgs.length} incoming messages):\n\n${items.join("\n\n")}`;
}

export function buildSystemDelivery(msg: SwarmMessage) {
	// Keep this as a single physical line: `tmux send-keys -l` does not reliably
	// preserve embedded newlines across terminal editors. Base64 prevents marker
	// collisions and keeps user-controlled message content out of the tmux input
	// stream as raw control characters.
	const payload = Buffer.from(JSON.stringify(msg), "utf8").toString("base64");
	return `${SYSTEM_START} b64:${payload} ${SYSTEM_END}`;
}

export function parseSystemDelivery(text: string): SwarmMessage | null {
	if (!text.includes(SYSTEM_START) || !text.includes(SYSTEM_END)) return null;
	const body = text.slice(text.indexOf(SYSTEM_START) + SYSTEM_START.length, text.indexOf(SYSTEM_END)).trim();
	if (body.startsWith("b64:")) {
		try {
			const msg = JSON.parse(Buffer.from(body.slice(4).trim(), "base64").toString("utf8")) as SwarmMessage;
			return {
				...msg,
				type: "swarm.message",
				schemaVersion: msg.schemaVersion || 1,
				requiresAck: msg.requiresAck ?? true,
				headers: msg.headers || {},
			};
		} catch (err) {
			// A b64 payload that fails to parse is either corruption in transit or a non-swarm
			// message that happens to contain the markers — either way the message is silently
			// DROPPED unless someone logs it. Fire-and-forget (sync parser).
			void logSwarmError(process.cwd(), "delivery", "parse.b64_failed", err, { bodyLen: body.length });
		}
	}
	if (body.startsWith("{")) {
		try {
			const msg = JSON.parse(body) as SwarmMessage;
			return {
				...msg,
				type: "swarm.message",
				schemaVersion: msg.schemaVersion || 1,
				requiresAck: msg.requiresAck ?? true,
				headers: msg.headers || {},
			};
		} catch (err) {
			void logSwarmError(process.cwd(), "delivery", "parse.json_failed", err, { bodyLen: body.length });
		}
	}
	const [headerPart, ...rest] = body.split(/\n\n/);
	const headers: Record<string, string> = {};
	for (const line of headerPart.split("\n")) {
		const i = line.indexOf(":");
		if (i > 0) headers[line.slice(0, i).trim()] = line.slice(i + 1).trim();
	}
	const fullBody = rest.join("\n\n");
	const m = fullBody.match(/Body:\n([\s\S]*)$/);
	return {
		id: headers.message_id || `msg-${randomUUID()}`,
		swarmId: headers.swarm_id || process.env.PI_SWARM_ID || "unknown",
		from: headers.from || "unknown",
		to: headers.to || currentAgentId(),
		priority: headers.priority || "normal",
		subject: headers.subject || undefined,
		type: "swarm.message",
		schemaVersion: 1,
		createdAt: headers.created_at || now(),
		body: (m ? m[1] : fullBody).trim(),
		requiresAck: true,
		headers,
	};
}
