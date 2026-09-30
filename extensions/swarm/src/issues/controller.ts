// === swarm/issues/controller.ts — root-authoritative issue-run controller (Phase 3b) ===
//
// Lock discipline: exported ops are invoked by commands/pump entries that already hold
// `withLock(p, …)`; internals call the Phase 3a lock-free cores (createTaskCore /
// setGoalCore / markGoalDoneCore) and NEVER tool handlers or nested withLock (carries the
// 3a P2/P3 probe contract forward).
//
// Provenance: linked task and goal are stamped issueRunId / issueId / snapshotHash;
// observation requires full provenance match (Phase 2 guards) so manual/unlinked tasks
// and stale replays cannot advance the run. Reload/replay cannot duplicate activation:
// activation is idempotent per (runId, issueId) via the snapshot hash + entry status.
//
// Safe-idle (plan §4): NOT a blind allEffectiveIdleAgents reuse — an assignment scan over
// ALL agent records (any status incl. stopped/stale/retired) blocks while any non-terminal
// task is held (linked or unrelated); allEffectiveIdleAgents().allIdle is then required;
// vacuous results are accepted ONLY when the scan found zero holders (drained pool).
//
// Goal fence: non-controller mutation of the active linked goal is refused at all real
// routes (tools/goals.ts wrappers + commands/goal.ts) via fenceActiveLinkedGoal; the
// controller's own core calls present controller provenance (`via: "issue-controller"`)
// and are the sole successful completion bridge.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readState, writeState, trace, type Paths } from "../state.ts";
import { getIssueRun, guardObserveLinkedTerminal, guardMarkIssueTerminal } from "./state.ts";
import { captureIssueSnapshot, sourceHashOf } from "./snapshot.ts";
import type { IssueSource } from "./source.ts";
import { createTaskCore } from "../primitives/task-core.ts";
import { markGoalDoneCore } from "../primitives/goal-core.ts";
import { allEffectiveIdleAgents } from "../nudges/goal-epoch.ts";
import { deliverMessageLocked } from "../mailbox.ts";
import { logSwarmError } from "../errorlog.ts";

export type ControllerDeps = {
	pi: any;
	readState: typeof readState;
	writeState: typeof writeState;
	trace: typeof trace;
	deliverMessageLocked: typeof deliverMessageLocked;
};

/**
 * Safe-idle blocker scan (plan §4 step 1): every agent record (ANY status/runtimeStatus,
 * explicitly including stopped/stale/retired) holding at least one non-terminal task id
 * in activeTaskIds is a blocker. Returns human-identity strings for `status`.
 */
export function safeIdleBlockers(st: {
	agents: Record<string, { activeTaskIds?: string[]; runtimeStatus?: string; status?: string }>;
}): string[] {
	const blockers: string[] = [];
	for (const [id, a] of Object.entries(st.agents ?? {})) {
		const held = (a.activeTaskIds ?? []).filter(Boolean);
		if (held.length > 0) blockers.push(`${id}(${a.runtimeStatus ?? a.status ?? "?"})`);
	}
	return blockers;
}

/**
 * Controller-safe idle gate (plan §4): assignment scan FIRST, then the existing predicate;
 * vacuous accepted only with zero holders. Returns { safe, blockers }.
 */
export function computeSafeIdle(
	st: Parameters<typeof safeIdleBlockers>[0] & Parameters<typeof allEffectiveIdleAgents>[0],
	nowMs: number,
): { safe: boolean; blockers: string[]; vacuous: boolean } {
	const blockers = safeIdleBlockers(st);
	if (blockers.length > 0) return { safe: false, blockers, vacuous: false };
	const eff = allEffectiveIdleAgents(st as any, nowMs);
	// vacuous (no effective agents at all) is safe ONLY when nobody holds work (step 1 passed)
	return { safe: eff.allIdle || eff.vacuous === true, blockers, vacuous: eff.vacuous === true };
}

/**
 * Fencing helper used by the REAL wrapper routes (tools/goals.ts, commands/goal.ts):
 * refuse mutation when the goal being touched is the active linked goal of a live run.
 * The fence composes ON TOP of classifyGoalClearAuthority (approvedByUser does not bypass
 * it); standalone goals are never affected (exact goalId match only).
 */
export function isFencedLinkedGoal(
	st: { issueRun?: { status?: string; runId?: string; activeIssueId?: string; queue?: Array<{ issueId: string; status: string; goalId?: string }> } },
	goalId: string | undefined,
): boolean {
	if (!goalId) return false;
	const run = st.issueRun;
	if (!run || (run.status !== "running" && run.status !== "paused")) return false;
	const entry = (run.queue ?? []).find((q) => q.goalId === goalId);
	if (!entry) return false;
	// Fence while the run holds the goal: active item, or terminal-unsuccessful awaiting
	// human disposition (abandon/stop will detach it controller-side).
	return entry.status === "active" || entry.status === "blocked" || entry.status === "failed";
}

