import type { Component, TUI } from "@earendil-works/pi-tui";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { expected, logSwarmError } from "../errorlog.ts";
import { readState, readTaskState, taskPaths } from "../state.ts";
import type { Paths, TaskPaths, TaskState } from "../types.ts";
import { humanAge } from "../utils.ts";
import { buildAttentionItems } from "./collectors.ts";
import { sanitizeUntrustedText } from "./formatting.ts";
import type { PickerEntry } from "./types.ts";

export class PickerDialog implements Component {
	private selected = 0;
	private filter = "";
	private filterMode = false;
	private help = false;
	private tui: TUI;
	private theme: any;
	private entries: PickerEntry[];
	private done: (v: unknown) => void;

	constructor(tui: TUI, theme: any, entries: PickerEntry[], done: (v: unknown) => void) {
		this.tui = tui;
		this.theme = theme;
		this.entries = entries;
		this.done = done;
	}

	private fg(c: string, s: string): string {
		try {
			return this.theme.fg(c, s);
		} catch (err: any) {
			expected("theme_fg_failed", err);
			return s;
		}
	}

	private bg(c: string, s: string): string {
		try {
			return this.theme.bg(c, s);
		} catch (err: any) {
			expected("theme_bg_failed", err);
			return s;
		}
	}

	private row(inner: string): string {
		return this.fg("border", "│ ") + inner + this.fg("border", " │");
	}

	private pad(s: string, w: number): string {
		const vw = visibleWidth(s);
		return vw > w ? truncateToWidth(s, Math.max(0, w)) : s + " ".repeat(Math.max(0, w - vw));
	}

	private current(): PickerEntry[] {
		const f = this.filter.trim().toLowerCase();
		return this.entries.filter((e) => !f || `${e.taskId} ${e.title} ${e.status}`.toLowerCase().includes(f));
	}

	handleInput(data: string): void {
		if (this.help) {
			this.help = false;
			this.tui.requestRender();
			return;
		}
		if (this.filterMode) {
			if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter)) {
				this.filterMode = false;
				this.tui.requestRender();
				return;
			}
			if (matchesKey(data, Key.backspace)) {
				this.filter = this.filter.slice(0, -1);
				this.selected = 0;
				this.tui.requestRender();
				return;
			}
			if (data.length === 1 && data.charCodeAt(0) >= 32) {
				this.filter += data;
				this.selected = 0;
				this.tui.requestRender();
				return;
			}
			return;
		}
		const vis = this.current();
		if (matchesKey(data, Key.escape) || data === "q") {
			this.done(undefined);
			return;
		}
		if (data === "/") {
			this.filterMode = true;
			this.filter = "";
			this.tui.requestRender();
			return;
		}
		if (data === "?") {
			this.help = true;
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.up) || data === "k") {
			if (vis.length) this.selected = (this.selected - 1 + vis.length) % vis.length;
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.down) || data === "j") {
			if (vis.length) this.selected = (this.selected + 1) % vis.length;
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.enter)) {
			this.done(vis[this.selected]?.taskId);
			return;
		}
	}

	invalidate(): void {
		/* no-op */
	}

	dispose(): void {
		/* no timers */
	}

	render(width: number): string[] {
		const W = Math.max(40, width);
		if (this.help) return this.renderHelp(W);
		const innerW = W - 4;
		const out: string[] = [];
		const title = " swarm flow picker ";
		out.push(
			this.fg("border", "╭─") +
				this.fg("accent", title) +
				this.fg("border", "─".repeat(Math.max(1, W - 3 - visibleWidth(title))) + "╮"),
		);
		const header = `${this.fg("dim", "choose a task")} ${this.filter ? this.fg("accent", `· /${this.filter}${this.filterMode ? "▏" : ""}`) : ""}`;
		out.push(this.row(this.pad(header, innerW)));
		const vis = this.current();
		if (!vis.length) {
			out.push(this.row(this.pad(this.fg("muted", this.filter ? `no tasks match "${this.filter}"` : "no tasks yet"), innerW)));
		} else {
			const limit = 12;
			const sel = Math.min(this.selected, vis.length - 1);
			let start = 0;
			if (sel >= limit) start = sel - limit + 1;
			if (start > 0) out.push(this.row(this.pad(this.fg("muted", `  ↑ +${start} earlier`), innerW)));
			for (let i = start; i < Math.min(vis.length, start + limit); i++) {
				const entry = vis[i];
				const badge =
					entry.attentionCount > 0 ? this.fg(entry.priority === 0 ? "error" : "warning", ` !${entry.attentionCount}`) : "";
				const line = `${String(entry.index).padStart(2)}  ${entry.taskId.padEnd(38)} ${entry.status.padEnd(11)} ${humanAge(entry.updatedAt).padStart(4)}${badge ? `  ${badge}` : ""}${entry.title ? `  ${truncateToWidth(entry.title, 40)}` : ""}`;
				const content = i === this.selected ? this.bg("selectedBg", this.pad(line, innerW)) : this.pad(line, innerW);
				out.push(this.row(content));
			}
			if (start + limit < vis.length) {
				out.push(this.row(this.pad(this.fg("muted", `  ↓ +${vis.length - start - limit} more`), innerW)));
			}
		}
		out.push(this.row(this.pad(this.fg("dim", "↑↓/jk nav · Enter open · / filter · Esc close"), innerW)));
		out.push(this.fg("border", "╰") + this.fg("border", "─".repeat(Math.max(0, W - 2)) + "╯"));
		return out;
	}

	private renderHelp(W: number): string[] {
		const innerW = W - 4;
		const out: string[] = [];
		out.push(
			this.fg("border", "╭─") +
				this.fg("accent", " flow picker help ") +
				this.fg("border", "─".repeat(Math.max(1, W - 3 - visibleWidth(" flow picker help "))) + "╮"),
		);
		for (const [k, v] of [
			["navigate", "↑↓ or j / k"],
			["open", "Enter"],
			["filter", "/"],
			["close", "Esc or q"],
			["help", "?"],
		] as Array<[string, string]>) {
			out.push(this.row(this.pad(`${this.fg("accent", k)} · ${this.fg("dim", v)}`, innerW)));
		}
		out.push(this.fg("border", "╰") + this.fg("border", "─".repeat(Math.max(0, W - 2)) + "╯"));
		return out;
	}
}

