// === swarm/identity.ts — auto-extracted from index.ts (verbatim bodies) ===
import { mkdir, readFile, writeFile, appendFile, rm, stat, rename, readdir, realpath } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname, relative, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { Paths, SwarmAgent, SwarmState } from "./types/index.ts";
import {
	ERR_ROOT_AUTHORITY_REQUIRED,
	ERR_ROOT_LEADER_DENIED,
	ROOT_LEADER_STALE_MS,
} from "./constants.ts";
import { currentAgentId, currentModel, currentProvider } from "./session.ts";
import { readCharterText, resolveRolePlaybook } from "./config.ts";
import { identityPath, mailboxPath, paths, trace } from "./state.ts";
import { now, safeId } from "./utils.ts";
import { tmux } from "./tmux.ts";
import { getProcessCodeStamp, getBootIdentity } from "./stamp.ts";
// Runtime-contract citation (retired-surface cleanup, 2026-10): buildIdentityMarkdown/
// identityPrompt are L4 LLM-consumption prose (docs/swarm/pi-runtime-contract.md §1). The
// minimal-content rewrite changes consumed text only — ZERO new Pi boundary crossings (no
// pi.sendMessage/ctx.abort/ctx.reload/registerTool call sites) — so no new R10-1 counter or §10 row.

// Durable ext-code stamp for the leader lease (see types/state.ts RootLeader.extCodeStamp).
// Fresh stampedAt on every write — the heartbeat/surface comparison uses it for the boot-age.
function stampWithStampedAt(stamp: ReturnType<typeof getProcessCodeStamp>): {
	hash: string;
	files: number;
	stampedAt: string;
} {
	return { hash: stamp.hash, files: stamp.files, stampedAt: new Date().toISOString() };
}
export { isRootHostPane } from "./terminal/index.ts";

// Centralized authority check used by every server-side mutation that depends on identity. Phase 1
// deliberately keeps this strict (root-only); expanded admin roles live in a later roadmap
// issue. Any tool that allows `force`/cancellation must consult this helper instead of trusting
// caller-supplied parameters.
export function isRootAuthority(agentId: string = currentAgentId()): boolean {
	return agentId === "root";
}

export type RootLeaderState =
	| {
			kind: "claimed";
			leader: { pid: number; sessionStartedAt: string; claimedAt: string; lastHeartbeatAt: string; agentRecordId?: string };
			ageMs: number;
	  }
	| {
			kind: "stale";
			leader: { pid: number; sessionStartedAt: string; claimedAt: string; lastHeartbeatAt: string; agentRecordId?: string };
			ageMs: number;
	  }
	| { kind: "vacant" };

export function readRootLeader(st: SwarmState, nowMs: number): RootLeaderState {
	const l = st.rootLeader;
	if (!l) return { kind: "vacant" };
	const ageMs = nowMs - new Date(l.lastHeartbeatAt).getTime();
	if (ageMs > ROOT_LEADER_STALE_MS) return { kind: "stale", leader: l, ageMs };
	// R11-4: pid-liveness probe. A leader whose process is gone is dead regardless of heartbeat
	// age — an orphaned leader (pid survives pane close, pump kept the lease fresh) or a
	// freshly-killed one must not lock out a new claim. Only heartbeat staleness OR a dead pid
	// makes the lease replaceable; a live pid with a fresh heartbeat still denies.
	if (!isPidAlive(l.pid)) return { kind: "stale", leader: l, ageMs };
	return { kind: "claimed", leader: l, ageMs };
}

// Liveness probe via signal 0 (no-op signal; throws ESRCH when the pid is gone). PID reuse
// cannot fully be ruled out without a process-identity check, but the window is tiny and the
// failure mode is benign (a reused pid reports alive → old behavior: wait for heartbeat TTL).
function isPidAlive(pid: number): boolean {
	if (!pid || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err: any) {
		return err?.code === "EPERM";
	}
}

// Boot-scope gate (redteam F3, 2026-10-04). True ONLY for a concrete cross-boot mismatch:
// legacy leases (absent bootId) and any "unknown" resolution (either side) fold into the
// historical pid-only scope (D4 legacy-trusted migration — a force re-claim would deny the
// LIVE root's own heartbeat for >=1 stale TTL on every running swarm post-upgrade).
export function leaseScopeMismatch(lease: { bootId?: string } | undefined | null, meBootId: string): boolean {
	if (!lease?.bootId) return false; // legacy lease → legacy-trusted
	if (lease.bootId === "unknown") return false; // unresolvable at write time → pid-only scope
	if (meBootId === "unknown") return false; // we cannot compare → pid-only scope
	return lease.bootId !== meBootId; // concrete mismatch = foreign boot
}