/**
 * Controller-side goal detach/clear for abandon/stop/complete. Uses the markGoalDoneCore
 * with controller provenance — the fenced wrapper routes refuse, the controller proceeds.
 */
export async function fenceActiveLinkedGoal(p: Paths, ctx: { cwd: string }, st: any, via: string): Promise<{ cleared: boolean }> {
	const run = st.issueRun;
	const entry = run?.queue?.find((q) => q.goalId && (q.issueId === run.activeIssueId || via === "abandon" || via === "stop"));
	if (!st.goal || !entry?.goalId || st.goal.id !== entry.goalId) return { cleared: false };
	await markGoalDoneCore(p, ctx.cwd, { goalId: entry.goalId }, {
		readState,
		writeState,
		trace,
		actor: "root",
		// controller provenance: distinguishable in traces from tool/command routes
		via: "issue-controller" as any,
	});
	// The core re-read + wrote durable state itself; the caller's `st` is now stale (its
	// goal would resurrect on the next writeState). Sync the caller's object so the
	// controller's subsequent writeState persists the cleared goal.
	delete st.goal;
	return { cleared: true };
}

/**
 * Activate one queued issue under the caller's held lock (atomic ordering):
 * snapshot file → linked task → linked goal → staffing → state activation.
 * Idempotent per (runId, issueId): an existing active/terminal entry short-circuits.
 */
export async function activateIssueLocked(
	p: Paths,
	ctx: { cwd: string },
	st: any,
	runId: string,
	source: IssueSource,
	deps?: Partial<ControllerDeps>,
): Promise<{ taskId: string; goalId: string; snapshotPath: string }> {
	const run = getIssueRun(st);
	const entry = run.queue.find((q) => q.issueId === source.id);
	if (!entry) throw new Error(`activateIssueLocked: issue "${source.id}" is not in the run queue`);
	if (entry.status === "active" && entry.taskId && entry.goalId && entry.snapshotPath) {
		// idempotent replay: already activated
		return { taskId: entry.taskId, goalId: entry.goalId, snapshotPath: entry.snapshotPath };
	}
	if (entry.status !== "queued") throw new Error(`activateIssueLocked: issue "${source.id}" is "${entry.status}", expected queued`);

	const d: ControllerDeps = {
		pi: deps?.pi,
		readState: deps?.readState ?? readState,
		writeState: deps?.writeState ?? writeState,
		trace: deps?.trace ?? trace,
		deliverMessageLocked: deps?.deliverMessageLocked ?? (await import("../mailbox.ts")).deliverMessageLocked,
	};

	// 1. immutable snapshot (Phase 2: hash-idempotent, conflict = hard error);
	// docs resolve against the project cwd (plan contract), storage under p.root
	const snap = await captureIssueSnapshot(p.root, runId, source, runId, ctx.cwd);
	if (!snap.ok) throw new Error(`snapshot capture failed (${snap.code}): ${snap.message}`);

	// 2. linked task graph via the 3a lock-free core (provenance in params)
	const task = await createTaskCore(p, {
		pi: d.pi,
		readState: d.readState,
		writeState: d.writeState,
		trace: d.trace,
		deliverMessageLocked: d.deliverMessageLocked as any,
		cwd: ctx.cwd,
	}, {
		title: `[issue ${source.id}] ${source.title}`,
		nodes: {
			start: { title: `Implement issue ${source.id}`, description: source.content.slice(0, 500) },
		},
		edges: [],
		start: "start",
		issueRunId: runId,
		issueId: source.id,
		snapshotHash: snap.snapshotHash,
		issueSnapshotPath: snap.path,
	});

	// 3. linked goal via the 3a core with controller provenance
	const set = await (await import("../primitives/goal-core.ts")).setGoalCore(p, ctx.cwd, {
		text: `[issue ${source.id}] ${source.title} — run ${runId} (approved issue; snapshot ${snap.snapshotHash.slice(0, 12)})`,
		origin: "root",
	}, {
		readState: d.readState,
		writeState: d.writeState,
		trace: d.trace,
		actor: "root",
		via: "issue-controller" as any,
	});

	// 4. durable activation (Phase 2 guard enforces snapshot-before-linkage + single active)
	const { applyActivateIssue } = await import("./state.ts");
	const g0 = applyActivateIssue(st, source.id, task.taskId ?? task.id, set.goalId ?? set.goal?.id, snap.path, snap.snapshotHash);
	if (!g0.ok) throw new Error(`activation guard failed (${g0.code}): ${g0.message}`);
	// The task/goal cores re-read + wrote durable state themselves; the caller's `st` is
	// stale (it predates the goal write). Sync the goal so the controller's writeState
	// persists it instead of clobbering it back (same stale-write class as fenceActiveLinkedGoal).
	st.goal = set.goal;

	// 5. root activation notice — durable L1 via deliverMessageLocked (no timing promises)
	try {
		await d.deliverMessageLocked(d.pi, ctx.cwd, p, st, {
			to: "root",
			body: `[issues] activated "${source.id}" (run ${runId}, task ${task.taskId ?? task.id}).`,
			subject: `[issues] activated ${source.id}`,
			priority: "normal",
			idempotencyKey: `issues-activate:${runId}:${source.id}`,
		});
	} catch (err: unknown) {
		await logSwarmError(ctx.cwd, "issues-controller", "activation_notice_failed", err, { issueId: source.id, runId });
	}

	// 6. Phase-4 root activation context hint — compact, durable-deduped (plan §6).
	// Body carries ONLY issue id/title + skill name (never snapshot content). Dedupe rides the
	// existing deliverMessageLocked idempotency index; stale fencing: live linkage must be
	// active-in-running at send time. Informational: no ack/response debt.
	try {
		await deliverIssueHint(d, ctx.cwd, p, st, {
			to: "root",
			idempotencyKey: `issues-hint:activate:${runId}:${source.id}`,
			issueId: source.id,
			issueTitle: source.title,
		});
	} catch (err: unknown) {
		await logSwarmError(ctx.cwd, "issues-controller", "activation_hint_failed", err, { issueId: source.id, runId });
	}

	return { taskId: task.taskId ?? task.id, goalId: set.goalId ?? set.goal?.id, snapshotPath: snap.path };
}