export async function listTaskSummaries(p: Paths): Promise<PickerEntry[]> {
	const out: PickerEntry[] = [];
	let dirs: string[] = [];
	try {
		dirs = await readdir(p.tasksDir);
	} catch (err: any) {
		if (err?.code !== "ENOENT") {
			await logSwarmError(p, "flow-dialog", "picker.readdir_failed", err);
		}
		return out;
	}
	for (const dir of dirs.sort()) {
		const tp = taskPaths(p, dir);
		if (!existsSync(tp.taskJson)) continue;
		try {
			const task = await readTaskState(tp.taskJson);
			out.push({
				index: 0,
				taskId: task.taskId,
				title: sanitizeUntrustedText(task.title),
				status: task.status,
				updatedAt: task.updatedAt,
				attentionCount: 0,
				priority: 4,
			});
		} catch (err: any) {
			if (err?.code !== "ENOENT") {
				await logSwarmError(p, "flow-dialog", "picker.task_unreadable", err, { taskId: dir });
			}
		}
	}
	out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.taskId.localeCompare(b.taskId));
	return out.map((item, i) => ({ ...item, index: i + 1 }));
}

export async function resolveTaskRefLocal(
	p: Paths,
	ref: string,
): Promise<{ hit?: { task: TaskState; tp: TaskPaths; index: number }; list: PickerEntry[]; missReason?: string; ambiguous?: string[] }> {
	const list = await listTaskSummaries(p);
	const trim = ref.trim();
	if (!trim) return { list, missReason: "no task reference given" };
	if (/^\d+$/.test(trim)) {
		const idx = parseInt(trim, 10);
		const hit = list[idx - 1];
		if (!hit) return { list, missReason: `no task at index ${idx} (have 1..${list.length})` };
		const tp = taskPaths(p, hit.taskId);
		return { hit: { task: await readTaskState(tp.taskJson), tp, index: hit.index }, list };
	}
	const norm = trim.toLowerCase();
	const exact = list.find((t) => t.taskId === trim || t.taskId.toLowerCase() === norm);
	if (exact) {
		const tp = taskPaths(p, exact.taskId);
		return { hit: { task: await readTaskState(tp.taskJson), tp, index: exact.index }, list };
	}
	const sub = list.filter((t) => t.taskId.includes(trim) || t.taskId.toLowerCase().includes(norm));
	if (sub.length === 1) {
		const tp = taskPaths(p, sub[0].taskId);
		return { hit: { task: await readTaskState(tp.taskJson), tp, index: sub[0].index }, list };
	}
	if (sub.length > 1) return { list, ambiguous: sub.map((t) => t.taskId) };
	return { list, missReason: `no task matches "${trim}"` };
}

export async function buildPickerEntries(p: Paths, cwd: string): Promise<PickerEntry[]> {
	const list = await listTaskSummaries(p);
	if (!list.length) return [];
	const st = await readState(p, cwd);
	const out: PickerEntry[] = [];
	for (const item of list) {
		const tp = taskPaths(p, item.taskId);
		if (!existsSync(tp.taskJson)) continue;
		try {
			const task = await readTaskState(tp.taskJson);
			const attention = buildAttentionItems(task, tp, st);
			const rank =
				attention.some((a) => a.severity === "act" && a.kind === "node") ||
				Object.values(task.nodes).some((n) => n.status === "failed" || n.status === "blocked")
					? 0
					: Object.values(task.nodes).some((n) => n.staleAt) || attention.some((a) => a.kind !== "node" && a.severity !== "info")
						? 1
						: task.status === "in_progress" ||
							  Object.values(task.nodes).some((n) => n.status === "assigned" || n.status === "in_progress")
							? 2
							: task.status === "ready" || Object.values(task.nodes).some((n) => n.status === "ready")
								? 3
								: 4;
			out.push({ ...item, attentionCount: attention.length, priority: rank });
		} catch (err: any) {
			await logSwarmError(p, "flow-dialog", "attention.task_unreadable", err, { taskId: item.taskId });
			out.push({ ...item, attentionCount: 0, priority: 4 });
		}
	}
	return out.sort(
		(a, b) =>
			a.priority - b.priority ||
			b.attentionCount - a.attentionCount ||
			b.updatedAt.localeCompare(a.updatedAt) ||
			a.taskId.localeCompare(b.taskId),
	);
}
