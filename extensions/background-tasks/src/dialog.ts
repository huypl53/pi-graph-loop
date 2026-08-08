// background-tasks/dialog.ts — a proper overlay UI for background tasks.
// A bordered, color-coded, live-refreshing panel opened via /bg (no args) or Shift+Ctrl+B.
// Keyboard-driven: navigate, stop/kill, view output, refresh, toggle all-sessions, filter.
import type { Component, TUI } from "@earendil-works/pi-tui";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { paths, readState } from "./state.ts";
import { killTask, reconcile } from "./lifecycle.ts";
import { belongsToSession, currentSessionId, elapsedMmSs, humanAge } from "./utils.ts";
import type { BackgroundSettings, BackgroundTask, BgStatus } from "./types.ts";

const ICON: Record<BgStatus, string> = { pending: "…", running: "⏳", done: "✓", failed: "✗", killed: "◔", unknown: "?" };

function statusColor(s: BgStatus): string {
	switch (s) {
		case "running": return "accent";
		case "done": return "success";
		case "failed": return "error";
		case "killed": return "warning";
		default: return "muted"; // pending / unknown
	}
}

const MAX_ROWS = 14;
const FOOTER = "↑↓/jk nav · o output · s stop · K kill · a all · e exited · / filter · r refresh · ? help · esc";

export interface BgDialogOpts {
	settings: BackgroundSettings;
	cwd: string;
	ctx: any;
	initialAllSessions?: boolean;
}

export class BgDialog implements Component {
	private tui: TUI;
	private theme: any;
	private opts: BgDialogOpts;
	private done: (v: unknown) => void;

	private all: BackgroundTask[] = [];
	private selected = 0;
	private showAll: boolean;
	private showExited = false; // default view = LIVE tasks only; press 'e' to reveal finished/killed tasks
	private filter = "";
	private filterMode = false;
	private msg = "";
	private msgAt = 0;
	private help = false;

	// detail (output) sub-view
	private detailId: string | null = null;
	private detailLines: string[] = [];
	private detailScroll = 0;
	private detailFollow = true; // tail the LATEST output; cleared on scroll-up, re-armed when back at the bottom
	private lastLines: Record<string, string> = {};

	private timer: ReturnType<typeof setInterval> | undefined;

	constructor(tui: TUI, theme: any, opts: BgDialogOpts, done: (v: unknown) => void) {
		this.tui = tui;
		this.theme = theme;
		this.opts = opts;
		this.done = done;
		this.showAll = Boolean(opts.initialAllSessions);
		void this.refresh();
		this.timer = setInterval(() => { void this.refresh(); }, 1000);
	}

	private fg(c: string, s: string): string { try { return this.theme.fg(c, s); } catch { return s; } }
	private bg(c: string, s: string): string { try { return this.theme.bg(c, s); } catch { return s; } }

	private get sid(): string | undefined { return currentSessionId(this.opts.ctx); }
	private get scopeOn(): boolean { return this.opts.settings.scopeBySession && !this.showAll; }

	private visible(): BackgroundTask[] {
		let v = this.scoped();
		// Default view hides finished/killed/exited tasks (they linger forever otherwise); press 'e'.
		if (!this.showExited) v = v.filter((t) => t.status === "running" || t.status === "pending");
		const f = this.filter.trim().toLowerCase();
		if (f) v = v.filter((t) => (t.label || t.taskId || t.command).toLowerCase().includes(f) || t.taskId.toLowerCase().includes(f) || t.status.includes(f));
		return v;
	}

	// All tasks in scope (session or all-sessions), before the live/exited status filter. Used for the
	// title counts and the "N exited hidden" hint so the totals always reflect the real scoped set.
	private scoped(): BackgroundTask[] {
		const sid = this.sid;
		return this.all
			.filter((t) => belongsToSession(t, sid, this.scopeOn))
			.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
	}

	private flash(m: string) { this.msg = m; this.msgAt = Date.now(); }

