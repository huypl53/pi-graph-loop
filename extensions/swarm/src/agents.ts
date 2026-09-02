// === swarm/agents.ts — auto-extracted from index.ts (verbatim bodies) ===
import { defineTool, CONFIG_DIR_NAME, truncateHead, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, writeFile, appendFile, rm, stat, rename, readdir, realpath } from "node:fs/promises";
import { join, dirname, relative, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { Paths, PreflightError, RecentSpawn, ReusableAgentMatch, SwarmAgent, SwarmState } from "./types.ts";
import { DEFAULT_MODEL, DEFAULT_PROVIDER, ORPHAN_SPAWN_WARNING_TIMEOUT_MS, SPAWN_SETTLE_MS } from "./constants.ts";
import { capturePane, isTmuxRunning, resolveRegisterTarget, sendToPane, tmux } from "./tmux.ts";
import { childPiArgs, currentAgentId, currentModel, currentProvider } from "./session.ts";
import { pickSlot, poolStatus, preflightSpawn, formatPreflightError } from "./pool.ts";
import { ensureAgentDefaults, inferRoleKind, now, safeId, shellQuote, sleep } from "./utils.ts";
import { identityPath, mailboxPath, paths, readState, trace, withLock, writeState } from "./state.ts";
import { identityPrompt, writeEffectiveIdentity } from "./identity.ts";
import { responseMissingRecords } from "./mailbox.ts";

// Orphan-spawn watchdog (Issue 14): in-process timer handles keyed by agentId. Not serialized into
// swarm-state.json because NodeJS.Timeout references cannot survive JSON.stringify (and a process
// restart simply strands the entry — see docs/swarm/operations.md v1 limitation). Persistent state
// lives on SwarmState.recentSpawns[] (readState back-fills `[]`); the map below is a hint to cancel
// pending timers when the follow-up call clears the entry, NOT the source of truth.
const ORPHAN_TIMERS = new Map<string, NodeJS.Timeout>();

// Pure helper for tests / shared code: how many orphan-watch entries are currently armed in state.
// Reflects the persistent ledger (NOT the in-process timer map) so it survives a process restart.
export function recentSpawnCount(state: SwarmState): number {
	return Array.isArray(state.recentSpawns) ? state.recentSpawns.length : 0;
}

// Fire path for the orphan-watch timer. Called from a setTimeout callback; acquires the swarm lock
// before mutating state. Self-check scans st.messages for any inbound message addressed to the
// agent with createdAt >= spawnedAt — if a delivery raced ahead, traces `orphan_resolved_late`
// instead of `orphan_warning` (race backstop, see plan §4.3). Locking is intentionally idempotent:
// a follow-up call that cleared the entry between timer fire and lock acquisition finds nothing
// and returns silently.
export async function fireOrphanWarning(p: Paths, agentId: string, spawnEntry: RecentSpawn) {
	const deadlineAgeMs = Math.max(0, Date.now() - new Date(spawnEntry.deadlineAt).getTime());
	const cleared = await withLock(p, async () => {
		const st = await readState(p, p.root);
		if (!Array.isArray(st.recentSpawns) || st.recentSpawns.length === 0) return { fired: false, reason: "empty" };
		const idx = st.recentSpawns.findIndex((s) => s.agentId === agentId);
		if (idx === -1) return { fired: false, reason: "cleared" };
		// Race backstop: any inbound message at or after spawnedAt counts as resolved (the clear
		// helper is best-effort; a third-party delivery path could close the orphan via a tool the
		// helper does not yet cover). Scan once; exit silently if a message is found.
		const inbound = Object.values(st.messages || {}).filter((m) => m.to === agentId && m.createdAt >= spawnEntry.spawnedAt);
		if (inbound.length > 0) {
			st.recentSpawns.splice(idx, 1);
			await writeState(p, st);
			await trace(p, "agent.spawn.orphan_resolved_late", { agentId, spawnedAt: spawnEntry.spawnedAt, deadlineAt: spawnEntry.deadlineAt, resolver: "pre-existing-message", messageIds: inbound.map((m) => m.id) }).catch(() => {});
			return { fired: true, kind: "resolved_late" as const, messageIds: inbound.map((m) => m.id) };
		}
		st.recentSpawns.splice(idx, 1);
		await writeState(p, st);
		await trace(p, "agent.spawn.orphan_warning", { agentId, spawnedAt: spawnEntry.spawnedAt, deadlineAt: spawnEntry.deadlineAt, ageMs: deadlineAgeMs, source: "swarm_spawn_agent" }).catch(() => {});
		return { fired: true, kind: "orphan_warning" as const };
	});
	// Best-effort: drop the in-process timer handle too (the persistent entry is already gone).
	ORPHAN_TIMERS.delete(agentId);
	return cleared;
}

// Arm site: push a fresh RecentSpawn onto the live SwarmState + set the in-process timer. Called
// only from spawnAgent when isNewRecord is true (the fresh-record branch; reuse/restart/register
// paths skip this entirely). Caller MUST hold the swarm lock and pass the live SwarmState reference.
export function armOrphanWatch(p: Paths, st: SwarmState, agentId: string, ts: string) {
	const deadlineAt = new Date(new Date(ts).getTime() + ORPHAN_SPAWN_WARNING_TIMEOUT_MS).toISOString();
	// Issue 16: stamp the spawning session's identity onto the RecentSpawn entry so the pre-clear
	// predicate in swarm_assign_task can match without re-reading env at compare time. We use the
	// *caller's* pid + sessionStartedAt directly rather than the live orchestratorLeader record
	// because swarm_spawn_agent does NOT run a leader heartbeat (the leader contract is enforced at
	// the assign site, not the spawn site). The leader record at arm time may be vacant — that's
	// normal for the operator's first tool call after PM opt-in, and we still want the subsequent
	// assign_task to pre-clear.
	const spawnedByPid = process.pid;
	const spawnedBySessionStartedAt = process.env.PI_SWARM_SESSION_STARTED_AT || ts;
	const entry: RecentSpawn = { agentId, spawnedAt: ts, deadlineAt, spawnedByPid, spawnedBySessionStartedAt };
	st.recentSpawns = Array.isArray(st.recentSpawns) ? st.recentSpawns : [];
	st.recentSpawns.push(entry);
	const timer = setTimeout(() => {
		fireOrphanWarning(p, agentId, entry).catch(() => {});
	}, ORPHAN_SPAWN_WARNING_TIMEOUT_MS);
	// Don't keep the Node event loop alive solely for orphan watches; the timer is best-effort and
	// the persistent entry in state is the source of truth across restarts.
	if (typeof (timer as any)?.unref === "function") (timer as any).unref();
	ORPHAN_TIMERS.set(agentId, timer);
	void trace(p, "agent.spawn.orphan_watch_start", { agentId, deadlineAt, timeoutMs: ORPHAN_SPAWN_WARNING_TIMEOUT_MS }).catch(() => {});
}

// Clear site (Issue 14, B1 binding): removes the RecentSpawn entry from state, cancels the
// in-process timer, and traces `agent.spawn.orphan_cleared` with the trigger reason. Called from
// mailbox.deliverMessageLocked (any successful delivery to the agent) and stopAgent core
// (intentional termination BEFORE killAgentPane). No-op if the agent has no entry (reuse path,
// pre-policy swarm, or already cleared). Caller MUST hold the swarm lock and pass the live state
// reference; the trace is best-effort and never throws.
export type OrphanClearReason = "swarm_send_message" | "swarm_assign_task" | "swarm_stop_agent" | "preflight_message";
// Issue 16: distinguish why a clear happened. The `by` field stays the call site for back-compat
// with existing test assertions; the new `kind` field carries "preflight" vs "delivery" for ops
// observability.
export type OrphanClearKind = "preflight" | "delivery";

// Issue 16: compare a RecentSpawn stamp against a caller's session identity. Returns false when
// the entry lacks a stamp (legacy pre-Issue-16 state — never preempt so we don't accidentally
// surface a fresh warning as a false-positive resolution).
export function isSameOrchestratorLeader(spawn: RecentSpawn, caller: {
	pid: number;
	sessionStartedAt?: string; // from PI_SWARM_SESSION_STARTED_AT
}): boolean {
	if (typeof spawn.spawnedByPid !== "number") return false;     // legacy entry: never preempt
	if (spawn.spawnedByPid !== caller.pid) return false;          // different process
	if (spawn.spawnedBySessionStartedAt && caller.sessionStartedAt &&
		spawn.spawnedBySessionStartedAt !== caller.sessionStartedAt) return false; // pid recycled
	return true;
}

export async function clearOrphanWatch(p: Paths, st: SwarmState, agentId: string, reason: OrphanClearReason, kind: OrphanClearKind = "delivery") {
	if (!Array.isArray(st.recentSpawns) || st.recentSpawns.length === 0) return { cleared: false, reason: "empty" };
	const idx = st.recentSpawns.findIndex((s) => s.agentId === agentId);
	if (idx === -1) return { cleared: false, reason: "not-found" };
	const [removed] = st.recentSpawns.splice(idx, 1);
	const t = ORPHAN_TIMERS.get(agentId);
	if (t) { clearTimeout(t); ORPHAN_TIMERS.delete(agentId); }
	await trace(p, "agent.spawn.orphan_cleared", { agentId, by: reason, reason: kind, clearedBy: currentAgentId(), spawnedAt: removed.spawnedAt, deadlineAt: removed.deadlineAt, spawnedByPid: removed.spawnedByPid, spawnedBySessionStartedAt: removed.spawnedBySessionStartedAt }).catch(() => {});
	return { cleared: true, reason, kind, removed };
}

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

export async function spawnAgent(pi: ExtensionAPI, cwd: string, p: Paths, state: SwarmState, input: { id?: string; role: string; roleKind?: string; model?: string; provider?: string; initialPrompt?: string; isNewRecord?: boolean }) {
	const id = safeId(input.id || input.role || `agent-${randomUUID().slice(0, 6)}`);
	if (state.agents[id]?.status === "running") throw new Error(`Agent already exists and is running: ${id}`);
	// Orphan-spawn watchdog (Issue 14): decide whether this invocation mints a NEW agent record.
	// Excludes restart (restartAgent sets existing.status="stopped" before calling), re-spawn of an
	// existing stopped id (the operator knows the id and intends to refresh, not orphan), pool reuse
	// (findReusableAgent never calls spawnAgent), and register/register-adopt (different function).
	// The flag is explicit so tests can drive the fresh-vs-refresh distinction deterministically.
	const isNewRecord = input.isNewRecord ?? (state.agents[id] === undefined);
	// Preflight: validate settings + pool eligibility + tmux prereqs BEFORE we commit a swarm-state
	// record. Read-only — never mutates settings or pool health; surfaces classified errors so the
	// operator gets an actionable message instead of a half-spawned window. The tmux session probe
	// here is best-effort; spawnAgent itself still attempts new-session fallback below.
	const preflight = await preflightSpawn(p, { model: input.model, provider: input.provider, tmuxSession: state.tmuxSession });
	if (preflight.ok === false) {
		// Discriminated union: TS narrows preflight to { ok: false; error: PreflightError } here.
		const err: PreflightError = preflight.error;
		throw new Error(formatPreflightError(err));
	}
	// Model resolution: explicit input wins; otherwise the model pool (if configured) picks a
	// healthy slot via weighted/rr/sticky rotation; otherwise the single default.
	let model = input.model;
	let provider = input.provider;
	let poolReason: string | undefined;
	if (!model) {
		// Issue 22 roles-filter: resolve the intended roleKind with the same logic that stamps the
		// record below (input.roleKind || inferRoleKind(id, role)) so the filter and the persisted
		// roleKind cannot disagree.
		const intendedRoleKind = input.roleKind || inferRoleKind(id, input.role);
		const picked = await pickSlot(p, { stickyKey: id, roleKind: intendedRoleKind });
		if (picked) {
			model = picked.slot.model;
			provider = picked.slot.provider || currentProvider(model);
			poolReason = picked.reason;
		} else {
			// Issue 22 fallback: every pool slot was filtered out for this roleKind. Retry once
			// WITHOUT the filter so the worker always starts; trace for operator visibility.
			const fallback = await pickSlot(p, { stickyKey: id });
			if (fallback) {
				await trace(p, "pool.role_filter_all_filtered_fallback", {
					agentId: id, roleKind: intendedRoleKind,
					to: `${fallback.slot.provider || "(default)"}/${fallback.slot.model}`,
					reason: fallback.reason,
					note: "no slot matched role filter; spawned without filter so the worker can start",
				}).catch(() => {});
				model = fallback.slot.model;
				provider = fallback.slot.provider || currentProvider(model);
				poolReason = fallback.reason;
			} else {
				model = currentModel();
				provider = currentProvider(model);
			}
		}
	} else {
		provider = provider || currentProvider(model);
	}
	if (poolReason) await trace(p, "pool.spawn_pick", { agentId: id, slot: `${provider}/${model}`, reason: poolReason }).catch(() => {});
	const providerFallback = !input.provider && !poolReason && provider === DEFAULT_PROVIDER && model !== DEFAULT_MODEL;
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
	// Orphan-spawn watchdog arm (Issue 14): only on the fresh-record path. restartAgent passes
	// isNewRecord=false explicitly; direct re-spawn of an existing stopped id also skips (the
	// default derives from `state.agents[id] === undefined` and will be false). The arm pushes a
	// RecentSpawn onto state.recentSpawns[] AND schedules the in-process timer; if the spawn throws
	// before this point the watchdog was never armed so no cleanup is required.
	if (isNewRecord) armOrphanWatch(p, state, id, ts);
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
	// Orphan-spawn watchdog clear (Issue 14, B5 binding): cancel BEFORE killAgentPane so the timer
	// cannot fire mid-stop and emit a stale orphan_warning trace for an agent being intentionally
	// terminated. clearOrphanWatch is a no-op when the agent has no entry (e.g. reuse path).
	const ts = now();
	await clearOrphanWatch(p, state, agentId, "swarm_stop_agent").catch(() => {});
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
// recorded role/model/provider unless a new model is passed OR the recorded slot has been benched by
// the pool (health cooldown) — in that case the pool picks a replacement slot for the failover.
// a fresh swarm-managed window named <id> (the external pane cannot be reliably re-pi'd). Lock-free core.
export async function restartAgent(pi: ExtensionAPI, cwd: string, p: Paths, state: SwarmState, agentId: string, opts: { initialPrompt?: string; model?: string; provider?: string; rotateFromSlot?: string } = {}) {
	const existing = state.agents[agentId];
	if (!existing) throw new Error(`Unknown swarm agent: ${agentId}`);
	ensureAgentDefaults(existing);
	const kill = await killAgentPane(pi, p, existing);
	existing.status = "stopped"; // satisfy spawnAgent's "already running" guard before it overwrites the record
	existing.updatedAt = now();
	await trace(p, "agent.restart.kill", { agentId, ...kill });
	// Preflight (restart): same checks as spawn, but before we commit to a new spawn. Pool failover
	// already plans a replacement slot; preflight catches the case where the replacement is also bad
	// (e.g. all slots benched, tmux down) so we fail fast instead of leaving a half-restarted agent.
	const preflight = await preflightSpawn(p, { model: opts.model, provider: opts.provider, tmuxSession: state.tmuxSession });
	if (preflight.ok === false) {
		// Discriminated union: TS narrows preflight to { ok: false; error: PreflightError } here.
		const err: PreflightError = preflight.error;
		throw new Error(formatPreflightError(err));
	}
	const roleKind = existing.roleKindExplicit ? existing.roleKind : undefined;
	// Pool failover: if the caller signals the old slot failed (rotateFromSlot = slot key), or the
	// recorded slot is currently benched, let spawnAgent re-pick from the pool instead of reusing it.
	let model = opts.model;
	let provider = opts.provider;
	if (!model) {
		const status = await poolStatus(p);
		const benched = status.slots.find((s) => s.model === existing.model && (s.provider || "(default)") === (existing.provider || "(default)"));
		if (benched && (opts.rotateFromSlot || benched.inCooldown)) {
			const picked = await pickSlot(p, { stickyKey: agentId, avoidKey: benched.key });
			if (picked) {
				model = picked.slot.model;
				provider = picked.slot.provider || currentProvider(picked.slot.model);
				await trace(p, "pool.failover", { agentId, from: benched.key, to: `${provider}/${model}`, reason: picked.reason }).catch(() => {});
			}
		}
	}
	// isNewRecord:false because restart reuses an existing record (existing.status was set to
	// "stopped" above so the spawn guard accepts the overwrite). The orphan-watch watchdog must NOT
	// fire on a restart — the agent was already known to other agents and has a durable id.
	const r = await spawnAgent(pi, cwd, p, state, { id: agentId, role: existing.role, roleKind, model, provider, initialPrompt: opts.initialPrompt, isNewRecord: false });
	await trace(p, "agent.restart.ok", { agentId, target: r.agent.tmuxTarget, killMethod: kill.method, model: r.agent.model, provider: r.agent.provider });
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

// Same-task active-lease guard (roadmap issue 10): when the caller passes `excludeTaskId`,
// skip an agent that is ALREADY actively working on that task. An agent that has settled
// (runtimeStatus === "idle") with a stale activeTaskIds pointer is OK — the existing
// reclaim path (reconcile, /swarm release) handles that, not the reuse predicate. The
// carve-out prevents churn when a worker briefly settles between tool calls and the
// reuse lookup misroutes around it.
type MatchOpts = {
	roleKind?: string;
	capabilities?: string[];
	requireIdle?: boolean;
	requireTmuxAlive?: boolean;
	includeBusy?: boolean;
	excludeTaskId?: string;
	// Escape-hatch: an exact agentId bypasses the role-kind + active-lease gate. Used by
	// swarm_assign_task(agentId=...) to honor an explicit caller request even when reuse
	// would otherwise skip the agent. We do NOT honor escape-hatch capabilities here — the
	// caller passes them through normal opts.capabilities.
	agentId?: string;
};

// Pure predicate: no I/O, no tmux probes. Given the live SwarmState and an options object,
// returns every agent that COULD match the reuse contract (excluding runtime liveness). The
// wrapper `findReusableAgent` runs this, then enriches each match with `tmuxAlive` for the
// scoring sort. Extracted so the reuse-misroute test can exercise the role-kind /
// active-lease / escape-hatch rules directly without a mock pi.
export function matchReusableAgents(st: SwarmState, opts: MatchOpts = {}): ReusableAgentMatch[] {
	const wantKind = opts.roleKind;
	const wantCaps = new Set((opts.capabilities || []).map((c) => c.toLowerCase()));
	const escapeAgentId = opts.agentId ? safeId(opts.agentId) : undefined;
	const excludeTaskId = opts.excludeTaskId;
	const hasCapsRequest = wantCaps.size > 0;
	const matches: ReusableAgentMatch[] = [];
	for (const agent of Object.values(st.agents)) {
		if (agent.id === "orchestrator") continue; // never reuse the human-driven orchestrator
		ensureAgentDefaults(agent);
		if (agent.paused) continue; // paused/drain: parked but not killed — excluded from the reuse pool
		// Escape-hatch (Issue 10 §3.2 step 3): an explicit agentId bypasses the role-kind check AND
		// the same-task active-lease guard AND the includeBusy / maxConcurrentTasks cap so a
		// deliberate caller request always wins. Paused + responseMissing are still hard-excluded
		// (safety invariants, not reuse-policy gates).
		const isEscape = escapeAgentId !== undefined && escapeAgentId === agent.id;
		// Re-derive the agent's role-kind so a stale or never-set roleKind field cannot drift
		// matching. The OR with the recorded roleKind field catches two cases:
		//   (a) stale roleKind on a pinned agent (re-derive wins)
		//   (b) substring collision (e.g. `plan-reviewer` roleKind="reviewer" field, but the
		//       inferred kind from id is "planner" — for `planner` reuse this agent must NOT be
		//       selected; for `reviewer` reuse the field matches AND the inference also matches,
		//       so it stays a valid match)
		const rederived = inferRoleKind(agent.id, agent.role);
		// Capability match (escape-hatch #2): at least one of the requested capabilities is
		// present. Capabilities are an additive escape-hatch that BYPASSES the role-kind check
		// (so a tester with `review` capability can fill a reviewer-kind request) but does NOT
		// bypass paused / responseMissing / same-task active-lease guard (caller safety).
		const capsMatch = hasCapsRequest && agent.capabilities.map((c) => c.toLowerCase()).some((c) => wantCaps.has(c));
		let matchKind: "exact" | "substring-collapsed" | "fallback" | undefined;
		if (isEscape) {
			matchKind = "fallback";
		} else if (wantKind) {
			const fieldMatches = agent.roleKind === wantKind;
			const inferredMatches = rederived === wantKind;
			if (fieldMatches && inferredMatches) {
				matchKind = "exact";
			} else if (fieldMatches && !inferredMatches) {
				matchKind = "substring-collapsed";
			} else if (!fieldMatches && inferredMatches) {
				matchKind = "exact";
			} else {
				// Neither field nor inferred matches the wanted kind. The agent may still match
				// via the capabilities escape-hatch; if not, exclude below.
				matchKind = capsMatch ? "fallback" : undefined;
			}
		} else {
			matchKind = capsMatch ? "fallback" : undefined;
		}
		if (!matchKind) continue;
		// Same-task active-lease guard: skip if the agent currently has an active lease on
		// excludeTaskId AND is not idle. The idle carve-out lets reclaim handle stale pointers
		// instead of duplicating the reclaim logic here. Escape-hatch bypasses this guard.
		if (!isEscape && excludeTaskId && agent.activeTaskIds.includes(excludeTaskId) && agent.runtimeStatus !== "idle") continue;
		const responseMissing = responseMissingRecords(st, agent.id).length;
		if (responseMissing > 0) continue;
		const idle = agent.runtimeStatus === "idle";
		if (opts.requireIdle && !idle) continue;
		// Escape-hatch bypasses the includeBusy + maxConcurrentTasks cap so the caller request
		// always wins (the caller has explicit information about the agent it wants).
		if (!isEscape && !opts.includeBusy && !idle && agent.activeTaskIds.length >= agent.maxConcurrentTasks) continue;
		matches.push({ agentId: agent.id, roleKind: agent.roleKind, runtimeStatus: agent.runtimeStatus, health: agent.health, tmuxAlive: false, activeTaskIds: agent.activeTaskIds, capabilities: agent.capabilities, matchKind });
	}
	return matches;
}

export async function findReusableAgent(pi: ExtensionAPI, st: SwarmState, opts: MatchOpts & { isTmuxAlive?: (agent: SwarmAgent) => Promise<boolean> }): Promise<{ matches: ReusableAgentMatch[]; recommended?: string }> {
	// The pure predicate does the role-kind + active-lease + escape-hatch work; we layer
	// tmux liveness on top via the optional `isTmuxAlive` adapter (default: real tmux probe).
	// This split lets `matchReusableAgents` be unit-tested without a mock pi.
	const isAlive = opts.isTmuxAlive || (async (agent: SwarmAgent) => agent.tmuxTarget && agent.tmuxTarget !== "unknown" ? await isTmuxRunning(pi, agent.tmuxTarget) : false);
	const candidates = matchReusableAgents(st, opts);
	const matches: ReusableAgentMatch[] = [];
	for (const m of candidates) {
		const agent = st.agents[m.agentId];
		if (!agent) continue;
		const tmuxAlive = await isAlive(agent);
		if (opts.requireTmuxAlive && !tmuxAlive) continue;
		matches.push({ ...m, tmuxAlive });
	}
	const score = (m: ReusableAgentMatch) => (m.runtimeStatus === "idle" ? 0 : 1) + (m.health === "healthy" ? 0 : 2) + (m.tmuxAlive ? 0 : 4) + m.activeTaskIds.length;
	matches.sort((a, b) => score(a) - score(b));
	// reuse.match_kind trace (roadmap issue 10): surface every substring-collapsed or fallback
	// match so callers/ops can audit why a non-exact match was selected. Pure informational;
	// never mutates state. Uses st.cwd to derive paths — every caller holds the same cwd via
	// ctx.cwd, so this is consistent.
	try {
		const p = paths(st.cwd);
		const kinds = matches.reduce<Record<string, number>>((acc, m) => { acc[m.matchKind || "exact"] = (acc[m.matchKind || "exact"] || 0) + 1; return acc; }, {});
		await trace(p, "reuse.match_kind", { roleKind: opts.roleKind || null, excludeTaskId: opts.excludeTaskId || null, counts: kinds, recommended: matches[0]?.agentId || null }).catch(() => {});
	} catch { /* trace is informational; never fail reuse on it */ }
	return { matches, recommended: matches[0]?.agentId };
}

// === R20 — deriveTaskProgressState ===
// Pure-function helper. Collapses the 12-field swarm_agent_status observation into a single
// mutually-exclusive taskProgressState (dead | idle_blocked | completed_unverified | stalled |
// active | awaiting_input). The orchestrator's "3 đường kiểm chứng" rule becomes:
//   1. read taskProgressState
//   2. cross-check against disk artifacts
//   3. cross-check against mailbox/response debt
// State precedence is fixed: the first matching predicate wins. This file's exhaustive tests
// (extensions/swarm/agent-status-derive.test.mjs) cover all 6 states + exclusivity.
//
// Parameters:
//   - agent: the SwarmAgent record (live or synthetic).
//   - st: the live SwarmState (mailbox state read-only).
//   - ctx: { nowMs, artifactMtimeMs?, tmuxAlive? } — optional, defaults to fs.stat computed by
//     the caller for the agent's task-relevant file. `tmuxAlive` is supplied by the caller
//     because the agent record's cached `tmuxAlive` is stale-by-design (see taskgraph.ts).
//
// Returns one of:
//   - "dead":                 tmuxAlive === false OR lastHeartbeatAt > 60s ago
//   - "idle_blocked":         responseMissing > 0 OR ackMissing > 0 OR deadLetters > 0
//   - "completed_unverified": artifact mtime in last 5 min AND activeTaskIds.length > 0 AND verifiedResultMsgId === null
//   - "stalled":              activeTaskIds.length > 0 AND lastToolAt > 10 min ago AND verifiedResultMsgId === null
//   - "active":               lastToolAt < 60s ago OR (artifact mtime < 5 min AND activeTaskIds.length > 0 AND NOT yet settled)
//   - "awaiting_input":       (otherwise)
export type TaskProgressState =
	| "active"
	| "stalled"
	| "completed_unverified"
	| "awaiting_input"
	| "idle_blocked"
	| "dead";

export type DeriveTaskProgressStateCtx = {
	nowMs?: number;
	artifactMtimeMs?: number | null;
	tmuxAlive?: boolean | null;
};

const DEAD_HEARTBEAT_MS = 60_000;
const ACTIVE_LAST_TOOL_MS = 60_000;
const STALLED_LAST_TOOL_MS = 10 * 60_000;
const ARTIFACT_FRESH_MS = 5 * 60_000;

export function deriveTaskProgressState(
	agent: SwarmAgent,
	st: SwarmState,
	ctx: DeriveTaskProgressStateCtx = {},
): TaskProgressState {
	const nowMs = typeof ctx.nowMs === "number" ? ctx.nowMs : Date.now();

	// 1) dead: tmuxAlive === false OR lastHeartbeatAt > 60s ago
	// `tmuxAlive` defaults to TRUE when absent on the agent record (the field is supplied
	// fresh by the swarm_agent_status tool via a live tmux probe; absent == unknown, which we
	// treat as alive so we don't dead-false-positive on legacy / synthetic records).
	const tmuxAlive = ctx.tmuxAlive === undefined ? (agent.tmuxAlive === undefined ? true : Boolean(agent.tmuxAlive)) : ctx.tmuxAlive;
	const hbMs = agent.lastHeartbeatAt ? new Date(agent.lastHeartbeatAt).getTime() : 0;
	if (tmuxAlive === false) return "dead";
	if (hbMs && nowMs - hbMs > DEAD_HEARTBEAT_MS) return "dead";

	// 2) idle_blocked: responseMissing > 0 OR ackMissing > 0 OR deadLetters > 0
	const messages = Object.values(st.messages || {}).filter((m) => m.to === agent.id);
	let responseMissing = 0;
	let ackMissing = 0;
	let deadLetters = 0;
	for (const m of messages) {
		const responseTrackingActive =
			m.requiresResponse &&
			m.status !== "dead_letter" &&
			m.status !== "queued" &&
			(m.status !== "failed" || Boolean(m.lastAck));
		if (responseTrackingActive && m.response?.status !== "verified" && m.response?.status !== "waived") {
			responseMissing++;
		}
		if (m.requiresAck && Boolean(m.ackMissingAt) && !m.ackedAt) ackMissing++;
		if (m.status === "dead_letter") deadLetters++;
	}
	if (responseMissing > 0 || ackMissing > 0 || deadLetters > 0) return "idle_blocked";

	// 3) completed_unverified: artifact mtime in last 5 min AND activeTaskIds.length > 0 AND verifiedResultMsgId === null
	const artifactMs = ctx.artifactMtimeMs;
	const activeTaskCount = agent.activeTaskIds?.length ?? 0;
	const lastToolMs = agent.lastToolAt ? new Date(agent.lastToolAt).getTime() : 0;
	const verifiedResultMsgId = messages.some((m) => m.requiresResponse && m.response?.status === "verified");
	if (typeof artifactMs === "number" && nowMs - artifactMs <= ARTIFACT_FRESH_MS && activeTaskCount > 0 && !verifiedResultMsgId) {
		return "completed_unverified";
	}

	// 4) stalled: activeTaskIds.length > 0 AND lastToolAt > 10 min ago AND verifiedResultMsgId === null
	if (activeTaskCount > 0 && lastToolMs && nowMs - lastToolMs > STALLED_LAST_TOOL_MS && !verifiedResultMsgId) {
		return "stalled";
	}

	// 5) active: lastToolAt < 60s ago OR (artifact mtime < 5 min AND activeTaskIds.length > 0 AND not yet settled)
	if (lastToolMs && nowMs - lastToolMs <= ACTIVE_LAST_TOOL_MS) return "active";
	if (typeof artifactMs === "number" && nowMs - artifactMs <= ARTIFACT_FRESH_MS && activeTaskCount > 0) return "active";

	// 6) awaiting_input: otherwise
	return "awaiting_input";
}
