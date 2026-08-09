// === swarm/gc.ts — bounded retention / garbage collection for SwarmState (PURE) ===
//
// This module performs NO filesystem I/O and acquires NO locks. It operates ONLY on the passed
// state object: it mutates st.messages and st.delivered in place and returns { removed, kept }.
// The companion tool (src/tools/gc.ts) is responsible for readState/withLock/writeState.
//
// Retention rule (see task swarm-robustness-v1 / node retention):
//   - Always keep the most-recent `keepMessages` messages by updatedAt (ties broken by id).
//   - Beyond that window, DROP a message ONLY when its lifecycle is terminal:
//       * status === "dead_letter", OR
//       * ackedAt is set AND lastAck.status === "done", OR
//       * response.status is "verified" or "waived".
//   - NEVER drop a message that is still actionable (queued / mailbox_delivered / injected /
//     intercepted / failed / acked-but-not-done), even when it falls outside the window.
//   - Cap each delivered[agentId] ledger to the most-recent `keepMessages` ids, intersection-safe
//     (drop refs to pruned ids first, then bound to the newest `keepMessages`).
//
// Because actionable messages are always retained, `kept` MAY exceed `keepMessages`. That is
// intentional: bounding clutter must never silently drop in-flight coordination state.
import type { MessageRecord, SwarmState } from "./types.ts";

export interface PruneOptions {
	/** Number of most-recent messages to always retain. Defaults to DEFAULT_KEEP_MESSAGES (500). */
	keepMessages?: number;
}

export const DEFAULT_KEEP_MESSAGES = 500;

// A message is "terminal" (safe to drop from the bounded tail) once its lifecycle is finished.
function isTerminal(rec: MessageRecord): boolean {
	if (rec.status === "dead_letter") return true;
	if (rec.ackedAt && rec.lastAck?.status === "done") return true;
	const rs = rec.response?.status;
	if (rs === "verified" || rs === "waived") return true;
	return false;
}

export function pruneState(st: SwarmState, opts: PruneOptions = {}): { removed: number; kept: number } {
	const keepMessages = typeof opts.keepMessages === "number" && Number.isFinite(opts.keepMessages) && opts.keepMessages >= 0
		? Math.floor(opts.keepMessages)
		: DEFAULT_KEEP_MESSAGES;

	st.messages ||= {};
	st.delivered ||= {};
	const ids = Object.keys(st.messages);
	const total = ids.length;

	// Always keep the most-recent `keepMessages` by updatedAt (fall back to createdAt), breaking
	// ties by id. Sort ascending (oldest first); the most-recent sit at the tail.
	const ordered = ids.slice().sort((a, b) => {
		const ra = st.messages[a], rb = st.messages[b];
		const ua = ra?.updatedAt || ra?.createdAt || "";
		const ub = rb?.updatedAt || rb?.createdAt || "";
		if (ua !== ub) return ua < ub ? -1 : 1;
		if (a !== b) return a < b ? -1 : 1;
		return 0;
	});
	const windowSize = Math.min(keepMessages, ordered.length);
	const inWindow = new Set(ordered.slice(ordered.length - windowSize));

	// Drop a message ONLY when it is outside the recency window AND its lifecycle is terminal.
	let removed = 0;
	for (const id of ids) {
		if (inWindow.has(id)) continue; // most-recent window: always kept
		if (isTerminal(st.messages[id])) {
			delete st.messages[id];
			removed++;
		}
	}
	const kept = total - removed;

	// Cap each delivered[agentId] ledger to the most-recent `keepMessages` ids, intersection-safe:
	// first drop refs to ids no longer present in st.messages, then bound to the newest `keepMessages`.
	const surviving = new Set(Object.keys(st.messages));
	for (const agentId of Object.keys(st.delivered)) {
		let arr = (st.delivered[agentId] || []).filter((id) => surviving.has(id));
		if (arr.length > keepMessages) arr = arr.slice(arr.length - keepMessages);
		st.delivered[agentId] = arr;
	}

	return { removed, kept };
}