	private async refresh() {
		try {
			await reconcile(this.opts.cwd, this.opts.settings);
			const st = await readState(paths(this.opts.cwd), this.opts.cwd);
			this.all = Object.values(st.tasks);
			const vis = this.visible();
			if (this.selected > vis.length - 1) this.selected = Math.max(0, vis.length - 1);
			// Preload the last output line for running tasks (shown in the list) — cheap, bounded.
			await Promise.all(
				vis.filter((t) => t.status === "running" || t.status === "pending").map(async (t) => {
					const f = join(this.opts.cwd, t.logOut);
					if (!existsSync(f)) { this.lastLines[t.taskId] = ""; return; }
					try {
						const txt = await readFile(f, "utf8");
						const ls = txt.split("\n").filter((l) => l.trim() && !l.startsWith("[bg-task exited"));
						this.lastLines[t.taskId] = (ls[ls.length - 1] || "").trim();
					} catch { this.lastLines[t.taskId] = ""; }
				}),
			);
			if (this.detailId) await this.loadDetail();
			this.tui.requestRender();
		} catch { /* best-effort */ }
	}

	private async loadDetail() {
		const t = this.all.find((x) => x.taskId === this.detailId);
		if (!t) { this.detailId = null; this.detailLines = []; return; }
		const readLog = async (rel: string) => { const f = join(this.opts.cwd, rel); if (!existsSync(f)) return ""; return readFile(f, "utf8").catch(() => ""); };
		const text = (await readLog(t.logOut)) + (await readLog(t.logErr));
		this.detailLines = text.split("\n").filter((l) => !l.startsWith("[bg-task exited"));
		// `detailFollow` is the single source of truth for tailing. On (scrolling up pauses it; reaching
		// the bottom or pressing G re-arms it). When following, pin to the latest; otherwise hold the
		// user's position and only clamp if the content shrank.
		if (this.detailFollow) {
			this.detailScroll = this.detailLines.length;
		} else if (this.detailScroll > this.detailLines.length - 1) {
			this.detailScroll = Math.max(0, this.detailLines.length - 1);
		}
	}

	// True when the viewport already shows the last line, so newly-streamed output should scroll in.
	private detailAtBottom(): boolean {
		const maxStart = Math.max(0, this.detailLines.length - MAX_ROWS);
		return this.detailLines.length <= MAX_ROWS || this.detailScroll >= maxStart;
	}

	// ---------- input ----------

