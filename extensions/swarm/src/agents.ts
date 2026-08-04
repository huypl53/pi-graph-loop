// === swarm/agents.ts — auto-extracted from index.ts (verbatim bodies) ===
import { defineTool, CONFIG_DIR_NAME, truncateHead, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, writeFile, appendFile, rm, stat, rename, readdir, realpath } from "node:fs/promises";
import { join, dirname, relative, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { Paths, ReusableAgentMatch, SwarmAgent, SwarmState } from "./types.ts";
import { SPAWN_SETTLE_MS } from "./constants.ts";
import { capturePane, isTmuxRunning, sendToPane, tmux } from "./tmux.ts";
import { childPiArgs, currentModel, currentProvider } from "./session.ts";
import { ensureAgentDefaults, inferRoleKind, now, safeId, shellQuote, sleep } from "./utils.ts";
import { identityPath, mailboxPath, readState, trace, withLock, writeState } from "./state.ts";
import { identityPrompt, writeEffectiveIdentity } from "./identity.ts";
import { responseMissingRecords } from "./mailbox.ts";

export async function spawnAgent(pi: ExtensionAPI, cwd: string, p: Paths, state: SwarmState, input: { id?: string; role: string; roleKind?: string; model?: string; provider?: string; initialPrompt?: string }) {
	const id = safeId(input.id || input.role || `agent-${randomUUID().slice(0, 6)}`);
	if (state.agents[id]?.status === "running") throw new Error(`Agent already exists and is running: ${id}`);
	const model = input.model || currentModel();
	const provider = input.provider || currentProvider(model);
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
	const kickoff = `${input.initialPrompt?.trim() || `You are ${id}. Follow your swarm identity and await tasks.`}${identityPrompt(cwd, identityRelPath)}`;
	await sendToPane(pi, target, kickoff);
	return { agent, snapshot, identity: identityFile };
}

// Regenerate the effective identity for an agent and (if its tmux pane is alive) inject a reload
// instruction into the pane so the running agent re-reads its identity now. Best-effort: tmux
// injection failure (dead pane, transient error) never fails the reload — the new identity still
// takes effect on the next session_start/identity read. Shared by the `swarm_reload_identity` tool
// and the `/swarm identity reload` command.
export async function reloadIdentity(pi: ExtensionAPI, cwd: string, p: Paths, agentId: string, opts?: { note?: string; source?: string }) {
	const result = await withLock(p, async () => {
		const st = await readState(p, cwd);
		const agent = st.agents[agentId];
		if (!agent) throw new Error(`Unknown swarm agent: ${agentId}`);
		const provenance = await writeEffectiveIdentity(cwd, p, st, agent, { reason: opts?.source ? `reload:${opts.source}` : "reload" });
		await writeState(p, st);
		return { agent, provenance };
	});
	const { agent, provenance } = result;
	const file = identityPath(p, agentId);
	let injected = false;
	let tmuxAlive = false;
	if (agent.tmuxTarget && agent.tmuxTarget !== "unknown") {
		tmuxAlive = await isTmuxRunning(pi, agent.tmuxTarget);
		if (tmuxAlive) {
			const rel = relative(agent.cwd, file);
			const noteLine = opts?.note ? ` ${opts.note}` : "";
			try {
				await sendToPane(pi, agent.tmuxTarget, `\n[PI-SWARM IDENTITY RELOAD] Your identity was regenerated (v${provenance.version}, hash ${provenance.shortHash}). Re-read ${rel} now and follow any new instructions.${noteLine}\n`);
				injected = true;
			} catch (err: any) {
				await trace(p, "agent.identity.reload_inject_failed", { agentId, source: opts?.source, error: String((err as Error)?.message || err) });
			}
		}
	}
	await trace(p, "agent.identity.reload", { agentId, source: opts?.source || "tool", version: provenance.version, hash: provenance.shortHash, overridePresent: provenance.overridePresent, tmuxAlive, injected });
	return { agent, provenance, file, tmuxAlive, injected };
}

export async function findReusableAgent(pi: ExtensionAPI, st: SwarmState, opts: { roleKind?: string; capabilities?: string[]; requireIdle?: boolean; requireTmuxAlive?: boolean; includeBusy?: boolean }): Promise<{ matches: ReusableAgentMatch[]; recommended?: string }> {
	const wantKind = opts.roleKind;
	const wantCaps = new Set((opts.capabilities || []).map((c) => c.toLowerCase()));
	const matches: ReusableAgentMatch[] = [];
	for (const agent of Object.values(st.agents)) {
		if (agent.id === "orchestrator") continue; // never reuse the human-driven orchestrator
		ensureAgentDefaults(agent);
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
