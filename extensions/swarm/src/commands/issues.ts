// === swarm/commands/issues.ts — human-only /swarm issues command family (Phase 3b) ===
//
// Root-interactive, human-only command surface for the issue run. NEVER a Pi tool:
// nothing in this module calls pi.registerTool. Guests/workers are rejected before any
// mutation. Commands:
//   validate | status | start | pause | resume | abandon <issue-id> | stop
//
// Runtime contract posture: command replies are synchronous local UI (ctx.ui.notify, L3).
// Durable controller notices use deliverMessageLocked → root pump (no timing promises).

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { currentAgentId } from "../session.ts";
import { readState, withLock, writeState, trace, type Paths } from "../state.ts";
import { validateIssuesSource, classifyDocPath } from "../issues/source.ts";
import { captureIssueSnapshot, sourceHashOf } from "../issues/snapshot.ts";
import { setIssueFooter } from "../issues/footer.ts";
import {
	getIssueRun, guardActivateIssue, applyActivateIssue, guardPauseRun, guardResumeRun,
	reconcileIssueRun, type IssueQueueEntry,
} from "../issues/state.ts";
import { activateIssueLocked, safeIdleBlockers, fenceActiveLinkedGoal } from "../issues/controller.ts";
import { findPriorCompletions } from "../issues/dedup.ts";
import { logSwarmError } from "../errorlog.ts";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const USAGE =
	"Usage: /swarm issues validate | status | start [--force-all] | pause | resume | abandon <issue-id> <reason...> | stop\n  advancement: auto (default) | manual — via .pi/swarm.yml issue-sequencer.advancement or PI_SWARM_ISSUES_ADVANCEMENT; manual holds each done issue for /swarm issues resume\n  start --force-all: deliberately re-run every issue (bypasses prior-completion dedup)";

/** Root-interactive gate. Mirrors the goal command's root check. */
function requireRoot(ctx: any): boolean {
	if (currentAgentId() === "root") return true;
	ctx.ui.notify("issues is root-only: run it in the PM session (PI_SWARM_IS_ROOT=1 or /swarm register here root)", "warning");
	return false;
}

function loadSource(root: string) {
	return readFile(join(root, "issues.yml"), "utf8").then(
		(t) => t,
		(err: unknown) => {
			if ((err as NodeJS.ErrnoException)?.code === "ENOENT") throw new Error(`no issue source at ${join(root, "issues.yml")}`);
			throw err;
		},
	);
}

