// === swarm/terminal/drivers/herdr.ts — Herdr Terminal Driver ===
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TerminalDriver, TerminalTargetRef, TerminalPaneInfo, SpawnAgentOptions, FocusStatus, AttachCommands } from "../types.ts";
import { sleep } from "../../utils.ts";
import { expected, logSwarmError } from "../../errorlog.ts";
import { PANE_SEND_ENTER_DEBOUNCE_MS } from "../../constants.ts";
import { PI_COMMANDS } from "./tmux.ts";

/**
 * Extract a workspace-qualified herdr pane id and its workspace segment when the target is a
 * native herdr pane id ("wN:pM"). Shared by focusWindow and resolveOwningTabId (both must use
 * the SAME pane→owning-tab mapping — a67e351 parity, task herdr-autofocus-parity-20260927 D3).
 */
export function splitHerdrPaneId(target: string): { paneId: string; workspace: string } | undefined {
	const m = String(target || "").match(/^(w[A-Za-z0-9_-]+):(p[A-Za-z0-9]+)$/);
	if (!m) return undefined;
	return { paneId: m[0], workspace: m[1] };
}

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
	// G4 (herdr-workspace-isolation): cached id of the dedicated `swarm-agents` workspace
	// where spawned worker tabs live. Distinct from `workspaceId` (the ROOT's workspace).
	// On stale-cache (workspace was closed externally), re-create via `workspace create`.
	private agentsWorkspaceId?: string;
	// H5: root tab of the agents workspace as returned by `workspace create` — closed after
	// the first agent tab exists so no idle shell tab lingers in the swarm workspace.
	private agentsWsRootTabId?: string;
	// Track which pane ids belong to swarm-spawned agents so teardown can count only
	// swarm panes (never touches foreign panes in the agents workspace).
	private readonly swarmPaneIds = new Set<string>();
	// True once this driver has spawned/tracked at least one swarm pane. Distinguishes "all
	// tracked panes died → close the workspace" (legit teardown) from "driver never owned a
	// pane → never close" (foreign-only guard).
	private everTrackedSwarmPanes = false;

	private getAgentsWorkspaceLabel(): string {
		return process.env.PI_SWARM_HERDR_WS_LABEL || "swarm-agents";
	}

	private async ensureAgentsWorkspace(pi: ExtensionAPI): Promise<string> {
		if (this.agentsWorkspaceId) {
			// Stale-cache probe: verify the cached ws still exists.
			try {
				const probe = await this.herdrJson(pi, ["workspace", "get", this.agentsWorkspaceId], 3_000);
				if (probe?.result?.workspace?.workspace_id) return this.agentsWorkspaceId;
			} catch (err: any) {
				// A stale cached workspace is an expected re-create branch; other failures are durable.
				if (/workspace_not_found/i.test(String(err?.message || err))) {
					expected("cached_agents_workspace_not_found", err);
				} else {
					await logSwarmError(process.cwd(), "herdr", "ensure_agents_workspace.cache_probe_failed", err, {
						workspaceId: this.agentsWorkspaceId,
					});
				}
			}
			this.agentsWorkspaceId = undefined;
		}
		// List workspaces and match by label.
		const list = await this.herdrJson(pi, ["workspace", "list"], 5_000);
		const wsList = Array.isArray(list?.result?.workspaces) ? list.result.workspaces : [];
		const label = this.getAgentsWorkspaceLabel();
		const existing = wsList.find((w: any) => w?.label === label);
		if (existing?.workspace_id) {
			this.agentsWorkspaceId = existing.workspace_id;
			return existing.workspace_id;
		}
		// Create the dedicated agents workspace.
		const created = await this.herdrJson(pi, ["workspace", "create", "--label", label], 10_000);
		const wsId = created?.result?.workspace?.workspace_id || created?.workspace_id || created?.result?.workspace_id;
		if (!wsId) {
			await logSwarmError(process.cwd(), "herdr", "ensure_agents_workspace.create_failed", new Error("no workspace_id in response"), {
				created,
			});
			throw new Error("herdr workspace create returned no workspace_id");
		}
		this.agentsWorkspaceId = wsId;
		this.agentsWsRootTabId = created?.result?.tab?.tab_id || created?.tab?.tab_id || undefined;
		return wsId;
	}

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
		const segment = String(compositeTarget || "")
			.split(":")[1]
			?.replace(/\.\d+$/, "");
		if (!segment) return undefined;
		try {
			// Real 0.8.2 pane-list rows expose tab_id but no title/label; labels live on tab-list rows.
			const tabs = await this.listTabs(pi);
			const tab = tabs.find((t) => t.label === segment) || tabs.find((t) => t.tab_id === segment);
			if (!tab?.tab_id) return undefined;
			// Labels are listed across all workspaces; pane list defaults to this driver's root
			// workspace. Query the matched tab's workspace explicitly so root w1 can resolve a
			// worker tab living in the dedicated swarm-agents workspace wK.
			const args = ["pane", "list"];
			if (tab.workspace_id) args.push("--workspace", tab.workspace_id);
			const paneRes = await this.herdrJson(pi, args, 5_000);
			const rawPanes = Array.isArray(paneRes) ? paneRes : paneRes?.result?.panes || paneRes?.panes || [];
			const hit = rawPanes.find((p: any) => (p?.tab_id || p?.tabId) === tab.tab_id);
			return hit?.pane_id || hit?.paneId || hit?.id;
		} catch (err: any) {
			await logSwarmError(process.cwd(), "herdr", "resolve_pane_by_label.failed", err, { compositeTarget, segment });
			return undefined;
		}
	}

	private async listTabs(pi: ExtensionAPI): Promise<Array<{ tab_id: string; label?: string; workspace_id?: string }>> {
		const res = await this.herdrJson(pi, ["tab", "list"], 5_000);
		const raw = Array.isArray(res) ? res : res?.result?.tabs || res?.tabs || [];
		return raw.filter((t: any) => t?.tab_id);
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
		// G4 (herdr-workspace-isolation): workers land in a dedicated `swarm-agents`
		// workspace, NOT the root workspace. The root workspace id is preserved for
		// root-pane detection only.
		const agentsWs = await this.ensureAgentsWorkspace(pi);
		const createArgs = ["tab", "create"];
		createArgs.push("--workspace", agentsWs);
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
		const session = res?.result?.tab?.workspace_id || agentsWs;
		// Track this pane as a swarm-spawned agent so teardown can count only swarm panes.
		if (paneId) {
			this.swarmPaneIds.add(paneId);
			this.everTrackedSwarmPanes = true;
		}
		// H5 (live-found 2026-09-26): `workspace create` always spawns the workspace with an idle
		// shell root tab (label '1') that the swarm never uses — it lingered forever. herdr closes
		// the workspace when its LAST tab closes, but the ws survives losing the root tab while an
		// agent tab exists (live-verified). Close the root tab right after the first agent tab is
		// created so the workspace shows only real agents. Best-effort: failure to close is logged,
		// not fatal (spawn already succeeded).
		if (res?.result?.workspace?.active_tab_id || res?.result?.tab) {
			const rootTabId = this.agentsWsRootTabId;
			if (rootTabId && rootTabId !== tabId) {
				try {
					await this.herdr(pi, ["tab", "close", rootTabId], 5_000);
					// One-shot semantics (audit-gap RED 2026-09-27): the root tab exists exactly once.
					// Clear the recorded id after a successful close so later spawns never re-attempt
					// closing an already-closed tab.
					this.agentsWsRootTabId = undefined;
				} catch (err: any) {
					await logSwarmError(process.cwd(), "herdr", "spawn_agent.root_tab_close_failed", err, { rootTabId, tabId });
				}
			}
		}
		// Step 2: launch the command in the root pane via `pane run`. herdr 0.8.2 `pane run`
		// TYPES the given words into the pane's shell as a single line (it is argv on the CLI
		// side but is joined with spaces — shell quoting inside any single word is DESTROYED,
		// live-verified 2026-09-26: `pane run <p> sh -c 'echo X:$0' -- probe` echoed
		// `sh -c echo X:$0 -- probe` and ran `sh -c echo` = bare `echo`). So a compound
		// `sh -c <command-string>` wrapper can never survive. Instead: pass the command's own
		// words (env-prefix assignments + the pi invocation, all single-word-safe because
		// spawnAgent's cmd builder shellQuotes every value) directly — typed as one line they
		// form a valid shell command: `VAR='x' VAR2='y' pi --model 'm' … -- swarm-agent`,
		// with the assignments scoped to the pi invocation by the shell itself.
		const words = opts.command.trim().split(/\s+/);
		const runArgs = ["pane", "run", paneId, ...words];
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

		// G4: don't gate on isTargetAlive — the pane may still be open (running a shell
		// prompt after the pi process exited) and we still need to close it for teardown.
		// isTargetAlive checks the foreground process; a pane with a shell prompt is
		// "dead" from the agent's perspective but still occupies the workspace.

		let killed = false;
		let method = "kill-failed";
		try {
			await this.herdr(pi, ["pane", "close", targetStr], 5_000);
			killed = true;
			method = "pane-close";
		} catch (err: any) {
			await logSwarmError(process.cwd(), "herdr", "kill_agent.pane_close_fallback", err, { target: targetStr });
		}

		if (!killed) {
			const tabId = typeof target === "string" ? target : target.window;
			if (tabId && tabId !== "unknown" && tabId !== targetStr) {
				try {
					await this.herdr(pi, ["tab", "close", tabId], 5_000);
					killed = true;
					method = "tab-close";
				} catch (tabErr: any) {
					await logSwarmError(process.cwd(), "herdr", "kill_agent.tab_close_failed", tabErr, { tabId });
				}
			}
		}

		// G4 teardown: remove the pane from the swarm tracking set and close the
		// agents workspace if no swarm panes remain. Never touches the root workspace.
		if (killed) this.swarmPaneIds.delete(targetStr);
		await this.maybeCloseAgentsWorkspace(pi);

		return { killed, method };
	}

	/**
	 * G4 teardown: if no swarm-spawned panes remain in the agents workspace, close it.
	 * Counts only panes the driver spawned (tracked by pane id in `swarmPaneIds`),
	 * so foreign panes in the agents workspace never block or trigger close wrongly.
	 * Never touches the root workspace.
	 */
	private async maybeCloseAgentsWorkspace(pi: ExtensionAPI): Promise<void> {
		if (!this.agentsWorkspaceId) return;
		// Foreign-only guard (audit-gap RED 2026-09-27): if this driver instance never spawned or
		// tracked a swarm pane, teardown must not close the shared agents workspace — it may hold
		// foreign (user-created) panes. Uses the ever-tracked flag rather than the live set size:
		// after the FINAL tracked pane dies the set is legitimately empty and the workspace must
		// still close. A driver that never owned a pane never closes.
		if (!this.everTrackedSwarmPanes) return;
		// Prune the tracking set: remove pane ids that no longer exist.
		// Use `pane list --workspace <wsId>` to get the authoritative pane set for the
		// agents workspace, then intersect with our tracked set. This avoids false
		// negatives from `isTargetAlive` racing with a freshly-spawned pane that hasn't
		// fully started its foreground process yet.
		let wsPanes: string[] = [];
		try {
			const list = await this.herdrJson(pi, ["pane", "list", "--workspace", this.agentsWorkspaceId], 5_000);
			const rawList = Array.isArray(list?.result?.panes) ? list.result.panes : [];
			wsPanes = rawList.map((p: any) => p?.pane_id || p?.paneId).filter(Boolean);
		} catch (err: any) {
			// A removed workspace needs no cleanup; a failed list must remain diagnosable.
			if (/workspace_not_found/i.test(String(err?.message || err))) {
				expected("agents_workspace_already_closed", err);
			} else {
				await logSwarmError(process.cwd(), "herdr", "maybe_close_agents_workspace.list_failed", err, {
					workspaceId: this.agentsWorkspaceId,
				});
			}
			return;
		}
		const stillAlive = new Set<string>();
		for (const paneId of this.swarmPaneIds) {
			if (wsPanes.includes(paneId)) stillAlive.add(paneId);
		}
		this.swarmPaneIds.clear();
		for (const id of stillAlive) this.swarmPaneIds.add(id);
		if (this.swarmPaneIds.size > 0) return;
		// No swarm panes remain — close the agents workspace.
		try {
			await this.herdr(pi, ["workspace", "close", this.agentsWorkspaceId], 5_000);
			this.agentsWorkspaceId = undefined;
		} catch (err: any) {
			await logSwarmError(process.cwd(), "herdr", "maybe_close_agents_workspace.failed", err, { wsId: this.agentsWorkspaceId });
		}
	}

	async inspectProcess(pi: ExtensionAPI, target: string): Promise<{ piLike: boolean; command: string; pid?: number }> {
		try {
			// herdr pane ids are workspace-qualified ("wN:pM") — but workspace ids are NOT
			// limited to digits (live-verified 2026-09-26: "swarm-agents" workspace resolved to "wK";
			// the digit-only regex misclassified wK:p5 as a tmux composite, fell to label-resolution,
			// pane-list titles are null → piLike:false → engine marked live agents dead → all
			// engine delivery/reconcile paths stalled). Accept letter/digit/underscore/hyphen
			// workspace segments. Legacy tmux-composite targets ("session:window.0") still fail
			// this test and resolve through `pane list` by tab label as before.
			const paneId = /^w[A-Za-z0-9_-]+:p[A-Za-z0-9]+$/.test(target) ? target : await this.resolvePaneIdByLabel(pi, target);
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
			if (!isPi) {
				// When ExtensionAPI.exec runs `herdr pane process-info` from inside the target pane,
				// Herdr can report that child CLI as the foreground process instead of the Pi host.
				// Only treat this as Pi-like if Herdr confirms the target is this current pane.
				const current = await this.detectCurrentPane(pi);
				if (current && this.isSameTarget(current.paneId || current.target, paneId)) {
					return { piLike: true, command: "pi", pid: process.pid };
				}
			}
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

	async resolvePaneId(pi: ExtensionAPI, target: string): Promise<string> {
		// Herdr pane ids are already workspace-qualified ("wN:pM") — pass through directly; legacy
		// composite targets resolve by tab label (same mapping isTargetAlive/inspectProcess use).
		if (/^w[A-Za-z0-9_-]+:p[A-Za-z0-9]+$/.test(target)) return target;
		const resolved = await this.resolvePaneIdByLabel(pi, target);
		if (!resolved) throw new Error(`herdr: cannot resolve pane id for target ${target}`);
		return resolved;
	}

	async sendText(pi: ExtensionAPI, target: string, text: string): Promise<void> {
		await this.herdr(pi, ["pane", "send-text", target, text], 10_000);
		await sleep(PANE_SEND_ENTER_DEBOUNCE_MS);
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

	private isHerdrTabId(value: string): boolean {
		return /^w[A-Za-z0-9_-]+:t[A-Za-z0-9]+$/.test(value || "");
	}

	/**
	 * D3 (task herdr-autofocus-parity-20260927): resolve a target to the herdr tab id that owns
	 * it. Native herdr pane ids ("wN:pM") resolve via `pane list --workspace <ws>` — the exact
	 * pane→owning-tab mapping focusWindow has used since a67e351. Anything else (already-a-tab-id,
	 * legacy composite, label) returns undefined: callers fall back to their legacy matching.
	 */
	async resolveOwningTabId(pi: ExtensionAPI, target: string): Promise<string | undefined> {
		if (this.isHerdrTabId(target)) return target;
		const split = splitHerdrPaneId(target);
		if (!split) return undefined;
		try {
			const paneRes = await this.herdrJson(pi, ["pane", "list", "--workspace", split.workspace], 5_000);
			const panes = Array.isArray(paneRes) ? paneRes : paneRes?.result?.panes || paneRes?.panes || [];
			const pane = panes.find((p: any) => {
				const id = p?.pane_id || p?.paneId || p?.id;
				const workspaceId = p?.workspace_id || p?.workspaceId;
				return id === split.paneId && (!workspaceId || workspaceId === split.workspace);
			});
			const ownerTabId = pane?.tab_id || pane?.tabId;
			if (ownerTabId && this.isHerdrTabId(ownerTabId) && ownerTabId.startsWith(`${split.workspace}:t`)) {
				return ownerTabId;
			}
			return undefined;
		} catch (err: any) {
			await logSwarmError(process.cwd(), "herdr", "resolve_owning_tab.failed", err, { target });
			return undefined;
		}
	}

	async focusWindow(pi: ExtensionAPI, target: TerminalTargetRef | string): Promise<{ ok: boolean; error?: string }> {
		let tabId = typeof target === "string" ? target : target.window || target.target;
		if (!tabId || tabId === "unknown") {
			return { ok: false, error: "Target agent has no valid herdr tab or target" };
		}
		try {
			if (!this.isHerdrTabId(tabId)) {
				// /swarm register here stores the pane component in tmuxWindow (e.g. "p1") while
				// tmuxTarget is the workspace-qualified Herdr pane id. Herdr tab focus requires
				// the owning tab id, so resolve this exact pane in its workspace; never guess from
				// the pane index or fall back to a similarly named/current tab.
				const paneId = typeof target === "string" ? "" : target.target || target.paneId || "";
				const paneWorkspace = splitHerdrPaneId(paneId)?.workspace;
				if (paneWorkspace) {
					const requestedWorkspace =
						typeof target === "string" || !target.session || target.session === "unknown" ? paneWorkspace : target.session;
					if (requestedWorkspace !== paneWorkspace) {
						return {
							ok: false,
							error: `Herdr pane ${paneId} does not belong to target workspace ${requestedWorkspace}`,
						};
					}
					const paneRes = await this.herdrJson(pi, ["pane", "list", "--workspace", paneWorkspace], 5_000);
					const panes = Array.isArray(paneRes) ? paneRes : paneRes?.result?.panes || paneRes?.panes || [];
					const pane = panes.find((p: any) => {
						const id = p?.pane_id || p?.paneId || p?.id;
						const workspaceId = p?.workspace_id || p?.workspaceId;
						return id === paneId && (!workspaceId || workspaceId === paneWorkspace);
					});
					const ownerTabId = pane?.tab_id || pane?.tabId;
					if (!ownerTabId || !this.isHerdrTabId(ownerTabId) || !ownerTabId.startsWith(`${paneWorkspace}:t`)) {
						return { ok: false, error: `Herdr pane ${paneId} has no owning tab in workspace ${paneWorkspace}` };
					}
					tabId = ownerTabId;
				} else {
					// String targets and non-pane object targets retain legacy label/composite resolution.
					const segment = tabId.includes(":") ? tabId.split(":")[1]?.replace(/\.\d+$/, "") : tabId.replace(/\.\d+$/, "");
					const tabs = await this.listTabs(pi);
					const hit = tabs.find((t) => t.label === segment) || tabs.find((t) => t.tab_id === segment);
					if (hit?.tab_id) tabId = hit.tab_id;
				}
			}
			await this.herdr(pi, ["tab", "focus", tabId], 5_000);
			return { ok: true };
		} catch (err: any) {
			const msg = String(err?.message || err);
			await logSwarmError(process.cwd(), "herdr", "focus_window.failed", err, { tabId });
			return { ok: false, error: msg };
		}
	}

	private async resolveFocusWorkspace(pi: ExtensionAPI, requested: string): Promise<string> {
		const res = await this.herdrJson(pi, ["workspace", "list"], 5_000);
		const workspaces = Array.isArray(res?.result?.workspaces) ? res.result.workspaces : res?.workspaces || [];
		const byId = workspaces.find((w: any) => w?.workspace_id === requested);
		if (byId?.workspace_id) return byId.workspace_id;
		const byLabel = workspaces.find((w: any) => w?.label === requested);
		if (byLabel?.workspace_id) return byLabel.workspace_id;
		// Root swarm state can still carry its legacy tmux session string; under Herdr, the
		// worker tabs live in the dedicated swarm-agents workspace. Resolve that workspace rather
		// than passing the tmux-shaped name to `tab list` (which falsely reports NOT RUNNING).
		const agents = workspaces.find((w: any) => w?.label === this.getAgentsWorkspaceLabel());
		if (agents?.workspace_id) return agents.workspace_id;
		return this.agentsWorkspaceId || this.getWorkspaceId() || requested || "";
	}

	async getFocusStatus(pi: ExtensionAPI, session: string): Promise<FocusStatus> {
		const requested = session || this.getWorkspaceId() || "";
		let ws = requested;
		try {
			ws = await this.resolveFocusWorkspace(pi, requested);
			const args = ["tab", "list"];
			if (ws) args.push("--workspace", ws);
			const res = await this.herdrJson(pi, args, 3_000);
			const tabs = Array.isArray(res) ? res : res?.result?.tabs || res?.tabs || [];
			// Real 0.8.2 rows use `focused`; do not claim an arbitrary tabs[0] fallback.
			const activeTab = tabs.find((t: any) => t.active || t.is_active || t.focused);
			if (!activeTab) return { session: ws, sessionAlive: true };
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

	/**
	 * Return the workspace_id where the user is currently focused GLOBALLY. Herdr `tab list`
	 * (no workspace filter) returns tabs across all workspaces with `focused: true` on the
	 * globally focused one. This is the cross-workspace signal the busy-path auto-focus guard
	 * needs to detect focus stealing.
	 *
	 * Throws on query failure — callers (the busy-path cross-workspace guard) own the
	 * fail-open policy and the durable error logging at the correct project cwd.
	 */
	async getFocusedWorkspaceId(pi: ExtensionAPI): Promise<string | undefined> {
		const res = await this.herdrJson(pi, ["tab", "list"], 3_000);
		const tabs = Array.isArray(res) ? res : res?.result?.tabs || res?.tabs || [];
		const focused = tabs.find((t: any) => t.focused || t.active || t.is_active);
		return focused?.workspace_id || focused?.workspaceId || undefined;
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
