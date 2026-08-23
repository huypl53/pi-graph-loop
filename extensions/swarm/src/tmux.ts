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
	// Guard: tmux target resolution is fuzzy — `sess:gone-window.0` silently falls back to
	// the session's ACTIVE window instead of failing, so a dead agent's window looks alive.
	// Verify the resolved window name matches the requested one (when the target carries one).
	return tmux(pi, ["display-message", "-p", "-t", target, "#{window_name}\t#{pane_id}"], 3_000)
		.then((out) => {
			const [resolvedWindow] = out.trim().split("\t");
			const want = target.includes(":") ? target.slice(target.indexOf(":") + 1).split(".")[0] : undefined;
			if (want && want !== "unknown" && resolvedWindow && resolvedWindow !== want) return false;
			return out.trim().length > 0;
		})
		.catch(() => false);
}

// Issue D (pane-alive-but-not-pi): `pane_current_command` values that mean "a pi process is (probably)
// running in this pane". pi runs under node; a pane still on the shell prompt (zsh/bash/fish...) is NOT
// pi. Unknown-but-plausible values default to pi-like (fail-open) so this guard never blocks delivery
// to an exotic-but-valid setup; only clearly-shell panes are rejected.
// UAT finding (task-swarm-uat-v2): a denylist cannot enumerate every non-pi foreground command (live
// repro: a pane running `sleep` was marked delivered). Flip the default to ALLOWLIST: pi always runs as a
// `node` process, so only `node` (and empty, treated as unresolved/fail-open) are pi-like. Everything
// else — shells, sleep, cat, unknown binaries — is refused and stays retryable.
const PI_COMMANDS = new Set(["node"]);

export function isPiLikeCommand(command: string): boolean {
	const c = (command || "").trim().replace(/^-/, ""); // login shells appear as "-zsh"
	return !c || PI_COMMANDS.has(c);
}

export async function isPanePiLike(pi: ExtensionAPI, target: string): Promise<{ piLike: boolean; command: string }> {
	try {
		const out = await tmux(pi, ["display-message", "-p", "-t", target, "#{pane_current_command}"], 3_000);
		const command = out.trim();
		if (command && !PI_COMMANDS.has(command)) return { piLike: false, command };
		return { piLike: true, command };
	} catch {
		// Unresolvable target: isTmuxRunning already gates liveness; fail-open here.
		return { piLike: true, command: "" };
	}
}

// Pure predicate (unit-testable without tmux): does this pane_current_command value look like pi?

// Tokens that mean "adopt the pane this command/tool is running in". Lets an operator register the
// CURRENT pi pane without first discovering its tmux target: `/swarm register here <id> [role]`.
export const HERE_TOKENS = new Set(["here", "self", "current", "."]);

export function isHereToken(raw: string): boolean {
	return HERE_TOKENS.has((raw || "").trim().toLowerCase());
}

// Detect the tmux pane the current process lives in. Returns null when not inside tmux (no $TMUX) or
// when tmux can't describe the active pane. Used to resolve the "here" register token and to flag the
// current pane in `/swarm panes`.
export async function currentPaneTarget(pi: ExtensionAPI): Promise<{ target: string; paneId: string; session: string; window: string; pane: string } | null> {
	if (!process.env.TMUX) return null;
	try {
		const out = await tmux(pi, ["display-message", "-p", "#{session_name}\t#{window_index}\t#{pane_index}\t#{pane_id}"], 3_000);
		const parts = out.trim().split("\t");
		const session = parts[0]; const window = parts[1]; const pane = parts[2]; const paneId = parts[3];
		if (!session || !paneId) return null;
		return { target: `${session}:${window}.${pane}`, paneId, session, window, pane };
	} catch { return null; }
}

// Resolve a register target: magic "here" tokens expand to the current pane's target; anything else is
// returned trimmed as-is. Throws a clear, actionable error when "here" is used outside tmux.
export async function resolveRegisterTarget(pi: ExtensionAPI, raw: string): Promise<string> {
	const trimmed = (raw || "").trim();
	if (isHereToken(trimmed)) {
		const cur = await currentPaneTarget(pi);
		if (!cur) throw new Error("Cannot resolve 'here': this pi session is not running inside tmux. Run pi inside a tmux session, or pass an explicit target such as 'session:window.pane', 'session:window', or '%paneid'. Use '/swarm panes' to list available targets.");
		return cur.target;
	}
	return trimmed;
}

export interface TmuxPaneInfo {
	target: string;
	paneId: string;
	session: string;
	window: string;
	pane: string;
	command: string;
	title: string;
	active: boolean;  // active pane within its window
	current: boolean; // this pane (matches currentPaneTarget)
}

// List every tmux pane across all sessions with a copy-pasteable target. Powers `/swarm panes` so the
// operator can discover the exact target for `/swarm register <target> ...`. Returns [] if tmux is
// unavailable or there are no sessions/panes.
export async function listAllPanes(pi: ExtensionAPI): Promise<TmuxPaneInfo[]> {
	const fmt = "#{session_name}\t#{window_index}\t#{pane_index}\t#{pane_id}\t#{pane_current_command}\t#{pane_title}\t#{pane_active}";
	let out: string;
	try { out = await tmux(pi, ["list-panes", "-a", "-F", fmt], 5_000); }
	catch { return []; }
	const cur = await currentPaneTarget(pi);
	const rows: TmuxPaneInfo[] = [];
	for (const line of out.split("\n").map((l) => l.trim()).filter(Boolean)) {
		const parts = line.split("\t");
		const session = parts[0]; const window = parts[1]; const pane = parts[2]; const paneId = parts[3];
		const command = parts[4] || ""; const title = parts[5] || ""; const active = parts[6] === "1";
		if (!session || !paneId) continue;
		const target = `${session}:${window}.${pane}`;
		rows.push({ target, paneId, session, window, pane, command, title, active, current: Boolean(cur && cur.paneId === paneId) });
	}
	return rows;
}
