// === swarm/terminal/index.ts — Terminal Driver subsystem entry point ===
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TerminalDriver } from "./types.ts";
import { TmuxDriver } from "./drivers/tmux.ts";
import { HerdrDriver } from "./drivers/herdr.ts";

export * from "./types.ts";
export * from "./drivers/tmux.ts";
export * from "./drivers/mock.ts";
export * from "./drivers/herdr.ts";

export const tmuxDriver = new TmuxDriver();
export const herdrDriver = new HerdrDriver();

/**
 * Factory for resolving the active terminal driver.
 * Precedence:
 * 1. process.env.PI_SWARM_TERMINAL_MANAGER
 * 2. cfg?.terminalManager
 * 3. Default to tmuxDriver (protects 40+ test suites mocking tmux)
 */
export function getTerminalDriver(cfg?: { terminalManager?: string }): TerminalDriver {
	const mgr = (process.env.PI_SWARM_TERMINAL_MANAGER || cfg?.terminalManager || "").trim().toLowerCase();
	if (mgr === "herdr") {
		return herdrDriver;
	}
	return tmuxDriver;
}

/**
 * Detect current host pane dynamically and determine if the given target matches it.
 * Prevents host shell injection even when root record's tmuxTarget is "unknown".
 */
export async function isRootHostPane(pi: ExtensionAPI, target: string, driver: TerminalDriver = getTerminalDriver()): Promise<boolean> {
	if (!target || target === "unknown") return false;
	const cur = await driver.detectCurrentPane(pi);
	if (!cur) return false;
	if (cur.target && driver.isSameTarget(cur.target, target)) return true;
	if (cur.paneId && driver.isSameTarget(cur.paneId, target)) return true;
	return false;
}