	handleInput(data: string): void {
		// Global quits work everywhere.
		if (matchesKey(data, "ctrl+c")) { this.close(); return; }

		if (this.help) { this.help = false; this.tui.requestRender(); return; }

		// Detail (output) view: opens at the LATEST line (tail). esc/b/o/q back to list; j/k/d/u scroll;
		// g/G jump top/bottom. Scrolling up PAUSES auto-follow; reaching the bottom RESUMES it.
		if (this.detailId) {
			if (matchesKey(data, Key.escape) || data === "q" || data === "o" || data === "O" || matchesKey(data, Key.enter) || matchesKey(data, Key.backspace)) {
				this.detailId = null; this.detailLines = []; this.detailScroll = 0; this.tui.requestRender(); return;
			}
			const len = this.detailLines.length;
			if (data === "g") { this.detailScroll = 0; this.detailFollow = false; this.tui.requestRender(); return; }
			if (data === "G") { this.detailScroll = len; this.detailFollow = true; this.tui.requestRender(); return; }
			if (matchesKey(data, Key.down) || data === "j") { this.detailScroll = Math.min(len, this.detailScroll + 1); if (this.detailAtBottom()) this.detailFollow = true; this.tui.requestRender(); return; }
			if (matchesKey(data, Key.up) || data === "k") { this.detailScroll = Math.max(0, this.detailScroll - 1); this.detailFollow = false; this.tui.requestRender(); return; }
			if (matchesKey(data, Key.pageDown) || data === " ") { this.detailScroll = Math.min(len, this.detailScroll + MAX_ROWS); if (this.detailAtBottom()) this.detailFollow = true; this.tui.requestRender(); return; }
			if (matchesKey(data, Key.pageUp)) { this.detailScroll = Math.max(0, this.detailScroll - MAX_ROWS); this.detailFollow = false; this.tui.requestRender(); return; }
			return;
		}

		// Filter input mode: printable builds the filter, backspace deletes, enter/esc exits filter mode.
		if (this.filterMode) {
			if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter)) { this.filterMode = false; this.tui.requestRender(); return; }
			if (matchesKey(data, Key.backspace)) { this.filter = this.filter.slice(0, -1); this.selected = 0; this.tui.requestRender(); return; }
			if (data.length === 1 && data.charCodeAt(0) >= 32 && data.charCodeAt(0) < 127) {
				this.filter += data; this.selected = 0; this.tui.requestRender(); return;
			}
			return;
		}

		const vis = this.visible();
		if (matchesKey(data, Key.escape) || data === "q") { this.close(); return; }
		if (matchesKey(data, Key.up) || data === "k") { if (vis.length) this.selected = (this.selected - 1 + vis.length) % vis.length; this.tui.requestRender(); return; }
		if (matchesKey(data, Key.down) || data === "j") { if (vis.length) this.selected = (this.selected + 1) % vis.length; this.tui.requestRender(); return; }
		if (matchesKey(data, Key.enter) || data === "o" || data === "O") { this.openDetail(vis[this.selected]); return; }
		if (data === "s") { void this.actStop(vis[this.selected], "SIGTERM"); return; }
		if (data === "K" || data === "x") { void this.actStop(vis[this.selected], "SIGKILL"); return; }
		if (data === "r") { this.flash("refreshing…"); void this.refresh(); return; }
		if (data === "a") { this.showAll = !this.showAll; this.selected = 0; this.flash(this.showAll ? "showing all sessions" : "scoped to this session"); void this.refresh(); return; }
		if (data === "e") { this.showExited = !this.showExited; this.selected = 0; this.flash(this.showExited ? "showing exited tasks" : "live tasks only"); this.tui.requestRender(); return; }
		if (data === "/") { this.filterMode = true; this.filter = ""; this.tui.requestRender(); return; }
		if (data === "?") { this.help = true; this.tui.requestRender(); return; }
		if (data === "g") { this.selected = 0; this.tui.requestRender(); return; }
		if (data === "G") { this.selected = Math.max(0, vis.length - 1); this.tui.requestRender(); return; }
	}

	private openDetail(t?: BackgroundTask) {
		if (!t) return;
		this.detailId = t.taskId;
		this.detailScroll = 0;
		this.detailFollow = true; // open at the LATEST output (tail), not the top
		void this.loadDetail().then(() => this.tui.requestRender());
	}

	private async actStop(t: BackgroundTask | undefined, signal: "SIGTERM" | "SIGKILL") {
		if (!t) { this.flash("no task selected"); this.tui.requestRender(); return; }
		if (t.status !== "running" && t.status !== "pending") { this.flash(`${t.label || t.taskId} already ${t.status}`); this.tui.requestRender(); return; }
		try {
			const r = await killTask(this.opts.cwd, t.taskId, signal, this.opts.settings.stopGraceMs);
			this.flash(`${signal === "SIGKILL" ? "killed" : "stopped"} ${r.label || r.taskId}`);
		} catch (err: any) { this.flash(`failed: ${String((err && err.message) || err)}`); }
		await this.refresh();
	}

	private close() { this.done(undefined); }

	invalidate(): void { /* state-driven; render is recomputed each paint */ }

	dispose(): void { if (this.timer) { clearInterval(this.timer); this.timer = undefined; } }

	// ---------- render ----------

	private pad(s: string, w: number): string {
		const vw = visibleWidth(s);
		if (vw > w) return truncateToWidth(s, Math.max(0, w));
		return s + " ".repeat(Math.max(0, w - vw));
	}

	render(width: number): string[] {
		const W = Math.max(40, width);
		if (this.help) return this.renderHelp(W);
		if (this.detailId) return this.renderDetail(W);
		return this.renderList(W);
	}

	private row(inner: string): string {
		// inner already padded to innerW by caller; wrap with colored side borders.
		return this.fg("border", "│ ") + inner + this.fg("border", " │");
	}

	private renderList(W: number): string[] {
		const innerW = W - 4;
		const border = (l: string, r: string, fill = "─") => {
			const gap = Math.max(0, W - visibleWidth(l) - visibleWidth(r));
			return this.fg("border", l) + this.fg("border", fill.repeat(gap)) + this.fg("border", r);
		};
		const out: string[] = [];

		// title line: ╭─ background tasks ── <scope tag> ──╮
		const title = " background tasks ";
		const counts = this.counts();
		const tag = ` ${counts} `;
		let titleGap = W - 2 - visibleWidth("─" + title) - visibleWidth(tag);
		if (titleGap < 1) { // too narrow: drop the tag
			titleGap = Math.max(1, W - 2 - visibleWidth("─" + title));
			out.push(this.fg("border", "╭─") + this.fg("accent", title) + this.fg("border", "─".repeat(titleGap) + "╮"));
		} else {
			out.push(this.fg("border", "╭─") + this.fg("accent", title) + this.fg("border", "─".repeat(titleGap)) + this.fg("dim", tag) + this.fg("border", "╮"));
		}

		// header line: scope + live/exited tag + filter + transient msg
		const scopeTxt = this.scopeOn ? `session ${this.shortSid()}` : "all sessions";
		let header = this.fg("dim", scopeTxt);
		const hiddenExited = this.scoped().filter((t) => t.status !== "running" && t.status !== "pending").length;
		if (!this.showExited && hiddenExited > 0) header += this.fg("dim", `  ·  ${hiddenExited} exited hidden (e)`);
		else if (this.showExited) header += this.fg("dim", "  ·  showing exited (e)");
		if (this.filterMode || this.filter) header += this.fg("dim", "  ·  /") + this.fg("accent", this.filter) + (this.filterMode ? this.fg("dim", "▏") : "");
		const age = Date.now() - this.msgAt;
		if (this.msg && age < 4000) header += this.fg("accent", `  ·  ${this.msg}`);
		out.push(this.row(this.pad(header, innerW)));

		const vis = this.visible();
		if (vis.length === 0) {
			let empty: string;
			if (this.filter) {
				empty = this.fg("muted", `no tasks match "${this.filter}"`);
			} else {
				const hidden = this.scoped().filter((t) => t.status !== "running" && t.status !== "pending").length;
				if (hidden > 0) {
					empty = this.fg("muted", `no live tasks ${this.scopeOn ? "in this session " : ""}— ${hidden} exited hidden (press 'e' to show)`);
				} else {
					empty = this.fg("muted", `no background tasks ${this.scopeOn ? "in this session" : ""} — start one with background_start${this.scopeOn ? " (press 'a' for all sessions)" : ""}`);
				}
			}
			out.push(this.row(this.pad(empty, innerW)));
		} else {
			const shown = vis.slice(0, MAX_ROWS);
			for (let i = 0; i < shown.length; i++) {
				out.push(this.row(this.taskRowInner(shown[i], innerW, i === this.selected)));
			}
			if (vis.length > MAX_ROWS) out.push(this.row(this.pad(this.fg("muted", `… +${vis.length - MAX_ROWS} more`), innerW)));
		}

		// separator + footer + bottom
		out.push(border("├", "┤"));
		out.push(this.row(this.pad(this.fg("dim", truncateToWidth(FOOTER, innerW)), innerW)));
		if (vis.length > MAX_ROWS) out.push(this.row(this.pad(this.fg("dim", `g/G top/bottom`), innerW)));
		out.push(border("╰", "╯"));
		return out;
	}

	private taskRowInner(t: BackgroundTask, innerW: number, selected: boolean): string {
		const col = statusColor(t.status);
		const icon = this.fg(col, ICON[t.status]);
		const iconW = visibleWidth(icon);
		const isRunning = t.status === "running" || t.status === "pending";
		const age = isRunning ? elapsedMmSs(t.startedAt) : t.exitCode === null || t.exitCode === undefined ? t.status : `exit ${t.exitCode}`;
		const ageStr = this.fg("dim", String(age));
		const sessTag = this.showAll && t.spawnedBySession ? this.fg("dim", this.shortId(t.spawnedBySession)) : "";
		const sessW = visibleWidth(sessTag);

		// Responsive column layout: fixed icon/age/session columns, name gets a share, the tail/cmd
		// column absorbs the rest so rows fill the width and align as a table at any dialog width.
		const ageW = 11;
		const gap = 2;
		const reserved = iconW + gap + ageW + gap + sessW + (sessW ? gap : 0);
		const avail = Math.max(0, innerW - reserved);
		const nameW = Math.min(30, Math.max(10, Math.floor(avail * 0.42)));
		const tailW = Math.max(0, avail - nameW - gap);

		const nameCell = this.fg(col, this.pad(truncateToWidth(t.label || t.command, nameW), nameW));
		const ageCell = this.pad(ageStr, ageW);
		const tailText = isRunning ? this.lastLines[t.taskId] || "" : truncateToWidth(t.command, 160);
		const tailCell = this.fg("dim", this.pad(truncateToWidth(tailText || "", Math.max(0, tailW)), Math.max(0, tailW)));

		let line = `${icon}${" ".repeat(Math.max(1, gap - (iconW - 1)))}${nameCell}${" ".repeat(gap)}${ageCell}${" ".repeat(gap)}${tailCell}${sessTag ? " ".repeat(gap) + sessTag : ""}`;
		let content = this.pad(line, innerW);
		if (selected) content = this.bg("selectedBg", content);
		return content;
	}

	private renderDetail(W: number): string[] {
		const innerW = W - 4;
		const t = this.all.find((x) => x.taskId === this.detailId);
		const border = (l: string, r: string) => this.fg("border", l) + this.fg("border", "─".repeat(Math.max(0, W - 2))) + this.fg("border", r);
		const out: string[] = [];
		const title = ` output · ${t ? t.label || t.taskId : this.detailId} `;
		const gap = Math.max(1, W - 2 - visibleWidth(title));
		out.push(this.fg("border", "╭─") + this.fg("accent", title) + this.fg("border", "─".repeat(gap) + "╮"));

		if (!t) {
			out.push(this.row(this.pad(this.fg("muted", "task vanished"), innerW)));
		} else {
			const col = statusColor(t.status);
			const head = `${this.fg(col, ICON[t.status])} ${this.fg(col, truncateToWidth(t.label || t.command, 30))}  ${this.fg("dim", t.status + (t.exitCode === null || t.exitCode === undefined ? "" : ` · exit ${t.exitCode}`))}  ${this.fg("dim", elapsedMmSs(t.startedAt))}`;
			out.push(this.row(this.pad(head, innerW)));
			out.push(this.row(this.pad(this.fg("dim", `cmd: ${truncateToWidth(t.command, innerW - 5)}`), innerW)));
			out.push(this.row(this.pad(this.fg("dim", `out: ${t.logOut}`), innerW)));
			out.push(border("├", "┤"));
			const bodyH = MAX_ROWS;
			const start = Math.max(0, Math.min(this.detailScroll, Math.max(0, this.detailLines.length - bodyH)));
			const slice = this.detailLines.slice(start, start + bodyH);
			if (slice.length === 0) out.push(this.row(this.pad(this.fg("muted", "(no output yet)"), innerW)));
			for (const ln of slice) out.push(this.row(this.pad(this.fg("toolOutput", truncateToWidth(ln, innerW)), innerW)));
			out.push(this.row(this.pad(this.fg("dim", `line ${start + slice.length}/${this.detailLines.length}  ·  j/k scroll · g/G top/bot · ${this.detailFollow ? "following" : "paused"} · esc back`), innerW)));
		}
		out.push(border("╰", "╯"));
		return out;
	}

	private renderHelp(W: number): string[] {
		const innerW = W - 4;
		const lines = [
			["navigate", "↑↓ or j / k"],
			["top / bottom", "g / G"],
			["view output", "enter or o (opens at latest)"],
			["stop (SIGTERM)", "s"],
			["kill (SIGKILL)", "K"],
			["refresh now", "r"],
			["toggle all sessions", "a"],
			["show exited tasks", "e"],
			["filter", "/  (type; backspace; esc to clear)"],
			["close dialog", "esc or q"],
		];
		const out: string[] = [];
		const title = " background tasks — help ";
		const gap = Math.max(1, W - 2 - visibleWidth(title));
		out.push(this.fg("border", "╭─") + this.fg("accent", title) + this.fg("border", "─".repeat(gap) + "╮"));
		for (const [k, v] of lines) out.push(this.row(this.pad(`${this.fg("accent", truncateToWidth(k, 22))}  ${this.fg("dim", v)}`, innerW)));
		out.push(this.fg("border", "├") + this.fg("border", "─".repeat(Math.max(0, W - 2))) + this.fg("border", "┤"));
		out.push(this.row(this.pad(this.fg("dim", "press any key to close"), innerW)));
		out.push(this.fg("border", "╰") + this.fg("border", "─".repeat(Math.max(0, W - 2))) + this.fg("border", "╯"));
		return out;
	}

	// ---------- small helpers ----------

	private counts(): string {
		const all = this.scoped();
		const r = all.filter((t) => t.status === "running" || t.status === "pending").length;
		const d = all.filter((t) => t.status === "done").length;
		const f = all.filter((t) => t.status === "failed").length;
		const k = all.filter((t) => t.status === "killed").length;
		const parts = [`${r} running`];
		if (d) parts.push(`${d} done`);
		if (f) parts.push(`${f} failed`);
		if (k) parts.push(`${k} killed`);
		return parts.join(", ");
	}

	private shortSid(): string { return this.shortId(this.sid ?? "?"); }
	private shortId(id: string): string { return id.length > 12 ? `${id.slice(0, 8)}…` : id; }
}