export async function handleIssuesCommand(cmd: "issues", rest: string[], ctx: any, p: Paths, _pi: ExtensionAPI): Promise<void> {
	const sub = rest.shift() ?? "";
	const root = p.root;

	if (sub === "validate") {
		// Pure, zero-mutation: canonical validator + pure path classification only.
		try {
			const text = await loadSource(root);
			const r = validateIssuesSource(text);
			if (!r.ok) {
				ctx.ui.notify(`issues.yml invalid (${r.errors.length} error(s)):\n` + r.errors.map((e) => `  - [${e.index ?? "-"}] ${e.field}: ${e.code} — ${e.message}`).join("\n"), "warning");
				return;
			}
			const fsChecks: string[] = [];
			for (const issue of r.issues) {
				for (const d of issue.docs) {
					const c = classifyDocPath(root, d);
					if (!c.ok) fsChecks.push(`${issue.id}: ${d} → ${c.code}`);
				}
			}
			ctx.ui.notify(fsChecks.length ? `issues.yml schema valid; ${fsChecks.length} doc path problem(s):\n  ${fsChecks.join("\n  ")}` : `issues.yml valid: ${r.issues.length} issue(s).`, "info");
		} catch (err: unknown) {
			ctx.ui.notify(`issues validate failed: ${err instanceof Error ? err.message : String(err)}`, "warning");
		}
		return;
	}

	if (!requireRoot(ctx)) return;

	if (sub === "status") {
		const st = await readState(p, ctx.cwd);
		const run = getIssueRun(st);
		const lines: string[] = [`Issue run: ${run.status}${run.runId ? ` (${run.runId})` : ""}`];
		if (run.activeIssueId) {
			const e = run.queue.find((q) => q.issueId === run.activeIssueId);
			lines.push(`  active: ${run.activeIssueId}${e ? ` (task ${e.taskId ?? "-"}, goal ${e.goalId ?? "-"}, snapshot ${e.snapshotPath ?? "-"})` : ""}`);
			if (e?.reason) lines.push(`  reason: ${e.reason}`);
		}
		const blockers = safeIdleBlockers(st);
		if (blockers.length) lines.push(`  safe-idle blockers: ${blockers.join(", ")}`);
		// advancement-mode: render mode + waiting state explicitly (auto/unset renders nothing new)
		try {
			const { resolveIssueAdvancement } = await import("../issues/config.ts");
			const mode = resolveIssueAdvancement(ctx.cwd);
			if (mode === "manual") {
				lines.push(run.advancement === "waiting-manual" ? `  advancement: manual (waiting — /swarm issues resume)` : `  advancement: manual`);
			}
		} catch (err: unknown) {
			void err; // config errors surface via start/validate; status stays renderable
		}
		const done = run.queue.filter((q) => q.status === "done").length;
		lines.push(`  queue: ${run.queue.length} (done ${done}, queued ${run.queue.filter((q) => q.status === "queued").length})`);
		// issues-sequencer-restart-dedup: surface deduped entries (done with reason starting
		// "already completed in run") so the human can see which issues were skipped.
		const deduped = run.queue.filter((q) => q.status === "done" && (q.reason ?? "").startsWith("already completed in run"));
		if (deduped.length > 0) {
			lines.push(`  deduped from prior runs: ${deduped.map((q) => `${q.issueId} (${q.reason})`).join(", ")}`);
		}
		// source drift (queued entries only)
		try {
			const text = await loadSource(root);
			const v = validateIssuesSource(text);
			lines.push(`  source: ${v.ok ? `valid, ${v.issues.length} issue(s)` : "INVALID"}`);
			if (v.ok && run.activeIssueId) {
				const active = run.queue.find((q) => q.issueId === run.activeIssueId);
				const src = v.issues.find((i) => i.id === run.activeIssueId);
				if (active && src && sourceHashOf(src) !== active.sourceHash) lines.push(`  drift: active issue "${active.issueId}" differs from source (snapshot governs)`);
			}
		} catch (err: unknown) {
			lines.push(`  source: unreadable (${err instanceof Error ? err.message : String(err)})`);
		}
		ctx.ui.notify(lines.join("\n"), "info");
		return;
	}

	if (sub === "start") {
		// issues-sequencer-restart-dedup: parse --force-all / -F BEFORE any mutation.
		// When set, deliberately bypass the prior-completion dedup scan.
		let forceAll = false;
		const filteredRest: string[] = [];
		for (const arg of rest) {
			if (arg === "--force-all" || arg === "-F") {
				forceAll = true;
			} else {
				filteredRest.push(arg);
			}
		}
		rest = filteredRest;
		await withLock(p, async () => {
			const st = await readState(p, ctx.cwd);
			if (st.goal) {
				ctx.ui.notify(`start refused: an active goal exists (${st.goal.id}). Resolve it first.`, "warning");
				return;
			}
			const existing = getIssueRun(st);
			if (existing.status === "running") {
				ctx.ui.notify(`start refused: run ${existing.runId ?? ""} is already running.`, "warning");
				return;
			}
			if (existing.status === "paused") {
				ctx.ui.notify("start refused: a paused run exists — use /swarm issues resume.", "warning");
				return;
			}
			let text: string;
			try {
				text = await loadSource(root);
			} catch (err: unknown) {
				ctx.ui.notify(`start refused: ${err instanceof Error ? err.message : String(err)}`, "warning");
				return;
			}
			const v = validateIssuesSource(text);
			if (!v.ok) {
				ctx.ui.notify(`start refused: issues.yml invalid (${v.errors.length} error(s))`, "warning");
				return;
			}
			// advancement-mode: fail-fast on invalid advancement config BEFORE any run mutation
			let advancementMode: "auto" | "manual";
			let workflowMode: "feature-dev" | "single";
			try {
				const cfg = await import("../issues/config.ts");
				advancementMode = cfg.resolveIssueAdvancement(ctx.cwd);
				workflowMode = cfg.resolveIssueWorkflow(ctx.cwd);
			} catch (err: unknown) {
				ctx.ui.notify(`start refused: ${err instanceof Error ? err.message : String(err)}`, "error");
				throw err;
			}
			const run = getIssueRun(st);
			// Capture the PRIOR runId BEFORE we overwrite it with the new run's id.
			// The backfill seeds the ledger with the prior run's done entries, so the
			// runId in the ledger must point to the run that actually did the work.
			const priorRunId = run.runId;
			run.status = "running";
			run.runId = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
			run.startedAt = new Date().toISOString();
			run.advancementMode = advancementMode;
			run.workflowMode = workflowMode;
			run.forceAll = forceAll;
			// An explicit human start renews the automatic-run budget and clears stop's kill-switch.
			run.autoContinueCount = 0;
			run.autoContinueDisabled = false;
			run.autoContinueCapNotified = false;
			// issues-sequencer-restart-dedup: backfill the completion ledger from the PRIOR
			// run's done entries on first start after this fix lands. Idempotent: if the
			// ledger already exists, seedCompletionLedger is a no-op. We read the state
			// BEFORE the new run is created so the prior run's queue is still intact.
			try {
				const { seedCompletionLedger } = await import("../issues/dedup.ts");
				const bf = await seedCompletionLedger(p.root, { issueRun: { runId: priorRunId, queue: run.queue } });
				if (bf.seeded > 0) {
					await trace(p, "issues.restart_dedup_backfill", { seeded: bf.seeded, skipped: bf.skipped });
				}
			} catch (err: unknown) {
				await logSwarmError(ctx.cwd, "issues-dedup", "backfill_failed", err, { runId: run.runId });
			}
			// issues-sequencer-restart-dedup: build the queue, then consult the completion
			// ledger for prior completions. Content-hash match → mark as done with reason.
			// --force-all bypasses the scan entirely.
			const queueEntries: IssueQueueEntry[] = v.issues.map<IssueQueueEntry>((i) => ({
				issueId: i.id,
				title: i.title,
				sourceHash: sourceHashOf(i),
				status: "queued",
			}));
			if (!forceAll) {
				const prior = await findPriorCompletions(
					p.root,
					queueEntries.map((q) => ({ id: q.issueId, sourceHash: q.sourceHash })),
				);
				for (const entry of queueEntries) {
					const pc = prior.get(entry.issueId);
					if (pc && pc.sourceHash === entry.sourceHash) {
						entry.status = "done";
						entry.reason = `already completed in run ${pc.priorRunId}`;
						entry.completedAt = pc.completedAt;
						await trace(p, "issues.restart_dedup_skip", {
							issueId: entry.issueId,
							priorRunId: pc.priorRunId,
							sourceHash: entry.sourceHash,
						});
					}
				}
			} else {
				await trace(p, "issues.restart_dedup_force_all", { runId: run.runId });
			}
			run.queue = queueEntries;
			run.updatedAt = run.startedAt;
			await writeState(p, st);
			try {
				const first = run.queue.find((q) => q.status === "queued");
				if (!first) {
					// All entries deduped (or queue empty) — run is terminal-complete.
					// Use guardCompleteRun to assert the all-done invariant; if it fails,
					// surface the error rather than silently marking complete.
					const { guardCompleteRun } = await import("../issues/state.ts");
					const g = guardCompleteRun(st);
					if (!g.ok) {
						throw new Error(`all-deduped completion guard failed: ${g.message}`);
					}
					await writeState(p, st);
					await setIssueFooter(undefined, ctx, st, p);
					const deduped = run.queue.filter((q) => q.status === "done" && q.reason?.startsWith("already completed in run")).length;
					ctx.ui.notify(`Issue run ${run.runId}: no issues to activate (${deduped} deduped from prior runs). Run complete.`, "info");
					return;
				}
				const source = v.issues.find((i) => i.id === first.issueId)!;
				await activateIssueLocked(p, ctx, st, run.runId, source);
				await writeState(p, st);
				await setIssueFooter(undefined, ctx, st, p);
				const deduped = run.queue.filter((q) => q.status === "done" && q.reason?.startsWith("already completed in run")).length;
				const dedupNote = deduped > 0 ? `; ${deduped} deduped from prior runs` : "";
				ctx.ui.notify(`Issue run ${run.runId} started: ${run.queue.length} queued; "${first.issueId}" active${advancementMode === "manual" ? "; advancement: manual" : ""}${dedupNote}${forceAll ? "; --force-all" : ""}.`, "info");
			} catch (err: unknown) {
				const st2 = await readState(p, ctx.cwd);
				const r2 = getIssueRun(st2);
				r2.status = "paused";
				r2.updatedAt = new Date().toISOString();
				await writeState(p, st2);
				await setIssueFooter(undefined, ctx, st2, p);
				ctx.ui.notify(`start failed during activation: ${err instanceof Error ? err.message : String(err)} — run paused durably.`, "error");
			}
		});
		return;
	}

	if (sub === "pause") {
		await withLock(p, async () => {
			const st = await readState(p, ctx.cwd);
			const run = getIssueRun(st);
			const g = guardPauseRun(st);
			if (!g.ok) {
				ctx.ui.notify(`pause refused: ${g.message}`, "warning");
				return;
			}
			await writeState(p, st);
			await setIssueFooter(undefined, ctx, st, p);
			ctx.ui.notify(`Issue run paused${run.activeIssueId ? ` (active issue ${run.activeIssueId} preserved)` : ""}.`, "info");
		});
		return;
	}

	if (sub === "resume") {
		await withLock(p, async () => {
			const st = await readState(p, ctx.cwd);
			const run = getIssueRun(st);
			// advancement-mode: resume ALSO releases the manual wait (waiting-manual marker with
			// status still "running"); guardResumeRun's paused leg stays untouched.
			if (run.advancement === "waiting-manual") {
				if (run.status !== "running") {
					ctx.ui.notify(`resume refused: run is "${run.status}" (manual wait requires a running run)`, "warning");
					return;
				}
				if (run.activeIssueId || !run.queue.some((q) => q.status === "queued")) {
					ctx.ui.notify(`resume refused: nothing queued to advance (manual wait inconsistent)`, "warning");
					return;
				}
				delete run.advancement;
				run.updatedAt = new Date().toISOString();
				try {
					const { advanceNextIssueLocked } = await import("../issues/controller.ts");
					await advanceNextIssueLocked(p, ctx, st);
					await writeState(p, st);
					await setIssueFooter(undefined, ctx, st, p);
					const act = getIssueRun(st);
					ctx.ui.notify(act.activeIssueId ? `Manual wait released; "${act.activeIssueId}" active.` : "Manual wait released.", "info");
				} catch (err: unknown) {
					const st2 = await readState(p, ctx.cwd);
					const r2 = getIssueRun(st2);
					r2.advancement = "waiting-manual";
					r2.updatedAt = new Date().toISOString();
					await writeState(p, st2);
					ctx.ui.notify(`resume advanced to activation but it failed: ${err instanceof Error ? err.message : String(err)} — manual wait retained.`, "error");
				}
				return;
			}
			const g = guardResumeRun(st);
			if (!g.ok) {
				ctx.ui.notify(`resume refused: ${g.message}`, "warning");
				return;
			}
			await writeState(p, st);
			// Phase-3b fix (P0-B): after the human disposition flow (blocked → abandon → resume)
			// the run is running with no active issue — activate the next queued issue inside the
			// held lock so the sequential auto-run continues without another manual command.
			if (!run.activeIssueId && run.queue.some((q) => q.status === "queued")) {
				try {
					const { advanceNextIssueLocked } = await import("../issues/controller.ts");
					await advanceNextIssueLocked(p, ctx, st);
					await writeState(p, st);
					await setIssueFooter(undefined, ctx, st, p);
					const act = getIssueRun(st);
					ctx.ui.notify(act.activeIssueId ? `Issue run resumed; "${act.activeIssueId}" active.` : "Issue run resumed.", "info");
					return;
				} catch (err: unknown) {
					const st2 = await readState(p, ctx.cwd);
					const r2 = getIssueRun(st2);
					r2.status = "paused";
					r2.updatedAt = new Date().toISOString();
					await writeState(p, st2);
					await setIssueFooter(undefined, ctx, st2, p);
					ctx.ui.notify(`resume advanced to activation but it failed: ${err instanceof Error ? err.message : String(err)} — run paused durably.`, "error");
					return;
				}
			}
			// exhausted-notice (2026-10-01): post-disposition resume with NOTHING queued — the
			// exhausted branch of advanceNextIssueLocked owns completion (all-done → complete +
			// completion notice; blocked-remnant → the exactly-once exhausted notice). Without
			// this leg the resume silently no-ops on an exhausted queue.
			if (!run.activeIssueId) {
				const { advanceNextIssueLocked } = await import("../issues/controller.ts");
				await advanceNextIssueLocked(p, ctx, st);
				await writeState(p, st);
				await setIssueFooter(undefined, ctx, st, p);
				ctx.ui.notify(`Issue run resumed.`, "info");
				return;
			}
			await setIssueFooter(undefined, ctx, st, p);
			ctx.ui.notify(`Issue run resumed.`, "info");
		});
		return;
	}

	if (sub === "abandon") {
		const issueId = rest.shift();
		const reason = rest.join(" ").trim();
		await withLock(p, async () => {
			if (!issueId || !reason) {
				ctx.ui.notify(`abandon requires an issue id and an explicit human reason. ${USAGE}`, "warning");
				return;
			}
			const st = await readState(p, ctx.cwd);
			const run = getIssueRun(st);
			const entry = run.queue.find((q) => q.issueId === issueId);
			if (!entry || entry.status !== "blocked" && entry.status !== "failed") {
				ctx.ui.notify(`abandon refused: issue "${issueId}" is not in a terminal-unsuccessful state.`, "warning");
				return;
			}
			// controller-only goal detach/clear (fenced routes refuse this goal; the controller
			// uses the core directly with controller provenance)
			if (entry.goalId) {
				await fenceActiveLinkedGoal(p, ctx, st, "abandon");
			}
			entry.status = "cancelled";
			entry.reason = reason;
			entry.completedAt = new Date().toISOString();
			if (run.activeIssueId === issueId) run.activeIssueId = undefined;
			run.updatedAt = entry.completedAt;
			await writeState(p, st);
			await setIssueFooter(undefined, ctx, st, p);
			ctx.ui.notify(`Issue "${issueId}" cancelled (abandoned): ${reason}. Run remains paused for human disposition.`, "info");
		});
		return;
	}

	if (sub === "stop") {
		await withLock(p, async () => {
			const st = await readState(p, ctx.cwd);
			const run = getIssueRun(st);
			if (run.status === "complete" || run.status === "stopped" || run.status === "inactive") {
				// stop is also the cross-run auto-continue kill-switch, even if the current
				// run already reached a terminal state.
				run.autoContinueDisabled = true;
				run.updatedAt = new Date().toISOString();
				await writeState(p, st);
				ctx.ui.notify(`stop: run is already "${run.status}"; auto-continue disabled until explicit start.`, "info");
				return;
			}
			// detach/clear the linked goal (controller-only), NEVER cancel the child task
			if (run.activeIssueId) {
				const entry = run.queue.find((q) => q.issueId === run.activeIssueId);
				if (entry?.goalId) await fenceActiveLinkedGoal(p, ctx, st, "stop");
				if (entry && (entry.status === "active")) {
					entry.status = "cancelled";
					entry.reason = "run stopped by human";
					entry.completedAt = new Date().toISOString();
				}
				run.activeIssueId = undefined;
			}
			run.status = "stopped";
			run.autoContinueDisabled = true;
			run.updatedAt = new Date().toISOString();
			await writeState(p, st);
			await setIssueFooter(undefined, ctx, st, p);
			ctx.ui.notify(`Issue run stopped. Any remaining child task continues outside the issue run.`, "info");
		});
		return;
	}

	ctx.ui.notify(`Unknown /swarm issues subcommand: ${sub || "(none)"}\n${USAGE}`, "warning");
}
