// === swarm/terminal/drivers/herdr.ts — Herdr Terminal Driver ===
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TerminalDriver, TerminalTargetRef, TerminalPaneInfo, SpawnAgentOptions, FocusStatus, AttachCommands } from "../types.ts";
import { sleep } from "../../utils.ts";
import { logSwarmError } from "../../errorlog.ts";
import { PI_COMMANDS } from "./tmux.ts";

export { PI_COMMANDS };

/**
 * Check if the foreground command represents a pi/node/bun agent process.
 * Shells (bash, zsh, sh) and empty commands return false, preventing ghost agents.
 */
export function isPiLikeProcess(command: string): boolean {
	const c = (command || "").trim().replace(/^-/, "");
	if (!c) return false;
	const base = c.split("/").pop() || c;
	return PI_COMMANDS.has(base);
}

/**
 * Translate tmux key tokens to Herdr key syntax.
 * e.g. C-c -> ctrl+c, Escape -> esc, Enter -> enter
 */
export function translateTmuxKeyToHerdr(token: string): string {
	const t = token.trim();
	const lower = t.toLowerCase();
	if (lower === "c-c" || lower === "^c") return "ctrl+c";
	if (lower === "c-d" || lower === "^d") return "ctrl+d";
	if (lower === "c-z" || lower === "^z") return "ctrl+z";
	if (lower === "escape" || lower === "esc") return "esc";
	if (lower === "enter" || lower === "return") return "enter";
	if (lower === "tab") return "tab";
	if (lower === "space") return "space";
	if (lower === "backspace" || lower === "bspace") return "backspace";
	if (lower === "up") return "up";
	if (lower === "down") return "down";
	if (lower === "left") return "left";
	if (lower === "right") return "right";
	if (/^[Cc]-([a-zA-Z0-9])$/.test(t)) {
		return `ctrl+${t.slice(2).toLowerCase()}`;
	}
	if (/^[Mm]-([a-zA-Z0-9])$/.test(t)) {
		return `alt+${t.slice(2).toLowerCase()}`;
	}
	return t;
}

export class HerdrDriver implements TerminalDriver {
	readonly id = "herdr" as const;
	private workspaceId?: string;

	constructor(workspaceId?: string) {
		this.workspaceId = workspaceId;
	}

	setWorkspaceId(wsId: string): void {
		this.workspaceId = wsId;
	}

	getWorkspaceId(): string | undefined {
		return this.workspaceId || process.env.HERDR_WORKSPACE_ID;
	}

	async herdr(pi: ExtensionAPI, args: string[], timeout = 10_000): Promise<string> {
		const result = await pi.exec("herdr", args, { timeout });
		if (result.code !== 0) {
			throw new Error(`herdr ${args.join(" ")} failed (${result.code}): ${result.stderr || result.stdout}`);
		}
		return result.stdout;
	}

	async herdrJson<T = any>(pi: ExtensionAPI, args: string[], timeout = 10_000): Promise<T> {
		const out = await this.herdr(pi, args, timeout);
		try {
			return JSON.parse(out.trim()) as T;
		} catch (err: any) {
			await logSwarmError(process.cwd(), "herdr", "parse_json_failed", err, { args, output: out });
			throw new Error(`Failed to parse herdr output as JSON: ${out}`);
		}
	}

	async isAvailable(pi: ExtensionAPI): Promise<boolean> {
		try {
			const result = await pi.exec("herdr", ["--version"], { timeout: 3_000 });
			return result.code === 0;
		} catch (err: any) {
			await logSwarmError(process.cwd(), "herdr", "is_available.failed", err);
			return false;
		}
	}

	async detectCurrentPane(pi: ExtensionAPI): Promise<TerminalTargetRef | null> {
		if (process.env.HERDR_PANE_ID) {
			const paneId = process.env.HERDR_PANE_ID;
			const session = process.env.HERDR_WORKSPACE_ID || this.getWorkspaceId() || "";
			const window = process.env.HERDR_TAB_ID || "";
			return { target: paneId, paneId, session, window, pane: paneId };
		}
		try {
			const res = await this.herdrJson(pi, ["pane", "current", "--current"], 3_000);
			const pane = res?.result?.pane || res?.pane || res?.result || res;
			const paneId = pane?.pane_id || pane?.paneId || pane?.id;
			if (!paneId) return null;
			const session = pane?.workspace_id || pane?.workspaceId || this.getWorkspaceId() || "";
			const window = pane?.tab_id || pane?.tabId || "";
			return { target: paneId, paneId, session, window, pane: paneId };
		} catch (err: any) {
			await logSwarmError(process.cwd(), "herdr", "detect_current_pane.failed", err);
			return null;
		}
	}

