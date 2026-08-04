// background-tasks/command.ts — `/bg` (live task list) + `/background-tasks` (status) (design §11.4, §6).
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readState, paths } from "./state.ts";
import { elapsedMmSs, humanAge } from "./utils.ts";
import type { BackgroundSettings, BgStatus } from "./types.ts";

const ICON: Record<BgStatus, string> = { pending: "…", running: "⏳", done: "✓", failed: "✗", killed: "◔", unknown: "?" };
const FILTERS = ["running", "done", "failed", "killed", "pending", "unknown", "all", "on", "off"];

export function registerCommand(pi: ExtensionAPI, settings: BackgroundSettings) {
	pi.registerCommand("bg", {
		description: "List background tasks (optionally filter by status); /bg off hides the widget.",
		getArgumentCompletions: (prefix: string) => {
			const filtered = FILTERS.filter((f) => f.startsWith(prefix));
			return filtered.length > 0 ? filtered.map((f) => ({ value: f, label: f })) : null;
		},
		handler: async (args: string, ctx: any) => {
			if (!ctx.hasUI) return;
			const arg = (args || "").trim().toLowerCase();
			const cwd = ctx.cwd;
			const p = paths(cwd);

			if (arg === "off") {
				ctx.ui.setWidget("bg-tasks", undefined);
				ctx.ui.setStatus("bg-tasks", undefined);
				ctx.ui.notify("background-tasks: widget hidden for this session (/bg on to show)", "info");
				return;
			}
			if (arg === "on") {
				ctx.ui.notify("background-tasks: widget re-enabled", "info");
				return;
			}

			const st = await readState(p, cwd);
			let tasks = Object.values(st.tasks).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
			if (arg && arg !== "all") tasks = tasks.filter((t) => t.status === (arg as BgStatus));
			if (tasks.length === 0) {
				ctx.ui.notify(`background-tasks: no${arg && arg !== "all" ? ` ${arg}` : ""} tasks`, "info");
				return;
			}
			const rows = tasks.map((t) => {
				const name = t.label || t.command;
				const age = t.status === "running" ? elapsedMmSs(t.startedAt) : humanAge(t.endedAt);
				const exit = t.exitCode === null || t.exitCode === undefined ? "-" : String(t.exitCode);
				return `${ICON[t.status]} ${name}  [${t.status}] ${age} exit=${exit} pid=${t.pid ?? "-"}`;
			});
			const choice = await ctx.ui.select(`Background tasks (${tasks.length})`, rows);
			if (choice !== undefined) {
				const idx = rows.indexOf(choice);
				const t = tasks[idx];
				if (t) {
					ctx.ui.notify(
						`${t.label || t.taskId}\nstatus: ${t.status}\nexit: ${t.exitCode ?? "-"}\npid: ${t.pid ?? "-"}\nout: ${t.logOut}\nerr: ${t.logErr}`,
						"info",
					);
				}
			}
		},
	});

	pi.registerCommand("background-tasks", {
		description: "Show background-tasks config and counts",
		handler: async (_args: string, ctx: any) => {
			if (!ctx.hasUI) return;
			const cwd = ctx.cwd;
			const p = paths(cwd);
			const st = await readState(p, cwd);
			const tasks = Object.values(st.tasks);
			const running = tasks.filter((t) => t.status === "running" || t.status === "pending").length;
			ctx.ui.notify(
				[
					`background-tasks: ${settings.enabled ? "enabled" : "disabled"}`,
					`max concurrent: ${settings.maxConcurrent} | log cap: ${settings.logMaxBytes} bytes`,
					`kill on shutdown: ${settings.killOnShutdown ? "on" : "off"} | stop grace: ${settings.stopGraceMs}ms`,
					`ui: ${settings.ui.enabled ? "on" : "off"} (refresh ${settings.ui.refreshMs}ms, max ${settings.ui.maxRows} rows)`,
					`tasks: ${tasks.length} total, ${running} running`,
					`config: env PI_BG_TASKS* > .pi/settings.json extensions["background-tasks"] > defaults`,
				].join("\n"),
				"info",
			);
		},
	});
}
