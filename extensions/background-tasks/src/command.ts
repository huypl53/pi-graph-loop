// background-tasks/command.ts — the `/bg` slash command (live task list + stop/kill + prune) (design §11.4, §6).
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readState, paths } from "./state.ts";
import { belongsToSession, currentSessionId, elapsedMmSs, humanAge, safeId } from "./utils.ts";
import { killTask, pruneTerminal, reconcile } from "./lifecycle.ts";
import { openBgDialog } from "./dialog.ts";
import type { BackgroundSettings, BackgroundTask, BgStatus } from "./types.ts";

const ICON: Record<BgStatus, string> = { pending: "…", running: "⏳", done: "✓", failed: "✗", killed: "◔", unknown: "?" };
const FILTERS = ["running", "done", "failed", "killed", "pending", "unknown", "all", "on", "off", "stop", "kill", "prune"];

// Resolve a task by exact id, label (case-insensitive), safeId(label), or id prefix.
function resolveTask(tasks: BackgroundTask[], target: string): BackgroundTask | undefined {
	const t = target.trim();
	if (!t) return undefined;
	return (
		tasks.find((x) => x.taskId === t) ||
		tasks.find((x) => x.label && x.label.toLowerCase() === t.toLowerCase()) ||
		tasks.find((x) => x.label && safeId(x.label) === safeId(t)) ||
		tasks.find((x) => x.taskId.startsWith(t))
	);
}