	/**
	 * Map a legacy tmux-composite target ("session:window.0") to a herdr pane id by matching the tab
	 * label that spawnAgent set (label = agent window id). Returns undefined when no tab matches.
	 * Best-effort: a failed listing resolves to undefined (caller treats the pane as not alive).
	 */
	private async resolvePaneIdByLabel(pi: ExtensionAPI, compositeTarget: string): Promise<string | undefined> {
		const label = String(compositeTarget || "")
			.split(":")[1]
			?.replace(/\.\d+$/, "");
		if (!label) return undefined;
		try {
			const panes = await this.listPanes(pi);
			const hit = panes.find((p) => p.title === label);
			return hit?.paneId;
		} catch (err: any) {
			await logSwarmError(process.cwd(), "herdr", "resolve_pane_by_label.failed", err, { compositeTarget, label });
			return undefined;
		}
	}

	async listPanes(pi: ExtensionAPI): Promise<TerminalPaneInfo[]> {
		const args = ["pane", "list"];
		const ws = this.getWorkspaceId();
		if (ws) args.push("--workspace", ws);
		let res: any;
		try {
			res = await this.herdrJson(pi, args, 5_000);
		} catch (err: any) {
			await logSwarmError(process.cwd(), "herdr", "list_panes.failed", err, { args });
			return [];
		}
		const cur = await this.detectCurrentPane(pi);
		const rawList = Array.isArray(res) ? res : res?.result?.panes || res?.panes || res?.result || [];
		const rows: TerminalPaneInfo[] = [];
		for (const p of rawList) {
			const paneId = p.pane_id || p.paneId || p.id;
			if (!paneId) continue;
			const session = p.workspace_id || p.workspaceId || ws || "";
			const window = p.tab_id || p.tabId || "";
			const paneIndex = p.pane_index ?? p.paneIndex ?? paneId;
			const command = p.command || p.process_name || p.process?.command || p.process?.name || "";
			const title = p.title || p.label || "";
			const active = Boolean(p.active ?? p.is_active);
			rows.push({
				target: paneId,
				paneId,
				session,
				window,
				pane: String(paneIndex),
				command,
				title,
				active,
				current: Boolean(cur && (cur.paneId === paneId || cur.target === paneId)),
			});
		}
		return rows;
	}

	async spawnAgent(pi: ExtensionAPI, opts: SpawnAgentOptions): Promise<{ session: string; window: string; target: string }> {
		// herdr 0.8.2 contract: `tab create` is options-only (no positional command).
		// Launch path is two-step: (1) `tab create [--workspace] [--label] [--cwd] --env …`
		// returns the new tab + root_pane ids; (2) `pane run <PANE_ID> <COMMAND>...`
		// runs the launch command in that root pane. The 0.4.x contract (positional
		// command on `tab create`) is rejected by 0.8.2 with `unknown option: <cmd>`.
		const ws = this.getWorkspaceId() || opts.session;
		const createArgs = ["tab", "create"];
		if (ws) createArgs.push("--workspace", ws);
		if (opts.window) createArgs.push("--label", opts.window);
		if (opts.cwd) createArgs.push("--cwd", opts.cwd);
		createArgs.push("--env", `PI_SWARM_AGENT_ID=${opts.window}`, "--env", "PI_SWARM_IS_ROOT=0");
		let res: any;
		try {
			res = await this.herdrJson(pi, createArgs, 10_000);
		} catch (err: any) {
			await logSwarmError(process.cwd(), "herdr", "spawn_agent.tab_create_failed", err, { opts, createArgs });
			throw err;
		}
		const tabId = res?.result?.tab?.tab_id || res?.tab?.tab_id || res?.tab_id || res?.tab || opts.window;
		const paneId = res?.result?.root_pane?.pane_id || res?.root_pane?.pane_id || res?.pane_id || res?.pane || tabId;
		const session = res?.result?.tab?.workspace_id || ws || opts.session;
		if (session && !this.workspaceId) {
			this.workspaceId = session;
		}
		// Step 2: launch the command in the root pane via `pane run`. The command is a
		// shell line (env-prefix assignments + quoted pi invocation), so we wrap it in
		// `sh -c <command> -- swarm-agent` — `pane run` takes argv, not a shell string.
		const runArgs = ["pane", "run", paneId, "sh", "-c", opts.command.trim(), "--", "swarm-agent"];
		try {
			await this.herdr(pi, runArgs, 30_000);
		} catch (err: any) {
			await logSwarmError(process.cwd(), "herdr", "spawn_agent.pane_run_failed", err, { opts, runArgs });
			throw err;
		}
		return { session, window: tabId, target: paneId };
	}

