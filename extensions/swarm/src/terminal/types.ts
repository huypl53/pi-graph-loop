// === swarm/terminal/types.ts — Pluggable terminal driver types ===
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Structured reference to a terminal target (window/pane).
 */
export interface TerminalTargetRef {
	target: string;
	paneId?: string;
	session?: string;
	window?: string;
	pane?: string;
}

/**
 * Detailed information about a terminal pane.
 */
export interface TerminalPaneInfo {
	target: string;
	paneId: string;
	session: string;
	window: string;
	pane: string;
	command: string;
	title: string;
	active: boolean; // active pane within its window
	current: boolean; // this pane (matches current process pane target)
}

/**
 * Options for spawning an agent in a terminal session/window.
 */
export interface SpawnAgentOptions {
	session: string;
	window: string;
	command: string;
	cwd: string;
	target?: string;
}

/**
 * Summary of terminal focus state.
 */
export interface FocusStatus {
	session: string;
	sessionAlive: boolean;
	activeWindowIndex?: string;
	activeWindowName?: string;
	activePaneId?: string;
}

/**
 * Shell commands to attach to or select an agent's terminal pane.
 */
export interface AttachCommands {
	session?: string;
	windowTarget?: string;
	paneTarget: string;
	attach: string;
	selectWindow: string;
	selectPane: string;
}

/**
 * Pluggable terminal driver abstraction.
 * Enables swarm to operate across tmux, herdr, or in-memory mock drivers.
 */
export interface TerminalDriver {
	readonly id: "tmux" | "herdr" | "mock";

	isAvailable(pi: ExtensionAPI): Promise<boolean>;

	detectCurrentPane(pi: ExtensionAPI): Promise<TerminalTargetRef | null>;

	listPanes(pi: ExtensionAPI): Promise<TerminalPaneInfo[]>;

	spawnAgent(pi: ExtensionAPI, opts: SpawnAgentOptions): Promise<{ session: string; window: string; target: string }>;

	killAgent(pi: ExtensionAPI, target: TerminalTargetRef | string): Promise<{ killed: boolean; method: string }>;

	isTargetAlive(pi: ExtensionAPI, target: string): Promise<boolean>;

	inspectProcess(pi: ExtensionAPI, target: string): Promise<{ piLike: boolean; command: string; pid?: number }>;

	sendText(pi: ExtensionAPI, target: string, text: string): Promise<void>;

	sendKeys(pi: ExtensionAPI, target: string, keys: string, opts?: { literal?: boolean; enter?: boolean }): Promise<void>;

	capturePane(pi: ExtensionAPI, target: string, lines?: number): Promise<string>;

	focusWindow(pi: ExtensionAPI, target: TerminalTargetRef | string): Promise<{ ok: boolean; error?: string }>;

	getFocusStatus(pi: ExtensionAPI, session: string): Promise<FocusStatus>;

	getAttachCommands(target: TerminalTargetRef | string): AttachCommands;

	isSameTarget(targetA: string, targetB: string): boolean;
}