export function claimRootLeader(st: SwarmState, nowMs: number, me: number) {
	const cur = readRootLeader(st, nowMs);
	const meBootId = getBootIdentity().id;
	if (cur.kind === "claimed" && (cur.leader.pid !== me || leaseScopeMismatch(cur.leader, meBootId)))
		return { kind: "denied" as const, currentLeader: cur.leader, ageMs: cur.ageMs };
	const ts = new Date(nowMs).toISOString();
	st.rootLeader = {
		pid: me,
		sessionStartedAt: process.env.PI_SWARM_SESSION_STARTED_AT || ts,
		claimedAt: ts,
		lastHeartbeatAt: ts,
		agentRecordId: "root",
		// Stale-root detection (2026-10-03): record WHICH code generation this leader
		// loaded at claim time; /swarm status compares it against the on-disk generation.
		extCodeStamp: stampWithStampedAt(getProcessCodeStamp()),
		// Boot-identity binding (redteam F3): every lease write re-binds the boot scope.
		bootId: meBootId,
	};
	return { kind: "claimed" as const, leader: st.rootLeader };
}

export function heartbeatRootLeader(st: SwarmState, nowMs: number, me: number, _source: string) {
	const cur = readRootLeader(st, nowMs);
	if (cur.kind === "claimed") {
		const meBootId = getBootIdentity().id;
		if (cur.leader.pid !== me) {
			throw new Error(
				`${ERR_ROOT_LEADER_DENIED}: live root leader pid=${cur.leader.pid} (heartbeat ${cur.ageMs}ms ago). Refusing to mutate from pid=${me}.`,
			);
		}
		// Boot-scope gate (redteam F3): a pid-COLLIDING foreign-boot process must not
		// restamp the lease (it used to overwrite extCodeStamp, masking a stale root).
		// Refuse-and-leave: recovery stays owned by the stale path; deny message names BOTH
		// boot ids — today a foreign restamp is invisible, which is the finding.
		if (leaseScopeMismatch(cur.leader, meBootId)) {
			throw new Error(
				`${ERR_ROOT_LEADER_DENIED}: lease pid=${cur.leader.pid} held by a DIFFERENT BOOT (lease bootId=${cur.leader.bootId ?? "(none)"}, this process bootId=${meBootId}). Foreign process with a colliding pid refused.`,
			);
		}
	}
	const ts = new Date(nowMs).toISOString();
	st.rootLeader = {
		pid: me,
		sessionStartedAt: process.env.PI_SWARM_SESSION_STARTED_AT || (cur.kind === "vacant" ? ts : cur.leader.sessionStartedAt),
		claimedAt: cur.kind === "vacant" ? ts : cur.leader.claimedAt,
		lastHeartbeatAt: ts,
		agentRecordId: "root",
		// Stale-root detection (2026-10-03): this record is rebuilt from scratch on every
		// heartbeat, so restamp HERE or the stamp would be silently dropped on each beat.
		extCodeStamp: stampWithStampedAt(getProcessCodeStamp()),
		// Boot-identity binding (redteam F3): must ride BOTH writers or heartbeats
		// silently drop it (the extCodeStamp lesson, asserted by bootid-lease R3).
		bootId: getBootIdentity().id,
	};
}

export function requireRootAuthority(me: string, action: string): void {
	if (!isRootAuthority(me)) throw new Error(`${ERR_ROOT_AUTHORITY_REQUIRED}: ${action} requires root authority (caller=${me}).`);
}

