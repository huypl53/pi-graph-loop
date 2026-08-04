// === swarm/tmux.ts — auto-extracted from index.ts (verbatim bodies) ===
import { defineTool, CONFIG_DIR_NAME, truncateHead, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, writeFile, appendFile, rm, stat, rename, readdir, realpath } from "node:fs/promises";
import { join, dirname, relative, sep } from "node:path";
import type { Paths } from "./types.ts";
import { safeId, sleep } from "./utils.ts";

export async function tmux(pi: ExtensionAPI, args: string[], timeout = 10_000) {
	const result = await pi.exec("tmux", args, { timeout });
	if (result.code !== 0) throw new Error(`tmux ${args.join(" ")} failed (${result.code}): ${result.stderr || result.stdout}`);
	return result.stdout;
}

export async function capturePane(pi: ExtensionAPI, p: Paths, agentId: string, target: string, label: string) {
	const file = join(p.tmuxTraces, `${safeId(agentId)}-${safeId(label)}.txt`);
	try {
		const out = await tmux(pi, ["capture-pane", "-t", target, "-p", "-S", "-300"], 10_000);
		await writeFile(file, out, "utf8");
		return file;
	} catch (err: any) {
		await writeFile(file, `[capture failed] ${err?.message || err}\n`, "utf8");
		return file;
	}
}

export async function sendToPane(pi: ExtensionAPI, target: string, text: string) {
	await tmux(pi, ["send-keys", "-t", target, "-l", text], 10_000);
	await sleep(150);
	await tmux(pi, ["send-keys", "-t", target, "Enter"], 10_000);
}

export function isTmuxRunning(pi: ExtensionAPI, target: string): Promise<boolean> {
	// `#{pane_alive}` is not portable/reliable across tmux versions and was observed
	// to report false for live panes. A target is alive if tmux can resolve it to a
	// pane id; `display-message` exits non-zero when the pane/window/session is gone.
	return tmux(pi, ["display-message", "-p", "-t", target, "#{pane_id}"], 3_000)
		.then((out) => out.trim().length > 0)
		.catch(() => false);
}
