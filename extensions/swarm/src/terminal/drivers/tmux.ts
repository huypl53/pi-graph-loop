// === swarm/terminal/drivers/tmux.ts — Tmux Terminal Driver ===
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TerminalDriver, TerminalTargetRef, TerminalPaneInfo, SpawnAgentOptions, FocusStatus, AttachCommands } from "../types.ts";
import { sleep } from "../../utils.ts";
import { logSwarmError } from "../../errorlog.ts";

export const PANE_SEND_CHUNK_CHARS = 2_000;
export const PANE_SEND_CHUNK_GAP_MS = 120;
export const PANE_SEND_ENTER_DEBOUNCE_MS = 450;

export const PI_COMMANDS = new Set(["node", "pi", "bun"]);
export const HERE_TOKENS = new Set(["here", "self", "current", "."]);

export function isPiLikeCommand(command: string): boolean {
	const c = (command || "").trim().replace(/^-/, ""); // login shells appear as "-zsh"
	return !c || PI_COMMANDS.has(c);
}

export function isHereToken(raw: string): boolean {
	return HERE_TOKENS.has((raw || "").trim().toLowerCase());
}

export class TmuxDriver implements TerminalDriver {
	readonly id = "tmux" as const;

	async tmux(pi: ExtensionAPI, args: string[], timeout = 10_000): Promise<string> {
		const result = await pi.exec("tmux", args, { timeout });
		if (result.code !== 0) {
			throw new Error(`tmux ${args.join(" ")} failed (${result.code}): ${result.stderr || result.stdout}`);
		}
		return result.stdout;
	}

	async isAvailable(pi: ExtensionAPI): Promise<boolean> {
		try {
			const result = await pi.exec("tmux", ["-V"], { timeout: 3_000 });
			return result.code === 0;
		} catch (err: any) {
			await logSwarmError(process.cwd(), "tmux", "is_available.failed", err);
			return false;
		}
	}

	async detectCurrentPane(pi: ExtensionAPI): Promise<TerminalTargetRef | null> {
		if (!process.env.TMUX) return null;
		try {
			const out = await this.tmux(
				pi,
				["display-message", "-p", "#{session_name}\t#{window_index}\t#{pane_index}\t#{pane_id}"],
				3_000,
			);
			const parts = out.trim().split("\t");
			const session = parts[0];
			const window = parts[1];
			const pane = parts[2];
			const paneId = parts[3];
			if (!session || !paneId) return null;
			return { target: `${session}:${window}.${pane}`, paneId, session, window, pane };
		} catch (err: any) {
			await logSwarmError(process.cwd(), "tmux", "current_pane_target.failed", err);
			return null;
		}
	}

	async listPanes(pi: ExtensionAPI): Promise<TerminalPaneInfo[]> {
		const fmt = "#{session_name}\t#{window_index}\t#{pane_index}\t#{pane_id}\t#{pane_current_command}\t#{pane_title}\t#{pane_active}";
		let out: string;
		try {
			out = await this.tmux(pi, ["list-panes", "-a", "-F", fmt], 5_000);
		} catch (err: any) {
			await logSwarmError(process.cwd(), "tmux", "list_all_panes.failed", err);
			return [];
		}
		const cur = await this.detectCurrentPane(pi);
		const rows: TerminalPaneInfo[] = [];
		for (const line of out
			.split("\n")
			.map((l) => l.trim())
			.filter(Boolean)) {
			const parts = line.split("\t");
			const session = parts[0];
			const window = parts[1];
			const pane = parts[2];
			const paneId = parts[3];
			const command = parts[4] || "";
			const title = parts[5] || "";
			const active = parts[6] === "1";
			if (!session || !paneId) continue;
			const target = `${session}:${window}.${pane}`;
			rows.push({
				target,
				paneId,
				session,
				window,
				pane,
				command,
				title,
				active,
				current: Boolean(cur && cur.paneId === paneId),
			});
		}
		return rows;
	}

