// === swarm/src/issues/state.ts ===
//
// Durable issue-run state model, backfill, and pure transition guards (Phase 2).
//
// CONTRACT (per approved plan):
// - `SwarmState.issueRun` is LIGHTWEIGHT: queue refs + snapshotPath + hashes only.
//   Doc bodies never serialize into swarm-state.json (they live in immutable snapshot
//   files — see snapshot.ts).
// - Transitions are PURE functions over SwarmState: `{ ok: true } | { ok: false, code }`.
//   No fs, no lock acquisition, no I/O — the Phase 3 controller invokes them inside the
//   existing `withLock` boundary.
// - Invariants: at most one active issue; activation requires a prior snapshot path
//   (snapshot-before-linkage ordering); terminal-unsuccessful issues are never
//   implicitly requeued; `complete` requires every entry done; observation of linked
//   terminals requires full provenance (run/issue/task/snapshotHash match).
// - Recovery: `reconcileIssueRun` pauses (never recreates work) when the active pointer
//   cannot be re-validated against durable task linkage.

import type { SwarmState } from "../types/state.ts";

export type IssueRunStatus = "inactive" | "running" | "paused" | "complete" | "stopped";
export type IssueStatus = "queued" | "active" | "done" | "blocked" | "failed" | "cancelled";

export type IssueQueueEntry = {
	issueId: string;
	title: string;
	sourceHash: string;
	/** Set only once activation captured the immutable snapshot. Snapshot-before-linkage. */
	snapshotPath?: string;
	snapshotHash?: string;
	status: IssueStatus;
	/** Required for blocked/failed/cancelled (human disposition at resume/abandon time). */
	reason?: string;
	/** Linkage provenance — set by the Phase 3 controller, never hand-authored. */
	taskId?: string;
	goalId?: string;
	activatedAt?: string;
	completedAt?: string;
};

export type IssueRun = {
	status: IssueRunStatus;
	runId?: string;
	queue: IssueQueueEntry[];
	activeIssueId?: string;
	startedAt?: string;
	updatedAt?: string;
	// advancement-mode: "waiting-manual" while manual mode holds the advance for the human;
	// absent otherwise (auto/legacy). Cleared by resume only — stale markers after
// stop/abandon are inert (resume guards refuse). advancementMode snapshots
	// the resolved mode at start for status display honesty.
	advancement?: "waiting-manual";
	advancementMode?: "auto" | "manual";
};

export type Guard = { ok: true } | { ok: false; code: string; message: string };

const ok: Guard = { ok: true };
const fail = (code: string, message: string): Guard => ({ ok: false, code, message });

const ISSUE_RUN_STATUSES: IssueRunStatus[] = ["inactive", "running", "paused", "complete", "stopped"];
const ISSUE_STATUSES: IssueStatus[] = ["queued", "active", "done", "blocked", "failed", "cancelled"];

/** Normalize `st.issueRun` to a well-formed lightweight shape. Used by readState backfill. */
export function backfillIssueRun(st: SwarmState): void {
	const cur = (st as { issueRun?: unknown }).issueRun;
	if (!cur || typeof cur !== "object" || Array.isArray(cur)) {
		(st as { issueRun?: IssueRun }).issueRun = { status: "inactive", queue: [] };
		return;
	}
	const run = cur as Partial<IssueRun>;
	if (typeof run.status !== "string" || !ISSUE_RUN_STATUSES.includes(run.status as IssueRunStatus)) run.status = "inactive";
	if (!Array.isArray(run.queue)) {
		run.queue = [];
	} else {
		// Keep only structurally-sane entries; a partial entry without id/hash cannot be
		// a provenance anchor, so it is dropped rather than guessed at.
		run.queue = run.queue.filter(
			(e): e is IssueQueueEntry =>
				!!e && typeof e === "object" && typeof (e as IssueQueueEntry).issueId === "string" && (e as IssueQueueEntry).issueId !== "" &&
				typeof (e as IssueQueueEntry).sourceHash === "string" &&
				typeof (e as IssueQueueEntry).status === "string" && ISSUE_STATUSES.includes((e as IssueQueueEntry).status as IssueStatus),
		);
	}
	if (run.status !== "running" && run.status !== "paused") run.activeIssueId = undefined;
	if (run.activeIssueId !== undefined && typeof run.activeIssueId !== "string") run.activeIssueId = undefined;
}