export function registerCommand(pi: ExtensionAPI, settings: BackgroundSettings) {
	// Shift+Ctrl+B opens the rich overlay dialog from anywhere in the TUI.
	// (Plain Ctrl+B is the editor's cursor-left / readline backward-char, so we use the
	// shifted combo — distinct from ctrl+b and matching pi's shift+ctrl+p / shift+ctrl+o convention.)
	try {
		pi.registerShortcut("shift+ctrl+b", {
			description: "Open the background-tasks dialog",
			handler: (ctx) => { void openBgDialog(ctx, settings, ctx.cwd); },
		});
	} catch {}

	pi.registerCommand("bg", {
		description: "List background tasks for THIS session (/bg all for every session); /bg stop|kill <id>; /bg off hides the widget.",
		getArgumentCompletions: (prefix: string) => {
			const filtered = FILTERS.filter((f) => f.startsWith(prefix));
			return filtered.length > 0 ? filtered.map((f) => ({ value: f, label: f })) : null;
		},
		handler: async (args: string, ctx: any) => {
			if (!ctx.hasUI) return;
			const raw = (args || "").trim();
			const parts = raw.split(/\s+/);
			const sub = (parts[0] || "").toLowerCase();
			const cwd = ctx.cwd;
			const p = paths(cwd);

			if (sub === "off") {
				ctx.ui.setWidget("bg-tasks", undefined);
				ctx.ui.setStatus("bg-tasks", undefined);
				ctx.ui.notify("background-tasks: widget hidden for this session (/bg on to show)", "info");
				return;
			}
			if (sub === "on") {
				ctx.ui.notify("background-tasks: widget re-enabled", "info");
				return;
			}

			// No args → open the rich overlay dialog (Shift+Ctrl+B also opens it).
			if (!sub) { await openBgDialog(ctx, settings, cwd); return; }

			// /bg stop|kill <id|label> — user closes a task; the agent is then nudged with the killed result.
			if (sub === "stop" || sub === "kill") {
				const target = parts.slice(1).join(" ").trim();
				if (!target) {
					ctx.ui.notify("usage: /bg stop <taskId|label>  (use /bg to list ids)", "warning");
					return;
				}
				await reconcile(cwd, settings);
				const st = await readState(p, cwd);
				const t = resolveTask(Object.values(st.tasks), target);
				if (!t) {
					ctx.ui.notify(`background-tasks: no task matching "${target}"`, "warning");
					return;
				}
				if (t.status !== "running" && t.status !== "pending") {
					ctx.ui.notify(`background-tasks: ${t.label || t.taskId} already ${t.status} (nothing to stop)`, "info");
					return;
				}
				const signal = sub === "kill" ? "SIGKILL" : "SIGTERM";
				try {
					const stopped = await killTask(cwd, t.taskId, signal, settings.stopGraceMs);
					ctx.ui.notify(
						`background-tasks: stopped ${stopped.label || stopped.taskId} (signal ${signal}) — agent notified.\n` +
							`status: ${stopped.status} | exit: ${stopped.exitCode ?? "-"} | out: ${stopped.logOut}`,
						"info",
					);
				} catch (err: any) {
					ctx.ui.notify(`background-tasks: failed to stop ${t.label || t.taskId}: ${String((err && err.message) || err)}`, "warning");
				}
				return;
			}

			// /bg prune [all] — EXPLICIT, opt-in reclamation of finished/killed tasks.
			// Removes terminal tasks (and their log/marker files) from state. Live tasks are untouched.
			// This is the ONLY path that deletes exited tasks; default views just hide them, never reclaim.
			if (sub === "prune") {
				const allSessions = (parts[1] || "").toLowerCase() === "all";
				const sid = currentSessionId(ctx);
				await reconcile(cwd, settings);
				const res = await pruneTerminal(cwd, { allSessions, sid, scopeBySession: settings.scopeBySession });
				if (res.removed === 0) {
					ctx.ui.notify(`background-tasks: nothing to prune${allSessions ? " (all sessions)" : ` (session ${sid ?? "?"})`}.`, "info");
				} else {
					ctx.ui.notify(
						`background-tasks: pruned ${res.removed} terminal task(s)${allSessions ? " (all sessions)" : ` (session ${sid ?? "?"})`} — freed ${res.filesRemoved} file(s).`,
						"info",
					);
				}
				return;
			}
			const showAllSessions = sub === "all";
			const sid = currentSessionId(ctx);
			await reconcile(cwd, settings);
			const st = await readState(p, cwd);
			const scope = settings.scopeBySession && !showAllSessions;
			let tasks = Object.values(st.tasks)
				.filter((t) => belongsToSession(t, sid, scope))
				.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
			if (sub && !showAllSessions) tasks = tasks.filter((t) => t.status === (sub as BgStatus));
			if (tasks.length === 0) {
				const which = showAllSessions ? "" : " in this session";
				ctx.ui.notify(
					`background-tasks: no${sub && !showAllSessions ? ` ${sub}` : ""}${which} tasks${showAllSessions ? "" : " (/bg all for every session)"}`,
					"info",
				);
				return;
			}
			const scopeNote = showAllSessions ? "all sessions" : `session ${sid ?? "?"}`;
			const rows = tasks.map((t) => {
				const name = t.label || t.command;
				const age = t.status === "running" ? elapsedMmSs(t.startedAt) : humanAge(t.endedAt);
				const exit = t.exitCode === null || t.exitCode === undefined ? "-" : String(t.exitCode);
				return `${ICON[t.status]} ${name}  [${t.status}] ${age} exit=${exit} pid=${t.pid ?? "-"}`;
			});
			const choice = await ctx.ui.select(`Background tasks (${tasks.length}, ${scopeNote})`, rows);
			if (choice !== undefined) {
				const idx = rows.indexOf(choice);
				const t = tasks[idx];
				if (t) {
					const stopHint = t.status === "running" || t.status === "pending" ? `\nstop: /bg stop ${t.taskId}` : "";
					ctx.ui.notify(
						`${t.label || t.taskId}\nstatus: ${t.status}\nexit: ${t.exitCode ?? "-"}\npid: ${t.pid ?? "-"}\nout: ${t.logOut}\nerr: ${t.logErr}${stopHint}`,
						"info",
					);
				}
			}
		},
	});
}