// The root is a human-driven coordinating session with no dedicated swarm tmux pane.
// Ensure it always has a routable pseudo-agent record + mailbox so swarm_send_message(to=root)
// works from any peer, and so delivery to it is treated as mailbox-only rather than a tmux failure.
export function ensureRoot(st: SwarmState, cwd: string, p: Paths): SwarmAgent {
	const ts = now();
	const existing = st.agents["root"];
	if (existing) {
		// Self-heal the mailbox-only contract on every refresh. The root is a pseudo-agent with
		// NO dedicated swarm pane, so delivery must always be mailbox-only. An older code version (or a
		// manually-edited state) could have left the root attached to a real tmux pane target,
		// which makes peer messages get tmux-injected into that pane instead of delivered to the mailbox.
		// Re-normalize the structural fields so any such "misled" record is corrected on the next
		// session_start/ensure. A custom role/role-text is preserved.
		existing.roleKind = "root";
		existing.tmuxTarget = "unknown";
		existing.tmuxSession = st.tmuxSession;
		existing.tmuxWindow = "root";
		existing.mailbox = relative(cwd, mailboxPath(p, "root"));
		existing.maxConcurrentTasks = 99;
		existing.lastHeartbeatAt = ts;
		existing.lastSessionStartAt = ts;
		existing.updatedAt = ts;
		existing.status = "running";
		if (existing.health === "unhealthy") existing.health = "healthy";
		return existing;
	}
	const agent: SwarmAgent = {
		id: "root",
		role: "Swarm root (human-driven coordinating session). Receives messages via mailbox; no dedicated swarm tmux pane, so delivery is mailbox-only.",
		roleKind: "root",
		capabilities: [],
		activeTaskIds: [],
		maxConcurrentTasks: 99,
		status: "running",
		runtimeStatus: "idle",
		health: "healthy",
		lastHeartbeatAt: ts,
		lastSessionStartAt: ts,
		tmuxSession: st.tmuxSession,
		tmuxWindow: "root",
		tmuxTarget: "unknown",
		model: currentModel(),
		provider: currentProvider(),
		cwd,
		mailbox: relative(cwd, mailboxPath(p, "root")),
		createdAt: ts,
		updatedAt: ts,
	};
	st.agents["root"] = agent;
	st.delivered["root"] ||= [];
	return agent;
}

// Role Playbook section (task-role-playbooks). Renders the agent's always-loaded
// role playbook (a pi skill injected at spawn via --skill) plus the charter it
// operates under. Config reads are synchronous (readSwarmYml); any failure falls
// back to bundled defaults and logs durably — identity generation never throws.
function buildRolePlaybookSection(agent: SwarmAgent): string {
	const playbook = resolveRolePlaybook(agent.roleKind, { role: agent.role });
	if (!playbook) return "";
	const charterText = readCharterText(agent.cwd);
	return (
		`## Role Playbook\n\n` +
		`Your role playbook (pi skill, always loaded): \`${playbook}\`\n\n` +
		`**Charter:** ${charterText.trim()}\n\n`
	);
}

export function buildIdentityMarkdown(state: SwarmState, agent: SwarmAgent) {
	// Minimal role/workflow identity: agent id + role, role playbook + charter,
	// assignment/scope + reporting workflow, and (for qualification roles) the
	// qualification-skill pointer. Workflow guidance only — no tool catalog or exact
	// call signatures (tool discovery/sequences live in tool descriptions and the
	// assignment body), no runtime metadata (swarm id, model/provider, cwd, tmux target,
	// mailbox path).
	return (
		`# Swarm Agent Identity: ${agent.id}\n\n` +
		`> This file is generated by the pi swarm extension. It is the durable role/identity card for this agent.\n\n` +
		`## Identity\n\n` +
		`- Agent ID: \`${agent.id}\`\n` +
		`- Role: ${agent.role}\n\n` +
		`## Operating Protocol\n\n` +
		`1. Treat this identity file as your role-specific AGENT.md.\n` +
		`2. Coordinate with peers through your swarm messaging tool; never ask the human to relay swarm traffic.\n` +
		`3. Poll your mailbox when idle or after receiving swarm traffic — idle means no active tool calls or immediate task steps; if you are waiting more than ~10 seconds, poll pending mailbox messages.\n` +
		`4. Verify a peer exists before messaging them for the first time.\n` +
		`5. Stay within your role and your task's declared scope unless the root explicitly changes your assignment.\n` +
		(["root", "reviewer", "auditor"].includes(agent.roleKind)
			? `6. Qualification responsibility: read the package skill \`extensions/swarm/qualification-skills/qualification-gate/SKILL.md\` when preparing, challenging, or auditing a task's qualification gate. Keep it private to qualification roles; implementers follow the frozen artifact instead.\n\n`
			: "\n") +
		buildRolePlaybookSection(agent) +
		`## Reply & Completion Workflow\n\n` +
		`- Replies are auto-verified: the engine derives message lifecycle from your reply and your task update — there is no manual acknowledgement step.\n` +
		`- When assigned work: the assignment's scope and acceptance criteria guide the work; task progress and outcomes remain visible to the coordinator.\n` +
		`- Late replies to a superseded/cancelled assignment are fenced (rejected, original record untouched); if scope or ownership is unclear, coordinate with the coordinator.\n\n` +
		`## Lifecycle\n\n` +
		`- Start by reading this identity when role details are unclear.\n` +
		`- If an initial task is present, begin it after reading identity; do not wait indefinitely for another instruction.\n` +
		`- If no task is present, remain available until the root stops or reassigns you.\n` +
		`- Report completion, blockers, and role conflicts to the coordinating agent named in your task or to the root.\n\n` +
		`## Review Expectations\n\n` +
		`- Be explicit about findings, risks, assumptions, and evidence paths.\n` +
		`- Prefer small, verifiable messages over large unstructured dumps.\n` +
		`- If a requested action conflicts with this identity, explain the conflict and ask for reassignment.\n`
	);
}