export function getIssueRun(st: SwarmState): IssueRun {
	backfillIssueRun(st);
	return (st as { issueRun: IssueRun }).issueRun;
}

function findEntry(run: IssueRun, issueId: string): IssueQueueEntry | undefined {
	return run.queue.find((e) => e.issueId === issueId);
}

/** Activate a queued issue. Requires run `running`, entry `queued`, snapshot already captured. */
export function guardActivateIssue(st: SwarmState, issueId: string, snapshotPath: string, snapshotHash: string): Guard {
	const run = getIssueRun(st);
	if (run.status !== "running") return fail("run_not_running", `cannot activate issue "${issueId}" while run status is "${run.status}"`);
	const entry = findEntry(run, issueId);
	if (!entry) return fail("issue_not_queued", `issue "${issueId}" is not in the run queue`);
	if (entry.status !== "queued") return fail("issue_not_queued", `issue "${issueId}" status is "${entry.status}", expected "queued"`);
	if (run.activeIssueId && run.activeIssueId !== issueId) return fail("second_active", `issue "${run.activeIssueId}" is already active; at most one active issue is allowed`);
	if (!snapshotPath || !snapshotHash) return fail("snapshot_required", `issue "${issueId}" cannot activate without a captured immutable snapshot`);
	return ok;
}

/** Record activation on the entry (controller applies this after guardActivateIssue passes). */
export function applyActivateIssue(st: SwarmState, issueId: string, taskId: string, goalId: string, snapshotPath: string, snapshotHash: string, at = new Date().toISOString()): Guard {
	const g = guardActivateIssue(st, issueId, snapshotPath, snapshotHash);
	if (!g.ok) return g;
	const run = getIssueRun(st);
	const entry = findEntry(run, issueId)!;
	entry.status = "active";
	entry.taskId = taskId;
	entry.goalId = goalId;
	entry.snapshotPath = snapshotPath;
	entry.snapshotHash = snapshotHash;
	entry.activatedAt = at;
	run.activeIssueId = issueId;
	run.updatedAt = at;
	return ok;
}

/**
 * Observe a linked task's terminal status. Requires full provenance: the run must be
 * active on this issue, the entry must carry a matching taskId, and the snapshot hash
 * must match — unlinked/manual tasks are rejected here by construction.
 */
export function guardObserveLinkedTerminal(st: SwarmState, issueId: string, taskId: string, snapshotHash: string): Guard {
	const run = getIssueRun(st);
	if (run.activeIssueId !== issueId) return fail("not_active_issue", `issue "${issueId}" is not the active issue`);
	const entry = findEntry(run, issueId);
	if (!entry) return fail("unknown_issue", `issue "${issueId}" is not in the run queue`);
	if (entry.taskId !== taskId) return fail("unlinked_task", `task "${taskId}" does not carry the linkage marker for issue "${issueId}"`);
	if (entry.snapshotHash !== snapshotHash) return fail("provenance_mismatch", `snapshotHash mismatch for issue "${issueId}"; refusing observation`);
	return ok;
}

/** Mark a terminal status. blocked/failed/cancelled REQUIRE an explicit reason (human disposition). */
export function guardMarkIssueTerminal(st: SwarmState, issueId: string, status: "done" | "blocked" | "failed" | "cancelled", reason?: string, at = new Date().toISOString()): Guard {
	const run = getIssueRun(st);
	const entry = findEntry(run, issueId);
	if (!entry) return fail("unknown_issue", `issue "${issueId}" is not in the run queue`);
	if (entry.status === "done" || entry.status === "blocked" || entry.status === "failed" || entry.status === "cancelled") {
		return fail("already_terminal", `issue "${issueId}" is already "${entry.status}"; terminal-unsuccessful issues are never implicitly requeued`);
	}
	if (status === "done" && entry.status !== "active") return fail("done_requires_active", `issue "${issueId}" must be "active" (linked success) before "done"`);
	if ((status === "blocked" || status === "failed" || status === "cancelled") && (!reason || reason.trim() === "")) {
		return fail("reason_required", `issue "${issueId}" cannot become "${status}" without an explicit reason`);
	}
	entry.status = status;
	entry.reason = reason;
	entry.completedAt = at;
	if (run.activeIssueId === issueId) run.activeIssueId = undefined;
	if (status === "cancelled") {
		run.status = "stopped";
	}
	run.updatedAt = at;
	return ok;
}

