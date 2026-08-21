// === swarm/agents.ts — auto-extracted from index.ts (verbatim bodies) ===
import { defineTool, CONFIG_DIR_NAME, truncateHead, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, writeFile, appendFile, rm, stat, rename, readdir, realpath } from "node:fs/promises";
import { join, dirname, relative, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { Paths, ReusableAgentMatch, SwarmAgent, SwarmState } from "./types.ts";
import { SPAWN_SETTLE_MS } from "./constants.ts";
import { capturePane, isTmuxRunning, resolveRegisterTarget, sendToPane, tmux } from "./tmux.ts";
import { childPiArgs, currentModel, currentProvider } from "./session.ts";
import { ensureAgentDefaults, inferRoleKind, now, safeId, shellQuote, sleep } from "./utils.ts";
import { identityPath, mailboxPath, readState, trace, withLock, writeState } from "./state.ts";
import { identityPrompt, writeEffectiveIdentity } from "./identity.ts";
import { responseMissingRecords } from "./mailbox.ts";

// Kickoff preamble injected on spawn/restart when the agent's mailbox holds messages that are not yet
// acked (failed/injected/intercepted without ackedAt). This closes the restart-mailbox gap: a respawned
// agent previously "awaited tasks" with no prompt to read its mailbox, so approvals delivered while the
// pane was down (failed injection, retried by reconcile later) sat unread while the agent idled.
export async function mailboxKickoffPrompt(p: Paths, st: SwarmState, id: string): Promise<string> {
	try {
		const pending = Object.values(st.messages || {}).filter((r) =>
			r.to === id && !r.ackedAt && r.status !== "dead_letter" && !r.superseded,
		);
		if (!pending.length) return "";
		const lines = pending.slice(-10).map((r) => `- ${r.id}${r.subject ? " (subject not stored; see mailbox)" : ""} from ${r.from}, status=${r.status}, requiresAck=${r.requiresAck}`).join("\n");
		return `\n\n[PI-SWARM MAILBOX PENDING]\nYour mailbox has ${pending.length} undelivered/unacked message(s). Read them NOW with swarm_check_mailbox (they may contain work or approvals sent while you were down/restarting) and ack/handle per protocol. Recent:\n${lines}\n[/PI-SWARM MAILBOX PENDING]`;
	} catch { return ""; }
}

export async function spawnAgent(pi: ExtensionAPI, cwd: string, p: Paths, state: SwarmState, input: { id?: string; role: string; roleKind?: string; model?: string; provider?: string; initialPrompt?: string }) {
	const id = safeId(input.id || input.role || `agent-${randomUUID().slice(0, 6)}`);
	if (state.agents[id]?.status === "running") throw new Error(`Agent already exists and is running: ${id}`);
	const model = input.model || currentModel();
	const provider = input.provider || currentProvider(model);
	const providerFallback = !input.provider && provider === DEFAULT_PROVIDER && model !== DEFAULT_MODEL && model !== FAST_MODEL;
	if (providerFallback) await trace(p, "agent.spawn.provider_fallback", { agentId: id, model, provider, note: "no provider configured for model; fell back to DEFAULT_PROVIDER at spawn boundary" }).catch(() => {});
	const window = id;
	const target = `${state.tmuxSession}:${window}.0`;
	const envPrefix = [
		`PI_SWARM_AGENT_ID=${shellQuote(id)}`,
		`PI_SWARM_ID=${shellQuote(state.swarmId)}`,
		`PI_SWARM_DEFAULT_MODEL=${shellQuote(model)}`,
		`PI_SWARM_DEFAULT_PROVIDER=${shellQuote(provider)}`,
	].join(" ");
	const cmd = `${envPrefix} pi --model ${shellQuote(model)} --provider ${shellQuote(provider)} ${childPiArgs()}`;

	try {
		await tmux(pi, ["has-session", "-t", state.tmuxSession], 5_000);
		await tmux(pi, ["new-window", "-t", state.tmuxSession, "-c", cwd, "-n", window, cmd], 10_000);
	} catch (err: any) {
		if (String(err?.message || err).includes("can't find session")) {
			await tmux(pi, ["new-session", "-d", "-s", state.tmuxSession, "-c", cwd, "-n", window, cmd], 10_000);
		} else {
			throw err;
		}
	}

	const ts = now();
	const roleKindExplicit = Boolean(input.roleKind);
	const roleKind = input.roleKind || inferRoleKind(id, input.role);
	const agent: SwarmAgent = {
		id,
		role: input.role,
		roleKind,
		roleKindExplicit,
		capabilities: [],
		activeTaskIds: [],
		maxConcurrentTasks: roleKind === "orchestrator" ? 99 : 1,
		status: "running",
		runtimeStatus: "starting",
		health: "healthy",
		lastSessionStartAt: ts,
		lastAgentStartAt: ts,
		tmuxSession: state.tmuxSession,
		tmuxWindow: window,
		tmuxTarget: target,
		model,
		provider,
		cwd,
		mailbox: relative(cwd, mailboxPath(p, id)),
		createdAt: ts,
		updatedAt: ts,
	};
	state.agents[id] = agent;
	state.delivered[id] ||= [];
	await appendFile(mailboxPath(p, id), "", "utf8");
	const identityFile = identityPath(p, id);
	await writeEffectiveIdentity(cwd, p, state, agent, { reason: "spawn" });
	const identityRelPath = relative(cwd, identityFile);
	await trace(p, "agent.spawn.ok", { agentId: id, tmuxTarget: target, model, provider, role: input.role, identity: identityRelPath });
	await sleep(SPAWN_SETTLE_MS);
	const snapshot = await capturePane(pi, p, id, target, "spawn-after");
	const kickoff = `${input.initialPrompt?.trim() || `You are ${id}. Follow your swarm identity and await tasks.`}${await mailboxKickoffPrompt(p, state, id)}${identityPrompt(cwd, identityRelPath)}`;
	await sendToPane(pi, target, kickoff);
	return { agent, snapshot, identity: identityFile };
}

// Regenerate the effective identity for an agent and (if its tmux pane is alive) inject a reload
// instruction into the pane so the running agent re-reads its identity now. Best-effort: tmux
// injection failure (dead pane, transient error) never fails the reload — the new identity still
// takes effect on the next session_start/identity read. Shared by the `swarm_reload_identity` tool
// and the `/swarm identity reload` command.
// === Agent lifecycle manipulation (register / stop / restart / set_role / pause / send_keys / attach) ===
// These are lock-free cores: the caller (tool or command) holds the swarm lock, reads state, calls the
// core with the live `state` object, and writeState once afterward. The cores may do tmux IO and file
// writes (identity/mailbox) but never acquire the lock themselves, mirroring spawnAgent/deliver.

// Best-effort parse of a tmux target into session + window for cosmetic/derivable fields. The
// authoritative routing field is always `tmuxTarget` itself (used for injection/capture/liveness).
export function parseTmuxTarget(target: string, fallbackSession: string): { session: string; window: string } {
	const t = (target || "").trim();
	if (!t) return { session: fallbackSession, window: "unknown" };
	if (t.startsWith("%")) return { session: fallbackSession, window: t };          // pane id (%5)
	if (t.startsWith("=")) { const s = t.slice(1); return { session: s, window: s }; } // =session
	const colon = t.lastIndexOf(":");
	if (colon >= 0) {
		const session = t.slice(0, colon) || fallbackSession;
		const rest = t.slice(colon + 1);
		const window = rest.includes(".") ? rest.slice(0, rest.lastIndexOf(".")) : rest;
		return { session, window: window || rest || "unknown" };
	}
	const window = t.includes(".") ? t.slice(0, t.lastIndexOf(".")) : t;
	return { session: fallbackSession, window };
}

// Build + inject the [PI-SWARM IDENTITY RELOAD] prompt into an agent pane if it is alive. Best-effort:
// a dead pane or transient tmux error never throws (the new identity still applies on next read).
// Shared by swarm_reload_identity and setAgentRole so the reload prompt stays consistent.
export async function injectReloadIfAlive(pi: ExtensionAPI, p: Paths, agent: SwarmAgent, provenance: { version: number; shortHash: string }, note?: string, source?: string) {
	const file = identityPath(p, agent.id);
	let injected = false;
	let tmuxAlive = false;
	if (agent.tmuxTarget && agent.tmuxTarget !== "unknown") {
		tmuxAlive = await isTmuxRunning(pi, agent.tmuxTarget);
		if (tmuxAlive) {
			const rel = relative(agent.cwd, file);
			const noteLine = note ? ` ${note}` : "";
			try {
				await sendToPane(pi, agent.tmuxTarget, `\n[PI-SWARM IDENTITY RELOAD] Your identity was regenerated (v${provenance.version}, hash ${provenance.shortHash}). Re-read ${rel} now and follow any new instructions.${noteLine}\n`);
				injected = true;
			} catch (err: any) {
				await trace(p, "agent.identity.reload_inject_failed", { agentId: agent.id, source, error: String((err as Error)?.message || err) });
			}
		}
	}
	return { file, tmuxAlive, injected };
}

export async function reloadIdentity(pi: ExtensionAPI, cwd: string, p: Paths, agentId: string, opts?: { note?: string; source?: string }) {
	const { agent, provenance } = await withLock(p, async () => {
		const st = await readState(p, cwd);
		const agent = st.agents[agentId];
		if (!agent) throw new Error(`Unknown swarm agent: ${agentId}`);
		const provenance = await writeEffectiveIdentity(cwd, p, st, agent, { reason: opts?.source ? `reload:${opts.source}` : "reload" });
		await writeState(p, st);
		return { agent, provenance };
	});
	const inj = await injectReloadIfAlive(pi, p, agent, provenance, opts?.note, opts?.source);
	await trace(p, "agent.identity.reload", { agentId, source: opts?.source || "tool", version: provenance.version, hash: provenance.shortHash, overridePresent: provenance.overridePresent, tmuxAlive: inj.tmuxAlive, injected: inj.injected });
	return { agent, provenance, file: inj.file, tmuxAlive: inj.tmuxAlive, injected: inj.injected };
}

// Adopt an EXISTING tmux pane into the swarm under a role WITHOUT spawning a new pi. Upsert by id: a
// re-register with a different target retargets the agent (fixing the "tmuxTarget: unknown" ghost-agent
// case produced by session_start for externally-started agents). The operator asserts the pane is
// available for the role; runtimeStatus defaults to "idle" for a fresh adoption.
export async function registerAgent(pi: ExtensionAPI, cwd: string, p: Paths, state: SwarmState, input: { tmuxTarget: string; id?: string; role: string; roleKind?: string; model?: string; provider?: string; initialPrompt?: string; inject?: boolean }) {
	// Resolve magic "here"/"self"/"current"/"." to the current pane so an operator can register THIS pi
	// session without first discovering its tmux target. Explicit targets pass through unchanged.
	const target = await resolveRegisterTarget(pi, input.tmuxTarget);
	if (!target) throw new Error("tmuxTarget is required: use 'here' for the current pane, or a target like 'session:window.pane', 'session:window', '%paneid', '=session'");
	const id = safeId(input.id || input.role || `agent-${randomUUID().slice(0, 6)}`);
	// The orchestrator is a human-driven coordinating role with no dedicated swarm pane (mailbox-only).
	// It must be created by ensureOrchestrator and opted into explicitly (PI_SWARM_IS_ORCHESTRATOR=1 or
	// `/swarm register here orchestrator`), not adopted as a generic pane agent. Generic registration would
	// hijack its record with a pane target and leave the session unable to actually orchestrate.
	if (id === "orchestrator") throw new Error("Cannot register a pane as 'orchestrator': the orchestrator is a human-driven coordinating role (mailbox-only, no dedicated pane). To make THIS pi session the orchestrator, run `/swarm register here orchestrator [role]`, or relaunch pi with PI_SWARM_IS_ORCHESTRATOR=1.");
	const existing = state.agents[id];
	const tmuxAlive = await isTmuxRunning(pi, target);
	const parsed = parseTmuxTarget(target, state.tmuxSession);
	const model = input.model || existing?.model || currentModel();
	const provider = input.provider || existing?.provider || currentProvider(model);
	const ts = now();
	const roleKindExplicit = input.roleKind !== undefined ? true : (existing?.roleKindExplicit ?? false);
	const roleKind = input.roleKind !== undefined
		? input.roleKind
		: (existing?.roleKindExplicit ? existing.roleKind : inferRoleKind(id, input.role));
	let probeFile: string | null = null;
	let piRunning = false;
	if (tmuxAlive) {
		try { probeFile = await capturePane(pi, p, id, target, "register-probe"); } catch { probeFile = null; }
		if (probeFile) {
			try {
				const txt = await readFile(probeFile, "utf8");
				// Heuristic: look for common pi TUI / swarm markers. Best-effort, never gating.
				piRunning = /\bswarm:|PI[-_ ]?SWARM|\bpi\b.*[\$>#]|\bYou are\b|identity/i.test(txt);
			} catch { /* ignore */ }
		}
	}
	const agent: SwarmAgent = existing ?? {
		id,
		role: input.role,
		roleKind,
		roleKindExplicit,
		capabilities: [],
		activeTaskIds: [],
		maxConcurrentTasks: roleKind === "orchestrator" ? 99 : 1,
		status: "running",
		runtimeStatus: "idle",
		health: "healthy",
		tmuxSession: parsed.session,
		tmuxWindow: parsed.window,
		tmuxTarget: target,
		model,
		provider,
		cwd,
		mailbox: relative(cwd, mailboxPath(p, id)),
		createdAt: ts,
		updatedAt: ts,
	};
	agent.id = id;
	agent.role = input.role;
	agent.roleKind = roleKind;
	agent.roleKindExplicit = roleKindExplicit;
	agent.tmuxSession = parsed.session;
	agent.tmuxWindow = parsed.window;
	agent.tmuxTarget = target;
	agent.model = model;
	agent.provider = provider;
	agent.cwd = cwd;
	agent.mailbox = relative(cwd, mailboxPath(p, id));
	agent.status = "running";
	if (existing) {
		// Retarget/refresh: preserve known runtime state, only clear stale stopped/starting markers.
		if (agent.runtimeStatus === "starting" || agent.runtimeStatus === "stopped") agent.runtimeStatus = "idle";
		if (agent.health === "unhealthy") agent.health = "healthy";
	}
	agent.updatedAt = ts;
	state.agents[id] = agent;
	state.delivered[id] ||= [];
	await appendFile(mailboxPath(p, id), "", "utf8");
	const provenance = await writeEffectiveIdentity(cwd, p, state, agent, { reason: "register" });
	const identityRelPath = relative(cwd, identityPath(p, id));
	let injected = false;
	if (input.inject !== false && tmuxAlive) {
		const kickoff = `${input.initialPrompt?.trim() || `You are ${id}. Follow your swarm identity and await tasks.`}${await mailboxKickoffPrompt(p, state, id)}${identityPrompt(cwd, identityRelPath)}`;
		try { await sendToPane(pi, target, kickoff); injected = true; }
		catch (err: any) { await trace(p, "agent.register.inject_failed", { agentId: id, target, error: String((err as Error)?.message || err) }); }
	}
	await trace(p, "agent.register.ok", { agentId: id, target, tmuxAlive, piRunning, model, provider, role: input.role, roleKind, reRegistered: Boolean(existing), injected, identityVersion: provenance.version });
	return { agent, tmuxAlive, piRunning, injected, identity: identityPath(p, id), probe: probeFile };
}

// Kill an agent's tmux pane/window. Prefers kill-window (each spawned agent owns its window); falls
// back to kill-pane for shared/registered panes. Returns what happened; never throws.
export async function killAgentPane(pi: ExtensionAPI, p: Paths, agent: SwarmAgent): Promise<{ killed: boolean; method: string }> {
	if (!agent.tmuxTarget || agent.tmuxTarget === "unknown") return { killed: false, method: "no-target" };
	const alive = await isTmuxRunning(pi, agent.tmuxTarget);
	if (!alive) return { killed: false, method: "already-dead" };
	const winTarget = agent.tmuxWindow && agent.tmuxWindow !== "unknown" ? `${agent.tmuxSession}:${agent.tmuxWindow}` : agent.tmuxTarget;
	try { await tmux(pi, ["kill-window", "-t", winTarget], 5_000); return { killed: true, method: "kill-window" }; }
	catch { /* shared window or already gone — try the pane only */ }
	try { await tmux(pi, ["kill-pane", "-t", agent.tmuxTarget], 5_000); return { killed: true, method: "kill-pane" }; }
	catch (err: any) { await trace(p, "agent.kill_failed", { agentId: agent.id, target: agent.tmuxTarget, error: String((err as Error)?.message || err) }); return { killed: false, method: "kill-failed" }; }
}

// Stop a long-lived or ephemeral agent. Refuses active tasks unless force. Kills the pane and marks the
// agent stopped (mailbox/identity/history persist via the stable id). Lock-free core (caller holds lock).
export async function stopAgent(pi: ExtensionAPI, p: Paths, state: SwarmState, agentId: string, opts: { force?: boolean; killPane?: boolean } = {}) {
	const agent = state.agents[agentId];
	if (!agent) throw new Error(`Unknown swarm agent: ${agentId}`);
	ensureAgentDefaults(agent);
	if (!opts.force && agent.activeTaskIds.length) {
		throw new Error(`Refusing to stop ${agentId}: active tasks [${agent.activeTaskIds.join(", ")}]. Reassign or release them, or pass force=true.`);
	}
	const ts = now();
	let kill = { killed: false, method: "skipped" as string };
	if (opts.killPane !== false) kill = await killAgentPane(pi, p, agent);
	agent.status = "stopped";
	agent.runtimeStatus = "stopped";
	agent.health = "unhealthy";
	agent.lastShutdownAt ||= ts;
	agent.updatedAt = ts;
	await trace(p, "agent.stop", { agentId, force: Boolean(opts.force), killPane: opts.killPane !== false, ...kill });
	return { agent, ...kill };
}

// Stop + respawn a fresh pi at the SAME id (so mailbox, identity, and history persist). Reuses the
// recorded role/model/provider. For an agent originally registered to an external pane, restart creates
// a fresh swarm-managed window named <id> (the external pane cannot be reliably re-pi'd). Lock-free core.
export async function restartAgent(pi: ExtensionAPI, cwd: string, p: Paths, state: SwarmState, agentId: string, opts: { initialPrompt?: string; model?: string; provider?: string } = {}) {
	const existing = state.agents[agentId];
	if (!existing) throw new Error(`Unknown swarm agent: ${agentId}`);
	ensureAgentDefaults(existing);
	const kill = await killAgentPane(pi, p, existing);
	existing.status = "stopped"; // satisfy spawnAgent's "already running" guard before it overwrites the record
	existing.updatedAt = now();
	await trace(p, "agent.restart.kill", { agentId, ...kill });
	const roleKind = existing.roleKindExplicit ? existing.roleKind : undefined;
	const r = await spawnAgent(pi, cwd, p, state, { id: agentId, role: existing.role, roleKind, model: opts.model || existing.model, provider: opts.provider || existing.provider, initialPrompt: opts.initialPrompt });
	await trace(p, "agent.restart.ok", { agentId, target: r.agent.tmuxTarget, killMethod: kill.method });
	return { kill, ...r };
}

// Change an agent's role/roleKind/capabilities at runtime and regenerate + inject its identity, without
// respawning. roleKind is re-derived from the new role unless roleKind is explicitly passed (pinned).
// Lock-free core (caller holds the lock).
export async function setAgentRole(pi: ExtensionAPI, cwd: string, p: Paths, state: SwarmState, agentId: string, input: { role?: string; roleKind?: string; capabilities?: string[]; note?: string }) {
	const agent = state.agents[agentId];
	if (!agent) throw new Error(`Unknown swarm agent: ${agentId}`);
	if (input.role === undefined && input.roleKind === undefined && input.capabilities === undefined) {
		throw new Error("set_role requires at least one of role, roleKind, or capabilities");
	}
	if (input.role !== undefined) agent.role = input.role;
	if (input.roleKind !== undefined) { agent.roleKind = input.roleKind; agent.roleKindExplicit = true; }
	else if (input.role !== undefined && !agent.roleKindExplicit) agent.roleKind = inferRoleKind(agentId, input.role);
	if (input.capabilities !== undefined) agent.capabilities = Array.from(new Set(input.capabilities.map((c) => String(c).trim()).filter(Boolean)));
	agent.updatedAt = now();
	const provenance = await writeEffectiveIdentity(cwd, p, state, agent, { reason: "set_role" });
	const inj = await injectReloadIfAlive(pi, p, agent, provenance, input.note, "set_role");
	await trace(p, "agent.set_role", { agentId, role: agent.role, roleKind: agent.roleKind, capabilities: agent.capabilities, version: provenance.version, tmuxAlive: inj.tmuxAlive, injected: inj.injected });
	return { agent, provenance, file: inj.file, tmuxAlive: inj.tmuxAlive, injected: inj.injected };
}

// Park/drain an agent from the reuse pool WITHOUT killing its pane. findReusableAgent skips paused
// agents; status/list still show them. Pure state mutation (caller holds the lock).
export function setAgentPaused(state: SwarmState, agentId: string, paused: boolean) {
	const agent = state.agents[agentId];
	if (!agent) throw new Error(`Unknown swarm agent: ${agentId}`);
	if (paused) agent.paused = true; else delete agent.paused;
	agent.updatedAt = now();
	return agent;
}

// Send raw tmux keys to an agent pane. Non-literal mode interprets tmux key names (C-c, Up, Enter);
// literal mode (-l) sends the exact text. Optionally append an Enter. Lock-free core.
export async function sendKeys(pi: ExtensionAPI, p: Paths, target: string, keys: string, opts: { literal?: boolean; enter?: boolean } = {}) {
	if (!target || target === "unknown") throw new Error("agent has no tmux pane target");
	if (opts.literal) {
		await tmux(pi, ["send-keys", "-t", target, "-l", keys], 10_000);
	} else {
		const tokens = keys.split(/\s+/).filter(Boolean);
		if (tokens.length) await tmux(pi, ["send-keys", "-t", target, ...tokens], 10_000);
	}
	if (opts.enter) await tmux(pi, ["send-keys", "-t", target, "Enter"], 10_000);
	await sleep(120);
}

// Pure helper: the tmux commands a human would run to jump into an agent's pane.
export function attachTarget(agent: SwarmAgent) {
	const winTarget = agent.tmuxWindow && agent.tmuxWindow !== "unknown" ? `${agent.tmuxSession}:${agent.tmuxWindow}` : agent.tmuxTarget;
	return {
		session: agent.tmuxSession,
		windowTarget: winTarget,
		paneTarget: agent.tmuxTarget,
		attach: `tmux attach -t ${agent.tmuxSession}`,
		selectWindow: `tmux select-window -t ${winTarget}`,
		selectPane: `tmux select-pane -t ${agent.tmuxTarget}`,
	};
}

export async function findReusableAgent(pi: ExtensionAPI, st: SwarmState, opts: { roleKind?: string; capabilities?: string[]; requireIdle?: boolean; requireTmuxAlive?: boolean; includeBusy?: boolean }): Promise<{ matches: ReusableAgentMatch[]; recommended?: string }> {
	const wantKind = opts.roleKind;
	const wantCaps = new Set((opts.capabilities || []).map((c) => c.toLowerCase()));
	const matches: ReusableAgentMatch[] = [];
	for (const agent of Object.values(st.agents)) {
		if (agent.id === "orchestrator") continue; // never reuse the human-driven orchestrator
		ensureAgentDefaults(agent);
		if (agent.paused) continue; // paused/drain: parked but not killed — excluded from the reuse pool
		if (wantKind && agent.roleKind !== wantKind) continue;
		if (wantCaps.size && !agent.capabilities.map((c) => c.toLowerCase()).some((c) => wantCaps.has(c))) continue;
		const responseMissing = responseMissingRecords(st, agent.id).length;
		if (responseMissing > 0) continue;
		const idle = agent.runtimeStatus === "idle";
		if (opts.requireIdle && !idle) continue;
		if (!opts.includeBusy && !idle && agent.activeTaskIds.length >= agent.maxConcurrentTasks) continue;
		const tmuxAlive = agent.tmuxTarget && agent.tmuxTarget !== "unknown" ? await isTmuxRunning(pi, agent.tmuxTarget) : false;
		if (opts.requireTmuxAlive && !tmuxAlive) continue;
		matches.push({ agentId: agent.id, roleKind: agent.roleKind, runtimeStatus: agent.runtimeStatus, health: agent.health, tmuxAlive, activeTaskIds: agent.activeTaskIds, capabilities: agent.capabilities });
	}
	const score = (m: ReusableAgentMatch) => (m.runtimeStatus === "idle" ? 0 : 1) + (m.health === "healthy" ? 0 : 2) + (m.tmuxAlive ? 0 : 4) + m.activeTaskIds.length;
	matches.sort((a, b) => score(a) - score(b));
	return { matches, recommended: matches[0]?.agentId };
}