/** Open the background-tasks overlay dialog. TUI-only. */
export async function openBgDialog(ctx: any, settings: BackgroundSettings, cwd: string, opts: { initialAllSessions?: boolean } = {}): Promise<void> {
	if (ctx.mode !== "tui" || !ctx.hasUI) {
		try { ctx.ui.notify("background-tasks: dialog requires interactive (TUI) mode", "info"); } catch {}
		return;
	}
	try {
		// Capture the live TUI so overlayOptions can read the SAME terminal width the overlay
		// renderer uses (tui.terminal.columns). process.stdout.columns is unreliable in tmux/PTY and
		// goes stale on resize; reading the TUI's own terminal guarantees our width <= viewport, so the
		// box never wraps and never breaks its border. Capped to a readable max, floored for small terms.
		let tuiRef: any = null;
		await ctx.ui.custom(
			(tui: TUI, theme: any, _kb: any, done: (v: unknown) => void) => { tuiRef = tui; return new BgDialog(tui, theme, { settings, cwd, ctx, initialAllSessions: opts.initialAllSessions }, done); },
			{
				overlay: true,
				overlayOptions: () => {
					const cols = (tuiRef && tuiRef.terminal && tuiRef.terminal.columns) || 100;
					const width = Math.max(60, Math.min(116, cols - 4));
					return { width, maxHeight: "78%", anchor: "center", margin: { top: 1, bottom: 1 } } as any;
				},
			},
		);
	} catch (err: any) {
		try { ctx.ui.notify(`background-tasks: dialog failed: ${String((err && err.message) || err)}`, "warning"); } catch {}
	}
}
