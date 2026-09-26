import type { Component, TUI } from "@earendil-works/pi-tui";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { expected, logSwarmError } from "../errorlog.ts";
import { readState, readTaskState } from "../state.ts";
import type { Paths, SwarmState, TaskPaths, TaskState } from "../types.ts";
import { collectFlowData, collectNodeMessages } from "./collectors.ts";
import { collectAttentionRows, collectEventRows, collectLaneRows, collectNodeRows } from "./rows.ts";
import type { FlowRenderHost } from "./flow-render.ts";
import { renderFlowLegacy, renderFlowV3 } from "./flow-render.ts";
import { truncateLeft } from "./formatting.ts";
import { buildGraphTree, deriveCurrentNodeIds } from "./tree.ts";
import type { FlowDialogData, GraphTreeEntry, GraphTreeModel, NodeMessage, Row, Section } from "./types.ts";
import { DEFAULT_EVENT_LIMIT } from "./types.ts";

export class FlowDialog implements Component, FlowRenderHost {
	data: FlowDialogData | null = null;
	selected = 0;
	expandLanes = false;
	filter = "";
	filterMode = false;
	help = false;
	detail: Row | null = null;
	nextIndex = 0;
	nextText = "";
	debugRaw = false;
	focusPane: "graph" | "detail" = "graph";
	graphModel: GraphTreeModel = { entries: [], firstIndexByNodeId: new Map() };
	graphSelected = 0;
	graphScroll = 0;
	messageViewNodeId: string | null = null;
	nodeMsgCache: Map<string, NodeMessage[]> = new Map();
	messageScroll = 0;
	messageViewScroll = 0;
	fullBodyMessageId: string | null = null;
	hOffset = 0;
	private tui: TUI;
	private theme: any;
	private opts: { p: Paths; cwd: string; task: TaskState; tp: TaskPaths; st: SwarmState; eventLimit: number };
	private done: (v: unknown) => void;

	constructor(
		tui: TUI,
		theme: any,
		opts: { p: Paths; cwd: string; task: TaskState; tp: TaskPaths; st: SwarmState; eventLimit: number },
		done: (v: unknown) => void,
	) {
		this.tui = tui;
		this.theme = theme;
		this.opts = opts;
		this.done = done;
		void this.refresh();
	}

	fg(c: string, s: string): string {
		try {
			return this.theme.fg(c, s);
		} catch (err: any) {
			expected("theme_fg_failed", err);
			return s;
		}
	}

	bg(c: string, s: string): string {
		try {
			return this.theme.bg(c, s);
		} catch (err: any) {
			expected("theme_bg_failed", err);
			return s;
		}
	}

	pad(s: string, w: number): string {
		const vw = visibleWidth(s);
		return vw > w ? truncateToWidth(s, Math.max(0, w)) : s + " ".repeat(Math.max(0, w - vw));
	}

	hScroll(s: string, w: number): string {
		if (this.hOffset > 0) s = truncateLeft(s, this.hOffset);
		const vw = visibleWidth(s);
		if (vw > w) s = truncateToWidth(s, w);
		return this.pad(s, w);
	}

	private async refresh() {
		try {
			const st = await readState(this.opts.p, this.opts.cwd);
			const task = await readTaskState(this.opts.tp.taskJson);
			this.opts.st = st;
			this.opts.task = task;
			this.data = await collectFlowData(
				this.opts.p,
				this.opts.cwd,
				task,
				this.opts.tp,
				st,
				this.opts.eventLimit || DEFAULT_EVENT_LIMIT,
			);
			this.graphModel = buildGraphTree(task);
			this.nodeMsgCache = new Map();
			for (const nid of Object.keys(task.nodes)) {
				this.nodeMsgCache.set(nid, await collectNodeMessages(this.opts.p, task, st, nid));
			}
			const currentIds = deriveCurrentNodeIds(task);
			const preferred = currentIds.map((id) => this.graphModel.firstIndexByNodeId.get(id)).find((v) => typeof v === "number") ?? 0;
			this.graphSelected = Math.max(0, Math.min(preferred, Math.max(0, this.graphModel.entries.length - 1)));
			this.selected = Math.min(this.selected, Math.max(0, this.rows().length - 1));
			this.tui.requestRender();
		} catch (err: any) {
			void logSwarmError(this.opts.p, "flow-dialog", "refresh_failed", err);
			this.tui.requestRender();
		}
	}

