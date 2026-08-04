// background-tasks/ui.ts — live user-facing TUI (design §11).
// Below-editor widget + footer status line + finish/fail notifications. Every ctx.ui.* call is
// guarded by the caller (hooks.ts) on ctx.hasUI / ctx.mode === "tui".
import { Container, Text } from "@earendil-works/pi-tui";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { paths, readState } from "./state.ts";
import { elapsedMmSs, truncateToWidth, visibleWidth } from "./utils.ts";
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
	const parts = [`bg: ${running} running`];
	if (done) parts.push(`${done} done`);
	if (failed) parts.push(`${failed} failed`);
	return parts.join(", ");
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

export async function renderUi(ctx: any, settings: BackgroundSettings, cwd: string): Promise<void> {
	const p = paths(cwd);
	// Lock-free read: state.json is atomic-written (temp+rename), so this always returns a complete snapshot.
	const st = await readState(p, cwd);
	const tasks = Object.values(st.tasks).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)); // newest first
	const running = tasks.filter((t) => t.status === "running" || t.status === "pending");

	// --- notifications: one notify per running->terminal transition (deduped via persisted lastNotifiedStatus) ---
	let stChanged = false;
	for (const t of tasks) {
		const terminal = t.status === "done" || t.status === "failed" || t.status === "killed" || t.status === "unknown";
		if (terminal && t.lastNotifiedStatus !== t.status) {
			const name = t.label || t.taskId;
			if (t.status === "done") ctx.ui.notify(`bg: ${name} finished (exit 0)`, "info");
			else if (t.status === "failed") ctx.ui.notify(`bg: ${name} FAILED (exit ${t.exitCode ?? "?"})`, "warning");
			else if (t.status === "killed") ctx.ui.notify(`bg: ${name} killed`, "warning");
			else ctx.ui.notify(`bg: ${name} ended (status unknown)`, "info");
			t.lastNotifiedStatus = t.status;
			stChanged = true;
		}
	}
	if (stChanged) {
		// Persist dedup flags best-effort (separate lock; never block the tick on it).
		try {
			const { withLock, writeState } = await import("./state.ts");
			await withLock(p, async () => {
				const cur = await readState(p, cwd);
				for (const t of tasks) {
					if (cur.tasks[t.taskId]) cur.tasks[t.taskId].lastNotifiedStatus = t.lastNotifiedStatus;
				}
				await writeState(p, cur);
			});
		} catch {}
	}

	// --- footer status line ---
	const summary = summaryLine(st);
	ctx.ui.setStatus("bg-tasks", summary || undefined);

	// --- below-editor widget ---
	if (tasks.length === 0) {
		ctx.ui.setWidget("bg-tasks", undefined);
		return;
	}

	const maxRows = settings.ui.maxRows;
	const shown = tasks.slice(0, maxRows);
	const specs: RowSpec[] = [];
	for (const t of shown) {
		const name = t.label || t.command;
		const tail = t.status === "running" ? await lastLine(cwd, t) : "";
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
			if (tasks.length > maxRows) {
				c.addChild(new Text(fg("muted", `… +${tasks.length - maxRows} more  (/bg for all)`), 0, 0));
			}
			return c;
		},
		{ placement: "belowEditor" },
	);

	// Silence unused-var lint for visibleWidth (reserved for precise column math later).
	void visibleWidth;
}