// === Phase-4 context hints (plan §6) ===
// One compact hint per activation (root) and per issue-linked assignment attempt (worker).
// Pure helpers exported for the focused suite; delivery rides deliverMessageLocked only.
export function issueHintBody(issueId: string, issueTitle: string): string {
	return `[issues] Active issue "${issueId}" — ${issueTitle}. Context: swarm-issues skill (show-active-issue.mjs).`;
}

export function hintAllowedForRun(
	run: { status?: string; activeIssueId?: string; queue?: Array<{ issueId: string; status: string }> } | undefined,
	issueId: string,
): boolean {
	if (!run || run.status !== "running" || run.activeIssueId !== issueId) return false;
	const entry = (run.queue ?? []).find((q) => q.issueId === issueId);
	return entry?.status === "active";
}

async function deliverIssueHint(
	d: ControllerDeps,
	cwd: string,
	p: Paths,
	st: any,
	opts: { to: string; idempotencyKey: string; issueId: string; issueTitle: string },
): Promise<void> {
	await d.deliverMessageLocked(d.pi, cwd, p, st, {
		to: opts.to,
		body: issueHintBody(opts.issueId, opts.issueTitle),
		subject: `[issues] context: ${opts.issueId}`,
		priority: "normal",
		requiresAck: false,
		requiresResponse: false,
		idempotencyKey: opts.idempotencyKey,
	});
}

/**
 * Observe the active linked task's durable status under the caller's lock. Terminal done →
 * controller goal core → issue done → safe-idle → next activation. blocked/failed/cancelled
 * → issue terminal + run paused + ONE root notice; later items frozen.
 * Idempotent: replayed observations no-op via Phase 2 terminal guards.
 */