	rows(): Row[] {
		if (!this.data) return [];
		const rows: Row[] = [
			...collectAttentionRows(this.data.attention),
			...collectNodeRows(this.data.task, this.data.st),
			...collectLaneRows(this.data.task, this.data.lanes, this.expandLanes, this.data.otherAgentsCount, this.data.st),
			...collectEventRows(this.data.events),
		];
		const f = this.filter.trim().toLowerCase();
		return f ? rows.filter((r) => r.search.includes(f)) : rows;
	}

	private jumpSection(dir: 1 | -1): void {
		const rows = this.rows();
		if (!rows.length) return;
		const sections: Section[] = ["ATTENTION", "FLOW", "LANES", "EVENTS"];
		const present = sections.filter((s) => rows.some((r) => r.section === s));
		if (present.length < 2) {
			this.selected = 0;
			return;
		}
		const cur = rows[this.selected];
		const curIdx = cur ? present.indexOf(cur.section) : 0;
		const next = present[(curIdx + dir + present.length) % present.length];
		const first = rows.findIndex((r) => r.section === next);
		this.selected = first >= 0 ? first : this.selected;
	}

	selectedGraphEntry(): GraphTreeEntry | undefined {
		return this.graphModel.entries[this.graphSelected];
	}

	clampGraphSelection(indices: number[]): void {
		if (!indices.length) {
			this.graphSelected = 0;
			return;
		}
		if (!indices.includes(this.graphSelected)) this.graphSelected = indices[0];
	}

	private moveGraph(delta: 1 | -1): void {
		const vis = this.graphModel.entries.map((entry) => entry.index);
		this.clampGraphSelection(vis);
		if (!vis.length) return;
		const pos = vis.indexOf(this.graphSelected);
		const next = vis[(pos + delta + vis.length) % vis.length];
		if (typeof next === "number") this.graphSelected = next;
	}

	private branchGraph(delta: 1 | -1): void {
		const entry = this.selectedGraphEntry();
		if (!entry) return;
		let cur = entry;
		while (cur.parentIndex != null) {
			const parent = this.graphModel.entries[cur.parentIndex];
			if (parent && parent.children.length > 1) {
				const sibs = parent.children;
				const pos = sibs.indexOf(cur.index);
				const next = sibs[(pos + delta + sibs.length) % sibs.length];
				if (typeof next === "number") this.graphSelected = next;
				return;
			}
			cur = parent;
		}
	}

	handleInput(data: string): void {
		if (!this.debugRaw) {
			this.handleInputV3(data);
			return;
		}
		this.handleLegacyInput(data);
	}