	async spawnAgent(pi: ExtensionAPI, opts: SpawnAgentOptions): Promise<{ session: string; window: string; target: string }> {
		const target = opts.target || `${opts.session}:${opts.window}.0`;
		try {
			await this.tmux(pi, ["has-session", "-t", opts.session], 5_000);
			await this.tmux(pi, ["new-window", "-t", opts.session, "-c", opts.cwd, "-n", opts.window, opts.command], 10_000);
		} catch (err: any) {
			if (String(err?.message || err).includes("can't find session")) {
				try {
					await this.tmux(pi, ["new-session", "-d", "-s", opts.session, "-c", opts.cwd, "-n", opts.window, opts.command], 10_000);
				} catch (sessionErr: any) {
					await logSwarmError(process.cwd(), "tmux", "spawn_agent.new_session_failed", sessionErr, { opts });
					throw sessionErr;
				}
			} else {
				await logSwarmError(process.cwd(), "tmux", "spawn_agent.new_window_failed", err, { opts });
				throw err;
			}
		}
		return { session: opts.session, window: opts.window, target };
	}

	async killAgent(pi: ExtensionAPI, target: TerminalTargetRef | string): Promise<{ killed: boolean; method: string }> {
		const targetStr = typeof target === "string" ? target : target.target;
		if (!targetStr || targetStr === "unknown") return { killed: false, method: "no-target" };

		const alive = await this.isTargetAlive(pi, targetStr);
		if (!alive) return { killed: false, method: "already-dead" };

		let winTarget = targetStr;
		if (typeof target !== "string" && target.session && target.window && target.window !== "unknown") {
			winTarget = `${target.session}:${target.window}`;
		} else if (targetStr.includes(":")) {
			const [sess, rest] = targetStr.split(":");
			const win = rest.split(".")[0];
			winTarget = `${sess}:${win}`;
		}

		try {
			await this.tmux(pi, ["kill-window", "-t", winTarget], 5_000);
			return { killed: true, method: "kill-window" };
		} catch (err: any) {
			await logSwarmError(process.cwd(), "tmux", "kill_agent.window_fallback_to_pane", err, { target: targetStr });
		}

		try {
			await this.tmux(pi, ["kill-pane", "-t", targetStr], 5_000);
			return { killed: true, method: "kill-pane" };
		} catch (err: any) {
			await logSwarmError(process.cwd(), "tmux", "kill_agent.pane_failed", err, { target: targetStr });
			return { killed: false, method: "kill-failed" };
		}
	}

	async isTargetAlive(pi: ExtensionAPI, target: string): Promise<boolean> {
		try {
			await this.tmux(pi, ["list-panes", "-t", target], 3_000);
			return true;
		} catch (err: any) {
			await logSwarmError(process.cwd(), "tmux", "is_target_alive.target_missing", err, { target });
			return false;
		}
	}

	async inspectProcess(pi: ExtensionAPI, target: string): Promise<{ piLike: boolean; command: string; pid?: number }> {
		try {
			const out = await this.tmux(pi, ["display-message", "-p", "-t", target, "#{pane_current_command}\t#{pane_pid}"], 3_000);
			const parts = out.trim().split("\t");
			const command = parts[0] || "";
			const pid = parts[1] ? parseInt(parts[1], 10) : undefined;
			if (command && !PI_COMMANDS.has(command)) {
				return { piLike: false, command, pid: Number.isNaN(pid) ? undefined : pid };
			}
			return { piLike: true, command, pid: Number.isNaN(pid) ? undefined : pid };
		} catch (err: any) {
			await logSwarmError(process.cwd(), "tmux", "is_pane_pi_like.failed", err, { target });
			return { piLike: true, command: "" };
		}
	}

	async sendText(pi: ExtensionAPI, target: string, text: string): Promise<void> {
		if (text.length <= PANE_SEND_CHUNK_CHARS) {
			await this.tmux(pi, ["send-keys", "-t", target, "-l", "--", text], 10_000);
		} else {
			for (let i = 0; i < text.length; i += PANE_SEND_CHUNK_CHARS) {
				if (i > 0) await sleep(PANE_SEND_CHUNK_GAP_MS);
				await this.tmux(pi, ["send-keys", "-t", target, "-l", "--", text.slice(i, i + PANE_SEND_CHUNK_CHARS)], 10_000);
			}
		}
		await sleep(PANE_SEND_ENTER_DEBOUNCE_MS);
		await this.tmux(pi, ["send-keys", "-t", target, "Enter"], 10_000);
	}