	async killAgent(pi: ExtensionAPI, target: TerminalTargetRef | string): Promise<{ killed: boolean; method: string }> {
		const targetStr = typeof target === "string" ? target : target.target || target.paneId;
		if (!targetStr || targetStr === "unknown") return { killed: false, method: "no-target" };

		const alive = await this.isTargetAlive(pi, targetStr);
		if (!alive) return { killed: false, method: "already-dead" };

		try {
			await this.herdr(pi, ["pane", "close", targetStr], 5_000);
			return { killed: true, method: "pane-close" };
		} catch (err: any) {
			await logSwarmError(process.cwd(), "herdr", "kill_agent.pane_close_fallback", err, { target: targetStr });
		}

		const tabId = typeof target === "string" ? target : target.window;
		if (tabId && tabId !== "unknown" && tabId !== targetStr) {
			try {
				await this.herdr(pi, ["tab", "close", tabId], 5_000);
				return { killed: true, method: "tab-close" };
			} catch (tabErr: any) {
				await logSwarmError(process.cwd(), "herdr", "kill_agent.tab_close_failed", tabErr, { tabId });
			}
		}
		return { killed: false, method: "kill-failed" };
	}

	async inspectProcess(pi: ExtensionAPI, target: string): Promise<{ piLike: boolean; command: string; pid?: number }> {
		try {
			// herdr pane ids are workspace-qualified ("wN:pM"). Swarm agent records may still carry legacy
			// tmux-composite targets ("session:window.0", live-verified 2026-09-26: composite ids make
			// `herdr pane process-info` exit 1 with pane_not_found). Resolve composites through `pane list`
			// by matching the tab label (spawnAgent sets label = agent window/id) before probing.
			const paneId = /^w\d+:p\d+$/.test(target) ? target : await this.resolvePaneIdByLabel(pi, target);
			if (!paneId) return { piLike: false, command: "" };
			const res = await this.herdrJson(pi, ["pane", "process-info", "--pane", paneId], 3_000);
			// Real CLI 0.8.2 shape: result.process_info.foreground_processes[] = [{name, pid, cmdline, ...}, ...]
			// ordered root → leaf. The leaf (last entry) is the actual user command; intermediate
			// entries are shell wrappers (`sh -c <script>`). Keep the older scalar shapes as fallbacks.
			const pinfo = res?.result?.process_info || res?.process_info || res?.result || res;
			const fgList = Array.isArray(pinfo?.foreground_processes) ? pinfo.foreground_processes : [];
			const fgLeaf = fgList.length > 0 ? fgList[fgList.length - 1] : undefined;
			const fgRoot = fgList.length > 0 ? fgList[0] : undefined;
			const proc = fgLeaf || fgRoot || pinfo?.foreground_process || pinfo?.process || pinfo;
			const command = (proc?.name || proc?.command || proc?.process_name || proc?.foreground_process || "").trim();
			const rawPid = proc?.pid;
			const pid = typeof rawPid === "number" ? rawPid : rawPid ? parseInt(rawPid, 10) : undefined;
			const isPi = isPiLikeProcess(command);
			return {
				piLike: isPi,
				command,
				pid: Number.isNaN(pid) ? undefined : pid,
			};
		} catch (err: any) {
			await logSwarmError(process.cwd(), "herdr", "inspect_process.failed", err, { target });
			return { piLike: false, command: "" };
		}
	}

	async isTargetAlive(pi: ExtensionAPI, target: string): Promise<boolean> {
		const info = await this.inspectProcess(pi, target);
		return info.piLike;
	}

	async sendText(pi: ExtensionAPI, target: string, text: string): Promise<void> {
		await this.herdr(pi, ["pane", "send-text", target, text], 10_000);
		await sleep(100);
		await this.herdr(pi, ["pane", "send-keys", target, "enter"], 10_000);
	}