	private handleLegacyInput(data: string): void {
		if (this.help) {
			this.help = false;
			this.tui.requestRender();
			return;
		}
		if (this.detail) {
			if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter) || matchesKey(data, Key.backspace) || data === "q") {
				this.detail = null;
				this.tui.requestRender();
			}
			return;
		}
		if (this.filterMode) {
			if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter)) {
				this.filterMode = false;
				this.selected = 0;
			} else if (matchesKey(data, Key.backspace)) {
				this.filter = this.filter.slice(0, -1);
				this.selected = 0;
			} else if (data.length === 1 && data.charCodeAt(0) >= 32) {
				this.filter += data;
				this.selected = 0;
			}
			this.tui.requestRender();
			return;
		}
		const rows = this.rows();
		if (matchesKey(data, Key.escape) || data === "q") {
			this.done(undefined);
			return;
		}
		if (matchesKey(data, Key.tab) || matchesKey(data, "shift+tab")) {
			this.jumpSection(matchesKey(data, "shift+tab") ? -1 : 1);
		} else if (matchesKey(data, Key.up) || data === "k") {
			if (rows.length) this.selected = (this.selected - 1 + rows.length) % rows.length;
		} else if (matchesKey(data, Key.left) || data === "h") {
			if (this.hOffset > 0) this.hOffset = Math.max(0, this.hOffset - 10);
		} else if (matchesKey(data, Key.right) || data === "l") {
			this.hOffset += 10;
		} else if (matchesKey(data, Key.down) || data === "j") {
			const cur = rows[this.selected];
			if (cur && cur.id === "lanes-collapsed" && !this.expandLanes) {
				this.expandLanes = true;
				const next = this.rows().findIndex((r) => r.section === "LANES" && r.id.startsWith("other:"));
				if (next >= 0) this.selected = next;
			} else if (rows.length) {
				this.selected = (this.selected + 1) % rows.length;
			}
		} else if (matchesKey(data, Key.enter)) {
			const cur = rows[this.selected];
			if (cur && cur.id === "lanes-collapsed" && !this.expandLanes) {
				this.expandLanes = true;
				const next = this.rows().findIndex((r) => r.section === "LANES" && r.id.startsWith("other:"));
				if (next >= 0) this.selected = next;
			} else {
				this.detail = cur || null;
			}
		} else if (data === "r") {
			void this.refresh();
			return;
		} else if (data === "/") {
			this.filterMode = true;
			this.filter = "";
		} else if (data === "o") {
			this.expandLanes = !this.expandLanes;
			this.selected = 0;
		} else if (data === "n") {
			if (this.data?.events.length) {
				this.nextIndex = (this.nextIndex + 1) % this.data.events.length;
				this.nextText = this.data.events[this.nextIndex].text;
			}
		} else if (data === "d") {
			this.debugRaw = !this.debugRaw;
		} else if (data === "?") {
			this.help = true;
		}
		this.tui.requestRender();
	}

	private handleInputV3(data: string): void {
		if (data === "\x1b" || data === "q") {
			if (this.fullBodyMessageId !== null) {
				this.fullBodyMessageId = null;
				this.messageViewScroll = 0;
			} else if (this.messageViewNodeId !== null) {
				this.messageViewNodeId = null;
				this.messageScroll = 0;
			} else if (this.help) {
				this.help = false;
			} else if (this.filterMode) {
				this.filterMode = false;
			} else if (this.detail) {
				this.detail = null;
			} else {
				this.done(undefined);
				return;
			}
			this.tui.requestRender();
			return;
		}

		if (this.help) return;
		if (this.filterMode) {
			if (matchesKey(data, Key.backspace)) {
				this.filter = this.filter.slice(0, -1);
				this.tui.requestRender();
			} else if (data.length === 1 && data.charCodeAt(0) >= 32) {
				this.filter += data;
				this.tui.requestRender();
			}
			return;
		}
		if (this.messageViewNodeId !== null) {
			if (data === "j") {
				const nodeMessages = this.nodeMsgCache.get(this.messageViewNodeId) || [];
				if (nodeMessages.length > 0) this.messageScroll = Math.min(this.messageScroll + 1, nodeMessages.length - 1);
			} else if (data === "k") {
				this.messageScroll = Math.max(0, this.messageScroll - 1);
			} else if (matchesKey(data, Key.enter)) {
				const nodeMessages = this.nodeMsgCache.get(this.messageViewNodeId || "") || [];
				if (this.messageScroll >= 0 && this.messageScroll < nodeMessages.length) {
					this.fullBodyMessageId = nodeMessages[this.messageScroll].messageId;
					this.messageViewScroll = 0;
				}
			} else if (data === "r") {
				void this.refresh();
				return;
			}
			this.tui.requestRender();
			return;
		}

		if (this.fullBodyMessageId !== null) {
			if (data === "j") this.messageViewScroll += 1;
			else if (data === "k") this.messageViewScroll = Math.max(0, this.messageViewScroll - 1);
			else if (data === "r") {
				void this.refresh();
				return;
			}
			this.tui.requestRender();
			return;
		}

		if (data === "r") {
			void this.refresh();
			return;
		}
		if (data === "d") {
			this.debugRaw = !this.debugRaw;
		} else if (data === "c") {
			const entry = this.selectedGraphEntry();
			if (entry) {
				const cmd = `/swarm task ${this.opts.task.taskId}`;
				try {
					this.tui.requestRender();
				} catch (err: any) {
					expected("tui_disposed", err);
				}
				this.theme?.notify?.(`copy: ${cmd}`);
			}
			return;
		} else if (data === "/") {
			this.filterMode = true;
			this.filter = "";
		} else if (data === "?") {
			this.help = true;
		} else if (matchesKey(data, Key.up) || data === "k") {
			this.moveGraph(-1);
		} else if (matchesKey(data, Key.down) || data === "j") {
			this.moveGraph(1);
		} else if (matchesKey(data, Key.tab)) {
			this.branchGraph(1);
		} else if (matchesKey(data, "shift+tab")) {
			this.branchGraph(-1);
		} else if (matchesKey(data, Key.left) || data === "h") {
			this.moveGraph(-1);
		} else if (matchesKey(data, Key.right) || data === "l") {
			this.moveGraph(1);
		} else if (matchesKey(data, Key.enter)) {
			const entry = this.selectedGraphEntry();
			if (entry) {
				this.messageViewNodeId = entry.nodeId;
				this.messageScroll = 0;
			}
		}
		this.tui.requestRender();
	}

	invalidate(): void {
		/* state-driven */
	}

	dispose(): void {
		/* manual refresh only */
	}

	render(width: number): string[] {
		return this.debugRaw ? renderFlowLegacy(this, width) : renderFlowV3(this, width);
	}
}