	async sendKeys(pi: ExtensionAPI, target: string, keys: string, opts: { literal?: boolean; enter?: boolean } = {}): Promise<void> {
		if (!target || target === "unknown") throw new Error("agent has no tmux pane target");
		if (opts.literal) {
			await this.tmux(pi, ["send-keys", "-t", target, "-l", "--", keys], 10_000);
		} else {
			const tokens = keys.split(/\s+/).filter(Boolean);
			if (tokens.length) await this.tmux(pi, ["send-keys", "-t", target, "--", ...tokens], 10_000);
		}
		if (opts.enter) await this.tmux(pi, ["send-keys", "-t", target, "Enter"], 10_000);
		await sleep(120);
	}

	async capturePane(pi: ExtensionAPI, target: string, lines = 300): Promise<string> {
		const out = await this.tmux(pi, ["capture-pane", "-t", target, "-p", "-S", `-${lines}`], 10_000);
		return out;
	}

	async focusWindow(pi: ExtensionAPI, target: TerminalTargetRef | string): Promise<{ ok: boolean; error?: string }> {
		const winTarget =
			typeof target === "string"
				? target
				: target.session && target.window && target.window !== "unknown"
					? `${target.session}:${target.window}`
					: target.target;

		if (!winTarget || winTarget === "unknown") {
			return { ok: false, error: "Target agent has no valid tmux window or target" };
		}

		try {
			await this.tmux(pi, ["select-window", "-t", winTarget], 5_000);
			const paneTarget = typeof target === "string" ? target : target.target || target.paneId;
			if (paneTarget && paneTarget !== "unknown") {
				try {
					await this.tmux(pi, ["select-pane", "-t", paneTarget], 3_000);
				} catch (err: any) {
					await logSwarmError(process.cwd(), "tmux", "select_pane.failed", err, { target: paneTarget });
				}
			}
			return { ok: true };
		} catch (err: any) {
			const msg = String(err?.message || err);
			await logSwarmError(process.cwd(), "tmux", "select_window.failed", err, { target: winTarget });
			return { ok: false, error: msg };
		}
	}

	async getFocusStatus(pi: ExtensionAPI, session: string): Promise<FocusStatus> {
		try {
			const out = await this.tmux(pi, ["display-message", "-p", "-t", session, "#{window_index}\t#{window_name}\t#{pane_id}"], 3_000);
			const parts = out.trim().split("\t");
			if (parts.length >= 2) {
				return {
					session,
					sessionAlive: true,
					activeWindowIndex: parts[0],
					activeWindowName: parts[1],
					activePaneId: parts[2],
				};
			}
			return { session, sessionAlive: false };
		} catch (err: any) {
			await logSwarmError(process.cwd(), "tmux", "get_focus_status.tmux_check_failed", err, { session });
			return { session, sessionAlive: false };
		}
	}

	getAttachCommands(target: TerminalTargetRef | string): AttachCommands {
		let session = "";
		let winTarget = "";
		let paneTarget = "";

		if (typeof target === "string") {
			paneTarget = target;
			if (target.includes(":")) {
				const [s, rest] = target.split(":");
				session = s;
				const w = rest.split(".")[0];
				winTarget = `${s}:${w}`;
			} else {
				session = target;
				winTarget = target;
			}
		} else {
			paneTarget = target.target;
			session = target.session || "";
			winTarget =
				target.session && target.window && target.window !== "unknown" ? `${target.session}:${target.window}` : target.target;
		}

		return {
			session,
			windowTarget: winTarget,
			paneTarget,
			attach: `tmux attach -t ${session}`,
			selectWindow: `tmux select-window -t ${winTarget}`,
			selectPane: `tmux select-pane -t ${paneTarget}`,
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
