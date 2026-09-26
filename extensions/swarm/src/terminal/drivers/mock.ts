// === swarm/terminal/drivers/mock.ts — In-memory Mock Terminal Driver for testing ===
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TerminalDriver, TerminalTargetRef, TerminalPaneInfo, SpawnAgentOptions, FocusStatus, AttachCommands } from "../types.ts";

export class MockTerminalDriver implements TerminalDriver {
	readonly id = "mock" as const;

	panes: Map<string, TerminalPaneInfo> = new Map();
	currentPane: TerminalTargetRef | null = null;
	sentTexts: Array<{ target: string; text: string }> = [];
	sentKeys: Array<{ target: string; keys: string; opts?: { literal?: boolean; enter?: boolean } }> = [];
	captured: Map<string, string> = new Map();
	focusHistory: string[] = [];
	available = true;

	reset(): void {
		this.panes.clear();
		this.currentPane = null;
		this.sentTexts = [];
		this.sentKeys = [];
		this.captured.clear();
		this.focusHistory = [];
		this.available = true;
	}

	addMockPane(info: TerminalPaneInfo): void {
		this.panes.set(info.target, info);
		if (info.paneId) {
			this.panes.set(info.paneId, info);
		}
	}

	setCurrentPane(ref: TerminalTargetRef | null): void {
		this.currentPane = ref;
	}

	async isAvailable(_pi: ExtensionAPI): Promise<boolean> {
		return this.available;
	}

	async detectCurrentPane(_pi: ExtensionAPI): Promise<TerminalTargetRef | null> {
		return this.currentPane;
	}

	async listPanes(_pi: ExtensionAPI): Promise<TerminalPaneInfo[]> {
		const unique = new Map<string, TerminalPaneInfo>();
		for (const pane of this.panes.values()) {
			unique.set(pane.target, pane);
		}
		return Array.from(unique.values());
	}

	async spawnAgent(_pi: ExtensionAPI, opts: SpawnAgentOptions): Promise<{ session: string; window: string; target: string }> {
		const target = opts.target || `${opts.session}:${opts.window}.0`;
		const paneInfo: TerminalPaneInfo = {
			target,
			paneId: `%mock-${this.panes.size + 1}`,
			session: opts.session,
			window: opts.window,
			pane: "0",
			command: "node",
			title: opts.window,
			active: true,
			current: false,
		};
		this.panes.set(target, paneInfo);
		this.panes.set(paneInfo.paneId, paneInfo);
		return { session: opts.session, window: opts.window, target };
	}

	async killAgent(_pi: ExtensionAPI, target: TerminalTargetRef | string): Promise<{ killed: boolean; method: string }> {
		const targetStr = typeof target === "string" ? target : target.target;
		if (!targetStr || targetStr === "unknown") return { killed: false, method: "no-target" };

		let found = false;
		for (const [key, pane] of this.panes.entries()) {
			if (key === targetStr || pane.target === targetStr || pane.paneId === targetStr) {
				this.panes.delete(key);
				found = true;
			}
		}
		if (!found) return { killed: false, method: "already-dead" };
		return { killed: true, method: "mock-kill" };
	}

	async isTargetAlive(_pi: ExtensionAPI, target: string): Promise<boolean> {
		if (!target || target === "unknown") return false;
		for (const [key, pane] of this.panes.entries()) {
			if (key === target || pane.target === target || pane.paneId === target) {
				return true;
			}
		}
		return false;
	}

	async inspectProcess(_pi: ExtensionAPI, target: string): Promise<{ piLike: boolean; command: string; pid?: number }> {
		const pane = this.panes.get(target);
		const command = pane?.command || "node";
		return { piLike: true, command, pid: 10000 + this.panes.size };
	}

	async sendText(_pi: ExtensionAPI, target: string, text: string): Promise<void> {
		this.sentTexts.push({ target, text });
	}

	async sendKeys(_pi: ExtensionAPI, target: string, keys: string, opts?: { literal?: boolean; enter?: boolean }): Promise<void> {
		if (!target || target === "unknown") throw new Error("agent has no tmux pane target");
		this.sentKeys.push({ target, keys, opts });
	}

	async capturePane(_pi: ExtensionAPI, target: string, _lines?: number): Promise<string> {
		return this.captured.get(target) || `[mock pane capture: ${target}]\n`;
	}

	async focusWindow(_pi: ExtensionAPI, target: TerminalTargetRef | string): Promise<{ ok: boolean; error?: string }> {
		const winTarget = typeof target === "string" ? target : target.target;
		this.focusHistory.push(winTarget);
		return { ok: true };
	}

	async getFocusStatus(_pi: ExtensionAPI, session: string): Promise<FocusStatus> {
		return {
			session,
			sessionAlive: true,
			activeWindowIndex: "0",
			activeWindowName: "main",
			activePaneId: "%mock-0",
		};
	}

	getAttachCommands(target: TerminalTargetRef | string): AttachCommands {
		const paneTarget = typeof target === "string" ? target : target.target;
		const session = typeof target === "string" ? target.split(":")[0] || "mock-session" : target.session || "mock-session";
		return {
			session,
			windowTarget: paneTarget,
			paneTarget,
			attach: `mock attach -t ${session}`,
			selectWindow: `mock select-window -t ${paneTarget}`,
			selectPane: `mock select-pane -t ${paneTarget}`,
		};
	}

	isSameTarget(targetA: string, targetB: string): boolean {
		if (targetA === targetB) return true;
		const a = (targetA || "").trim();
		const b = (targetB || "").trim();
		if (!a || !b) return false;
		if (a === b || a.toLowerCase() === b.toLowerCase()) return true;
		const normalize = (t: string) => (t.endsWith(".0") ? t.slice(0, -2) : t);
		if (normalize(a).toLowerCase() === normalize(b).toLowerCase()) return true;
		return false;
	}
}
