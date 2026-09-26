// === swarm/tmux.ts — Backward-compatible facade delegating to TerminalDriver ===
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Paths } from "./types/index.ts";
import { safeId } from "./utils.ts";
import { tmuxDriver, getTerminalDriver, type TerminalPaneInfo, isPiLikeCommand, isHereToken, HERE_TOKENS } from "./terminal/index.ts";

export { isPiLikeCommand, isHereToken, HERE_TOKENS };
export type TmuxPaneInfo = TerminalPaneInfo;

export async function tmux(pi: ExtensionAPI, args: string[], timeout = 10_000): Promise<string> {
	return tmuxDriver.tmux(pi, args, timeout);
}

export async function capturePane(pi: ExtensionAPI, p: Paths, agentId: string, target: string, label: string): Promise<string> {
	const file = join(p.tmuxTraces, `${safeId(agentId)}-${safeId(label)}.txt`);
	try {
		const out = await getTerminalDriver().capturePane(pi, target, 300);
		await writeFile(file, out, "utf8");
		return file;
	} catch (err: any) {
		await writeFile(file, `[capture failed] ${err?.message || err}\n`, "utf8");
		return file;
	}
}

export async function sendToPane(pi: ExtensionAPI, target: string, text: string): Promise<void> {
	return getTerminalDriver().sendText(pi, target, text);
}

export function isTmuxRunning(pi: ExtensionAPI, target: string): Promise<boolean> {
	return getTerminalDriver().isTargetAlive(pi, target);
}

export async function isPanePiLike(pi: ExtensionAPI, target: string): Promise<{ piLike: boolean; command: string }> {
	const res = await getTerminalDriver().inspectProcess(pi, target);
	return { piLike: res.piLike, command: res.command };
}

export async function currentPaneTarget(
	pi: ExtensionAPI,
): Promise<{ target: string; paneId: string; session: string; window: string; pane: string } | null> {
	const cur = await getTerminalDriver().detectCurrentPane(pi);
	if (!cur || !cur.paneId || !cur.session || !cur.window || !cur.pane) return null;
	return {
		target: cur.target,
		paneId: cur.paneId,
		session: cur.session,
		window: cur.window,
		pane: cur.pane,
	};
}

export async function resolveRegisterTarget(pi: ExtensionAPI, raw: string): Promise<string> {
	const trimmed = (raw || "").trim();
	if (isHereToken(trimmed)) {
		const cur = await currentPaneTarget(pi);
		if (!cur)
			throw new Error(
				"Cannot resolve 'here': this pi session is not running inside tmux. Run pi inside a tmux session, or pass an explicit target such as 'session:window.pane', 'session:window', or '%paneid'. Use '/swarm panes' to list available targets.",
			);
		return cur.target;
	}
	return trimmed;
}

export async function listAllPanes(pi: ExtensionAPI): Promise<TmuxPaneInfo[]> {
	return tmuxDriver.listPanes(pi);
}
