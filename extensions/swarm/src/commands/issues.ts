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
import { readState, withLock, writeState } from "../state.ts";
import { validateIssuesSource, classifyDocPath } from "../issues/source.ts";
import { captureIssueSnapshot, sourceHashOf } from "../issues/snapshot.ts";
import {
	getIssueRun, guardActivateIssue, applyActivateIssue, guardPauseRun, guardResumeRun,
	reconcileIssueRun, type IssueQueueEntry,
} from "../issues/state.ts";
import { activateIssueLocked, safeIdleBlockers, fenceActiveLinkedGoal } from "../issues/controller.ts";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const USAGE =
	"Usage: /swarm issues validate | status | start | pause | resume | abandon <issue-id> <reason...> | stop";

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
		const done = run.queue.filter((q) => q.status === "done").length;
		lines.push(`  queue: ${run.queue.length} (done ${done}, queued ${run.queue.filter((q) => q.status === "queued").length})`);
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
			const run = getIssueRun(st);
			run.status = "running";
			run.runId = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
			run.startedAt = new Date().toISOString();
			run.queue = v.issues.map<IssueQueueEntry>((i) => ({ issueId: i.id, title: i.title, sourceHash: sourceHashOf(i), status: "queued" }));
			run.updatedAt = run.startedAt;
			await writeState(p, st);
			try {
				const first = run.queue.find((q) => q.status === "queued");
				if (!first) throw new Error("empty queue");
				const source = v.issues.find((i) => i.id === first.issueId)!;
				await activateIssueLocked(p, ctx, st, run.runId, source);
				await writeState(p, st);
				ctx.ui.notify(`Issue run ${run.runId} started: ${run.queue.length} queued; "${first.issueId}" active.`, "info");
			} catch (err: unknown) {
				const st2 = await readState(p, ctx.cwd);
				const r2 = getIssueRun(st2);
				r2.status = "paused";
				r2.updatedAt = new Date().toISOString();
				await writeState(p, st2);
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
			ctx.ui.notify(`Issue run paused${run.activeIssueId ? ` (active issue ${run.activeIssueId} preserved)` : ""}.`, "info");
		});
		return;
	}

	if (sub === "resume") {
		await withLock(p, async () => {
			const st = await readState(p, ctx.cwd);
			const run = getIssueRun(st);
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
					const act = getIssueRun(st);
					ctx.ui.notify(act.activeIssueId ? `Issue run resumed; "${act.activeIssueId}" active.` : "Issue run resumed.", "info");
					return;
				} catch (err: unknown) {
					const st2 = await readState(p, ctx.cwd);
					const r2 = getIssueRun(st2);
					r2.status = "paused";
					r2.updatedAt = new Date().toISOString();
					await writeState(p, st2);
					ctx.ui.notify(`resume advanced to activation but it failed: ${err instanceof Error ? err.message : String(err)} — run paused durably.`, "error");
					return;
				}
			}
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
			ctx.ui.notify(`Issue "${issueId}" cancelled (abandoned): ${reason}. Run remains paused for human disposition.`, "info");
		});
		return;
	}

	if (sub === "stop") {
		await withLock(p, async () => {
			const st = await readState(p, ctx.cwd);
			const run = getIssueRun(st);
			if (run.status === "complete" || run.status === "stopped" || run.status === "inactive") {
				ctx.ui.notify(`stop: run is already "${run.status}".`, "info");
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
			run.updatedAt = new Date().toISOString();
			await writeState(p, st);
			ctx.ui.notify(`Issue run stopped. Any remaining child task continues outside the issue run.`, "info");
		});
		return;
	}

	ctx.ui.notify(`Unknown /swarm issues subcommand: ${sub || "(none)"}\n${USAGE}`, "warning");
}
