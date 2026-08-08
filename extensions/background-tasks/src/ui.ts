// background-tasks/ui.ts — live user-facing TUI (design §11).
// Below-editor widget + footer status line + finish/fail notifications + AGENT NUDGE on completion.
// Every ctx.ui.* call is guarded by the caller (hooks.ts) on ctx.hasUI / ctx.mode === "tui".
import { Container, Text } from "@earendil-works/pi-tui";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { paths, readState } from "./state.ts";
import { belongsToSession, currentSessionId, elapsedMmSs, trace, truncateToWidth, visibleWidth } from "./utils.ts";
import type { BackgroundSettings, BackgroundState, BackgroundTask, BgStatus } from "./types.ts";

const ICON: Record<BgStatus, string> = {
	pending: "…",
	running: "⏳",
	done: "✓",
	failed: "✗",
	killed: "◔",
	unknown: "?",
};

function colorFor(status: BgStatus): string {
	switch (status) {
		case "running":
			return "accent";
		case "done":
			return "success";
		case "failed":
			return "error";
		default:
			return "muted"; // killed / unknown / pending
	}
}

export function summaryLine(st: BackgroundState): string {
	const tasks = Object.values(st.tasks);
	const running = tasks.filter((t) => t.status === "running" || t.status === "pending").length;
	const done = tasks.filter((t) => t.status === "done").length;
	const failed = tasks.filter((t) => t.status === "failed").length;
	if (tasks.length === 0) return "";
	// Only show "N running" while any are live; once everything is terminal the footer leads with
	// the finished counts instead of a stale "0 running" (killed/unknown-only states clear it).
	const parts: string[] = [];
	if (running) parts.push(`${running} running`);
	if (done) parts.push(`${done} done`);
	if (failed) parts.push(`${failed} failed`);
	return parts.length ? `bg: ${parts.join(", ")}` : "";
}

// Best-effort last line of the combined output (cheap tail of the out log).
async function lastLine(cwd: string, task: BackgroundTask): Promise<string> {
	const p = paths(cwd);
	const file = join(cwd, task.logOut);
	if (!existsSync(file)) return "";
	try {
		const tail = await readFile(file, { encoding: "utf8", flag: "r" });
		const lines = tail.split("\n").filter((l) => l.trim() && !l.startsWith("[bg-task exited"));
		return (lines[lines.length - 1] || "").trim();
	} catch {
		return "";
	}
}

interface RowSpec {
	text: string;
	color: string;
	dim: string;
}

function isTerminal(s: BgStatus): boolean {
	return s === "done" || s === "failed" || s === "killed" || s === "unknown";
}

// Build the agent-facing nudge body for one or more newly-terminal tasks. Combined into a single
// message per tick so we only wake the agent once (one triggerTurn) for a batch of completions.
function formatNudge(tasks: BackgroundTask[]): string {
	const lines = tasks.map((t) => {
		const name = t.label || t.taskId;
		const ec = t.exitCode === null || t.exitCode === undefined ? "?" : String(t.exitCode);
		return `- "${name}" (${t.taskId}): ${t.status} (exit ${ec})`;
	});
	const header =
		tasks.length === 1
			? `[background-tasks] Background task finished: ${tasks[0].label || tasks[0].taskId} — ${tasks[0].status} (exit ${tasks[0].exitCode ?? "?"}).`
			: `[background-tasks] ${tasks.length} background tasks finished:`;
	const hint =
		tasks.length === 1
			? `Inspect output with background_output(taskId="${tasks[0].taskId}") or read ${tasks[0].logOut}. Act on the result if needed.`
			: `Inspect each with background_output(taskId=...) or read its logOut path. Act on the results if needed.`;
	return tasks.length === 1 ? [header, "", hint].join("\n") : [header, ...lines, "", hint].join("\n");
}