/** Whole-run completion: every queue entry must be terminal-successful ("done"). */
export function guardCompleteRun(st: SwarmState, at = new Date().toISOString()): Guard {
	const run = getIssueRun(st);
	if (run.status !== "running" && run.status !== "paused") return fail("run_not_running", `cannot complete a run in status "${run.status}"`);
	if (run.activeIssueId) return fail("active_issue_open", `issue "${run.activeIssueId}" is still active`);
	const notDone = run.queue.filter((e) => e.status !== "done");
	if (notDone.length > 0) {
		return fail("incomplete_queue", `cannot complete: ${notDone.length} issue(s) not done (${notDone.map((e) => `${e.issueId}:${e.status}`).join(", ")})`);
	}
	run.status = "complete";
	run.updatedAt = at;
	return ok;
}

/** Pause/resume transitions. Resume keeps queue state; it never requeues terminal-unsuccessful items. */
export function guardPauseRun(st: SwarmState, reason?: string, at = new Date().toISOString()): Guard {
	const run = getIssueRun(st);
	if (run.status !== "running") return fail("not_running", `cannot pause a run in status "${run.status}"`);
	run.status = "paused";
	run.updatedAt = at;
	if (reason) run.queue.filter((e) => e.issueId === run.activeIssueId).forEach((e) => { e.reason = e.reason ?? reason; });
	return ok;
}

export function guardResumeRun(st: SwarmState, at = new Date().toISOString()): Guard {
	const run = getIssueRun(st);
	if (run.status !== "paused") return fail("not_paused", `cannot resume a run in status "${run.status}"`);
	// Safe-resume invariant: no terminal-unsuccessful entry may be implicitly requeued;
	// if one exists the human must dispose of it first (Phase 3 abandon/cancel surface).
	const stuck = run.queue.find((e) => e.status === "blocked" || e.status === "failed");
	if (stuck) return fail("human_disposition_required", `issue "${stuck.issueId}" is "${stuck.status}"; human disposition required before resume`);
	run.status = "running";
	run.updatedAt = at;
	return ok;
}

export function guardStopRun(st: SwarmState, at = new Date().toISOString()): Guard {
	const run = getIssueRun(st);
	if (run.status === "complete" || run.status === "stopped") return fail("already_terminal", `run is already "${run.status}"`);
	// Stop ends automatic sequencing but NEVER implicitly cancels the active issue's
	// linked task/goal — those keep their existing task-lifecycle authority.
	run.status = "stopped";
	run.updatedAt = at;
	return ok;
}

/**
 * State-loss reconciliation (pure): if the active pointer cannot be re-validated against
 * durable task linkage, transition the run to `paused` with reason `state_loss_recovered`.
 * NEVER recreates work (phase-02 risk contract). The Phase 3 controller invokes this
 * inside its lock after reload/watchdog ticks.
 */
export function reconcileIssueRun(st: SwarmState, durableTaskLinks: Record<string, { issueId: string; snapshotHash: string }>, at = new Date().toISOString()): { guard: Guard; paused: boolean } {
	const run = getIssueRun(st);
	if (run.status !== "running" || !run.activeIssueId) return { guard: ok, paused: false };
	const entry = findEntry(run, run.activeIssueId);
	if (!entry) {
		run.status = "paused";
		run.updatedAt = at;
		return { guard: fail("active_pointer_dangling", `active issue "${run.activeIssueId}" is not in the queue; run paused`), paused: true };
	}
	const link = entry.taskId ? durableTaskLinks[entry.taskId] : undefined;
	if (!link || link.issueId !== entry.issueId || link.snapshotHash !== entry.snapshotHash) {
		run.status = "paused";
		entry.reason = "state_loss_recovered";
		run.updatedAt = at;
		return { guard: fail("state_loss_recovered", `active issue "${entry.issueId}" lost durable task linkage; run paused, not recreated`), paused: true };
	}
	return { guard: ok, paused: false };
}