export async function observeLinkedTaskLocked(
	p: Paths,
	ctx: { cwd: string },
	st: any,
	taskStatus: { taskId: string; status: string },
	deps?: Partial<ControllerDeps>,
): Promise<{ acted: boolean; effect?: string }> {
	const run = getIssueRun(st);
	if (run.status !== "running") return { acted: false };
	if (!run.activeIssueId) {
		// Post-hold replay: the just-done issue went terminal while safe-idle was blocked;
		// a later observation (hold released) is the resume path. Re-check and advance.
		const doneEntry = run.queue.find((q) => q.status === "done");
		if (!doneEntry) return { acted: false };
		const idle = computeSafeIdle(st, Date.now());
		if (!idle.safe) return { acted: false }; // still held — no-op
		await advanceNextIssueLocked(p, ctx, st, deps);
		return { acted: true, effect: "advanced" };
	}
	const entry = run.queue.find((q) => q.issueId === run.activeIssueId);
	if (!entry) return { acted: false };
	const g = guardObserveLinkedTerminal(st, entry.issueId, taskStatus.taskId, entry.snapshotHash ?? "");
	if (!g.ok) return { acted: false }; // unlinked/provenance-mismatch — never ours to act on

	if (taskStatus.status === "done") {
		// controller-internal goal completion (fenced routes refuse; core proceeds)
		await fenceActiveLinkedGoal(p, ctx, st, "complete");
		const gm = guardMarkIssueTerminal(st, entry.issueId, "done");
		if (!gm.ok) return { acted: false }; // already-terminal replay — no-op
		await writeState(p, st);
		// safe-idle: advance only when safe
		const idle = computeSafeIdle(st, Date.now());
		if (idle.safe) {
			await writeState(p, st);
			await advanceNextIssueLocked(p, ctx, st, deps);
			return { acted: true, effect: "advanced" };
		}
		await trace(p, "issues.safe_idle_hold", { runId: run.runId, blockers: idle.blockers, vacuous: idle.vacuous });
		return { acted: true, effect: "held_for_safe_idle" };
	}

	if (taskStatus.status === "blocked" || taskStatus.status === "failed" || taskStatus.status === "cancelled") {
		const gm = guardMarkIssueTerminal(st, entry.issueId, taskStatus.status as any, `linked task ${taskStatus.status}`);
		if (!gm.ok) return { acted: false };
		run.status = "paused";
		await writeState(p, st);
		const d: ControllerDeps = {
			pi: deps?.pi,
			readState: deps?.readState ?? readState,
			writeState: deps?.writeState ?? writeState,
			trace: deps?.trace ?? trace,
			deliverMessageLocked: deps?.deliverMessageLocked ?? (await import("../mailbox.ts")).deliverMessageLocked,
		};
		try {
			await d.deliverMessageLocked(d.pi, ctx.cwd, p, st, {
				to: "root",
				body: `[issues] "${entry.issueId}" is ${taskStatus.status} — run ${run.runId} paused. Inspect with /swarm issues status; disposition (abandon) is a human decision. Later issues will not surface until then.`,
				subject: `[issues] ${entry.issueId} ${taskStatus.status}`,
				priority: "high",
				idempotencyKey: `issues-terminal:${run.runId}:${entry.issueId}`,
			});
		} catch (err: unknown) {
			await logSwarmError(ctx.cwd, "issues-controller", "terminal_notice_failed", err, { issueId: entry.issueId, runId: run.runId });
		}
		return { acted: true, effect: "paused" };
	}
	return { acted: false };
}

/** Advance to the next queued issue when the current one completed safely. */
export async function advanceNextIssueLocked(p: Paths, ctx: { cwd: string }, st: any, deps?: Partial<ControllerDeps>): Promise<boolean> {
	const run = getIssueRun(st);
	if (run.status !== "running") return false;
	const next = run.queue.find((q) => q.status === "queued");
	if (!next) {
		// whole queue done → complete
		const { guardCompleteRun } = await import("./state.ts");
		if (guardCompleteRun(st).ok) {
			try {
				const d: ControllerDeps = {
					pi: deps?.pi,
					readState: deps?.readState ?? readState,
					writeState: deps?.writeState ?? writeState,
					trace: deps?.trace ?? trace,
					deliverMessageLocked: deps?.deliverMessageLocked ?? (await import("../mailbox.ts")).deliverMessageLocked,
				};
				await d.deliverMessageLocked(d.pi, ctx.cwd, p, st, {
					to: "root",
					body: `[issues] run ${run.runId} complete: all ${run.queue.length} issue(s) done.`,
					subject: `[issues] run complete`,
					idempotencyKey: `issues-complete:${run.runId}`,
				});
			} catch (err: unknown) {
				await logSwarmError(ctx.cwd, "issues-controller", "complete_notice_failed", err, { runId: run.runId });
			}
		}
		return false;
	}
	// snapshot governs content: rebuild IssueSource from the queue entry's source hash match
	// by re-reading the validated source file (queued refresh semantics from Phase 2).
	try {
		const { readFile } = await import("node:fs/promises");
		const { validateIssuesSource } = await import("./source.ts");
		const text = await readFile(p.root + "/issues.yml", "utf8");
		const v = validateIssuesSource(text);
		const src = v.ok ? v.issues.find((i) => i.id === next.issueId) : undefined;
		if (!src) throw new Error(`queued issue "${next.issueId}" missing/invalid in source; run paused for human review`);
		await activateIssueLocked(p, ctx, st, run.runId!, src, deps);
		await writeState(p, st);
		return true;
	} catch (err: unknown) {
		run.status = "paused";
		run.updatedAt = new Date().toISOString();
		await writeState(p, st);
		await logSwarmError(ctx.cwd, "issues-controller", "advance_failed", err, { runId: run.runId, issueId: next.issueId });
		return false;
	}
}