export async function renderUi(pi: ExtensionAPI, ctx: any, settings: BackgroundSettings, cwd: string): Promise<void> {
	const p = paths(cwd);
	// Lock-free read: state.json is atomic-written (temp+rename), so this always returns a complete snapshot.
	const st = await readState(p, cwd);
	const sid = currentSessionId(ctx);
	const scope = settings.scopeBySession;
	// Session-scoped view: only this chat session's tasks are rendered/notified/nudged. Legacy tasks
	// with no spawnedBySession stay visible everywhere (belongsToSession fallback) so nothing vanishes.
	const tasks = (scope ? Object.values(st.tasks).filter((t) => belongsToSession(t, sid, true)) : Object.values(st.tasks)).sort(
		(a, b) => (a.createdAt < b.createdAt ? 1 : -1),
	); // newest first

	let stChanged = false;

	// --- human toast: one notify per running->terminal transition (this session only; deduped via persisted lastNotifiedStatus) ---
	for (const t of tasks) {
		if (isTerminal(t.status) && t.lastNotifiedStatus !== t.status) {
			const name = t.label || t.taskId;
			if (t.status === "done") ctx.ui.notify(`bg: ${name} finished (exit 0)`, "info");
			else if (t.status === "failed") ctx.ui.notify(`bg: ${name} FAILED (exit ${t.exitCode ?? "?"})`, "warning");
			else if (t.status === "killed") ctx.ui.notify(`bg: ${name} killed`, "warning");
			else ctx.ui.notify(`bg: ${name} ended (status unknown)`, "info");
			t.lastNotifiedStatus = t.status;
			stChanged = true;
		}
	}

	// --- AGENT NUDGE: wake the agent once when its tasks finish (the async counterpart to background_wait).
	// Mirrors the swarm orchestrator pump: TUI-only (no live agent loop in print/rpc/json), gated on idle
	// so we never interrupt a streaming turn, deferred (not marked nudged) while busy so the next tick retries.
	const toNudge = tasks.filter((t) => isTerminal(t.status) && t.agentNudgedStatus !== t.status);
	if (toNudge.length > 0) {
		let idle = false;
		try {
			idle = ctx.mode === "tui" && ctx.isIdle();
		} catch {}
		if (idle) {
			try {
				pi.sendUserMessage(formatNudge(toNudge));
				for (const t of toNudge) t.agentNudgedStatus = t.status;
				stChanged = true;
				await trace(p.events, "task.nudge.sent", { ids: toNudge.map((t) => t.taskId), sid }).catch(() => {});
			} catch (err: any) {
				const msg = String((err && err.message) || err);
				await trace(p.events, "task.nudge.send_error", { error: msg, ids: toNudge.map((t) => t.taskId) }).catch(() => {});
			}
		} else {
			// busy (or non-TUI): defer — leave agentNudgedStatus unset so a later idle tick retries.
			await trace(p.events, "task.nudge.deferred", { count: toNudge.length, idle, mode: ctx.mode }).catch(() => {});
		}
	}

	if (stChanged) {
		// Persist dedup flags best-effort (separate lock; never block the tick on it).
		try {
			const { withLock, writeState } = await import("./state.ts");
			await withLock(p, async () => {
				const cur = await readState(p, cwd);
				for (const t of tasks) {
					if (!cur.tasks[t.taskId]) continue;
					if (t.lastNotifiedStatus !== undefined) cur.tasks[t.taskId].lastNotifiedStatus = t.lastNotifiedStatus;
					if (t.agentNudgedStatus !== undefined) cur.tasks[t.taskId].agentNudgedStatus = t.agentNudgedStatus;
				}
				await writeState(p, cur);
			});
		} catch {}
	}

	// --- footer status line (session-scoped counts; reflects live + recently-finished) ---
	const scopedState: BackgroundState = { ...st, tasks: Object.fromEntries(tasks.map((t) => [t.taskId, t])) };
	const summary = summaryLine(scopedState);
	ctx.ui.setStatus("bg-tasks", summary || undefined);

	// --- below-editor widget: LIVE tasks only ---
	// The persistent widget surfaces in-flight work. Finished/killed/exited tasks are deliberately
	// hidden from this DEFAULT view (they would otherwise linger forever); they remain in state for
	// inspection via the dialog (`/bg`), the footer counts, and are reclaimable explicitly with
	// `/bg prune`. Reclaim is opt-in — NEVER tied to a default flag or this default UI.
	const liveTasks = tasks.filter((t) => t.status === "running" || t.status === "pending");
	if (liveTasks.length === 0) {
		ctx.ui.setWidget("bg-tasks", undefined);
		return;
	}

	const maxRows = settings.ui.maxRows;
	const shown = liveTasks.slice(0, maxRows);
	const specs: RowSpec[] = [];
	for (const t of shown) {
		const name = t.label || t.command;
		const tail = await lastLine(cwd, t); // shown is live-only (running/pending); pending -> empty tail
		specs.push({ text: name, color: colorFor(t.status), dim: tail });
	}

	ctx.ui.setWidget(
		"bg-tasks",
		(_tui: any, theme: any) => {
			const fg = theme.fg.bind(theme);
			const c = new Container();
			// Render rows to a reasonable width; the factory receives no width, so cap each field.
			const nameW = 28;
			for (let i = 0; i < specs.length; i++) {
				const t = shown[i];
				const s = specs[i];
				const icon = fg(s.color, ICON[t.status]);
				const name = fg(s.color, truncateToWidth(s.text, nameW));
				const age = t.status === "running" ? elapsedMmSs(t.startedAt) : t.exitCode ?? "";
				const ageStr = fg("dim", t.status === "running" ? age : String(age));
				let line = `${icon} ${name}  ${ageStr}`;
				if (s.dim) line += `  ${fg("dim", truncateToWidth(s.dim, 40))}`;
				c.addChild(new Text(line, 0, 0));
			}
			if (liveTasks.length > maxRows) {
				c.addChild(new Text(fg("muted", `… +${liveTasks.length - maxRows} more  (/bg for all)`), 0, 0));
			}
			return c;
		},
		{ placement: "belowEditor" },
	);

	// Silence unused-var lint for visibleWidth (reserved for precise column math later).
	void visibleWidth;
}