export function identityPrompt(cwd: string, identityRelPath: string) {
	return `\n\n[PI-SWARM IDENTITY]\nYour durable swarm identity is stored at ${identityRelPath}. Read it before acting when you need role details. Treat it as your agent-specific AGENT.md.\nReply to swarm messages via your swarm messaging tool; the engine derives lifecycle from your reply and your task update.\n[/PI-SWARM IDENTITY]\n`;
}

// Override file path: `.pi/swarm/agents/<id>.override.md`. This file is USER-EDITABLE and is ONLY EVER
// READ by generation — it is never written or deleted by the extension, so edits survive regeneration.
export function overridePath(p: Paths, agentId: string) {
	return join(p.agentsDir, `${safeId(agentId)}.override.md`);
}

export function identityHashOf(text: string) {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

// Rebuild + persist the EFFECTIVE identity for an agent: generated base (buildIdentityMarkdown) +
// optional override-append + an Identity provenance footer. The
// effective markdown is written to `<id>.md`; the override file (`<id>.override.md`) is read-only.
//
// MUST be called under the swarm lock: it mutates `agent.identityVersion/identityHash/identityLoadedAt`
// and the caller writes state afterward. version bumps when the effective CONTENT (base + override
// body, excluding the provenance footer) changes since the last stamp, or on first creation — so a
// no-op rewrite is idempotent, while an override add/remove/role-change bumps the version.
export async function writeEffectiveIdentity(cwd: string, p: Paths, state: SwarmState, agent: SwarmAgent, opts?: { reason?: string }) {
	const base = buildIdentityMarkdown(state, agent);
	let overrideText = "";
	let overridePresent = false;
	const ovPath = overridePath(p, agent.id);
	if (existsSync(ovPath)) {
		const raw = (await readFile(ovPath, "utf8")).trim();
		if (raw) {
			overridePresent = true;
			overrideText = raw;
		}
	}
	// Effective content (base + override). The provenance footer is computed from this hash but is NOT
	// part of the hashed content, keeping version-bump detection stable across provenance-only rewrites.
	const content = overridePresent
		? `${base}\n<!-- PI-SWARM IDENTITY OVERRIDE START -->\n## Custom instructions (from override)\n\n${overrideText}\n\n<!-- PI-SWARM IDENTITY OVERRIDE END -->\n`
		: base;
	const contentHash = identityHashOf(content);
	const ts = now();
	const changed = !agent.identityHash || agent.identityHash !== contentHash;
	const version = changed ? (agent.identityVersion ?? 0) + 1 : (agent.identityVersion ?? 0);
	const shortHash = contentHash.slice(0, 12);
	const markdown =
		`${content}\n## Identity provenance\n\n` +
		`- Version: \`${version}\`\n` +
		`- Hash: \`${shortHash}\` (sha256 of base + override)\n` +
		`- Loaded at: \`${ts}\`\n` +
		`- Override present: \`${overridePresent}\`${overridePresent ? ` (\`${relative(cwd, ovPath)}\`)` : ""}\n`;
	// Stamp the agent record so callers (which already write state) persist provenance.
	agent.identityVersion = version;
	agent.identityHash = contentHash;
	agent.identityLoadedAt = ts;
	agent.updatedAt = ts;
	await writeFile(identityPath(p, agent.id), markdown, "utf8");
	await trace(p, "agent.identity.write", {
		agentId: agent.id,
		version,
		hash: shortHash,
		overridePresent,
		reason: opts?.reason || "effective",
		file: relative(cwd, identityPath(p, agent.id)),
	});
	return { markdown, version, hash: contentHash, shortHash, overridePresent, changed, loadedAt: ts };
}
