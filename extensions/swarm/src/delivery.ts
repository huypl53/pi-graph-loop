// === swarm/delivery.ts — auto-extracted from index.ts (verbatim bodies) ===
import { join, dirname, relative, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { SwarmMessage } from "./types.ts";
import { PI_SWARM_MINIMAL_PROTOCOL, SYSTEM_END, SYSTEM_START } from "./constants.ts";
import { currentAgentId } from "./session.ts";
import { deliver } from "./mailbox.ts";
import { now } from "./utils.ts";
import { reconcile } from "./reconcile.ts";
import { tmux } from "./tmux.ts";

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
	// === Issue 25 Phase 2: gate-aware [PI-SWARM ACK REQUIRED] rendering (proposal §K.3) ===
	// Under PI_SWARM_MINIMAL_PROTOCOL=1 the engine derives lifecycle state from recipient actions;
	// recipients no longer need to be told to call swarm_ack_message explicitly. Under gate=0 the
	// hint stays so a Phase-2 ship never alters what legacy recipients see (Phase-1 contract
	// preserved — the rendered body is byte-identical to Phase 1).
	const showAckHint = PI_SWARM_MINIMAL_PROTOCOL === 0;
	const ackLine = showAckHint && msg.requiresAck
		? `\n\n[PI-SWARM ACK REQUIRED] This message requires acknowledgement. Call \`swarm_ack_message\` with messageId="${msg.id}" and status=\`seen\`|\`processing\`|\`done\`|\`failed\` (ack \`seen\`/\`processing\` now, then \`done\`/\`failed\` when complete). Unacked delivered messages are surfaced as ack_missing.`
		: "";
	return `Inter-agent swarm message from ${msg.from} to ${msg.to}${msg.subject ? ` (${msg.subject})` : ""}:\n\n${msg.body}${ackLine}`;
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
			return { ...msg, type: "swarm.message", schemaVersion: msg.schemaVersion || 1, requiresAck: msg.requiresAck ?? true, headers: msg.headers || {} };
		} catch {}
	}
	if (body.startsWith("{")) {
		try {
			const msg = JSON.parse(body) as SwarmMessage;
			return { ...msg, type: "swarm.message", schemaVersion: msg.schemaVersion || 1, requiresAck: msg.requiresAck ?? true, headers: msg.headers || {} };
		} catch {}
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