	async sendKeys(pi: ExtensionAPI, target: string, keys: string, opts: { literal?: boolean; enter?: boolean } = {}): Promise<void> {
		if (!target || target === "unknown") throw new Error("agent has no herdr target");
		if (opts.literal) {
			await this.herdr(pi, ["pane", "send-text", target, keys], 10_000);
		} else {
			const tokens = keys.split(/\s+/).filter(Boolean);
			for (const token of tokens) {
				const translated = translateTmuxKeyToHerdr(token);
				await this.herdr(pi, ["pane", "send-keys", target, translated], 10_000);
			}
		}
		if (opts.enter) {
			await this.herdr(pi, ["pane", "send-keys", target, "enter"], 10_000);
		}
		await sleep(120);
	}

	async capturePane(pi: ExtensionAPI, target: string, lines = 300): Promise<string> {
		// herdr ≥0.8 `pane read` takes no --workspace flag (live-verified 2026-09-26 against herdr 0.8.2:
		// `herdr pane read <id> --workspace w1` exits 2 with "unknown option: --workspace"). Pane ids are
		// already workspace-qualified ("wN:pM"), so drop the flag — passing it made every capture fail.
		const args = ["pane", "read", target, "--source", "recent-unwrapped", "--lines", String(lines)];
		try {
			const out = await this.herdr(pi, args, 10_000);
			const trimmed = out.trim();
			if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
				try {
					const parsed = JSON.parse(trimmed);
					if (typeof parsed === "string") return parsed;
					const text = parsed?.result?.text ?? parsed?.text ?? parsed?.output ?? parsed?.result?.output;
					if (typeof text === "string") return text;
					if (Array.isArray(parsed?.lines)) return parsed.lines.join("\n");
				} catch (jsonErr: any) {
					await logSwarmError(process.cwd(), "herdr", "capture_pane.json_parse_failed", jsonErr, { target });
				}
			}
			return out;
		} catch (err: any) {
			await logSwarmError(process.cwd(), "herdr", "capture_pane.failed", err, { target, lines });
			return "";
		}
	}

	async focusWindow(pi: ExtensionAPI, target: TerminalTargetRef | string): Promise<{ ok: boolean; error?: string }> {
		const tabId = typeof target === "string" ? target : target.window || target.target;
		if (!tabId || tabId === "unknown") {
			return { ok: false, error: "Target agent has no valid herdr tab or target" };
		}
		try {
			await this.herdr(pi, ["tab", "focus", tabId], 5_000);
			return { ok: true };
		} catch (err: any) {
			const msg = String(err?.message || err);
			await logSwarmError(process.cwd(), "herdr", "focus_window.failed", err, { tabId });
			return { ok: false, error: msg };
		}
	}

	async getFocusStatus(pi: ExtensionAPI, session: string): Promise<FocusStatus> {
		const ws = session || this.getWorkspaceId() || "";
		try {
			const args = ["tab", "list"];
			if (ws) args.push("--workspace", ws);
			const res = await this.herdrJson(pi, args, 3_000);
			const tabs = Array.isArray(res) ? res : res?.result?.tabs || res?.tabs || [];
			const activeTab = tabs.find((t: any) => t.active || t.is_active || t.focused) || tabs[0];
			return {
				session: ws,
				sessionAlive: true,
				activeWindowIndex: activeTab?.tab_id || activeTab?.id,
				activeWindowName: activeTab?.label || activeTab?.name,
				activePaneId: activeTab?.active_pane_id || activeTab?.root_pane_id,
			};
		} catch (err: any) {
			await logSwarmError(process.cwd(), "herdr", "get_focus_status.failed", err, { session: ws });
			return { session: ws, sessionAlive: false };
		}
	}

	getAttachCommands(target: TerminalTargetRef | string): AttachCommands {
		const targetStr = typeof target === "string" ? target : target.target || target.paneId || "";
		const session = typeof target === "string" ? "" : target.session || "";
		const winTarget = typeof target === "string" ? target : target.window || target.target || "";
		return {
			session,
			windowTarget: winTarget,
			paneTarget: targetStr,
			attach: "herdr",
			selectWindow: `herdr tab focus ${winTarget}`,
			selectPane: `herdr pane focus ${targetStr}`,
		};
	}

	isSameTarget(targetA: string, targetB: string): boolean {
		if (targetA === targetB) return true;
		const a = (targetA || "").trim();
		const b = (targetB || "").trim();
		if (!a || !b) return false;
		return a === b || a.toLowerCase() === b.toLowerCase();
	}
}
