// === swarm/tools/gating.ts — identity-gated swarm tool visibility ===
//
// A swarm session that neither sets PI_SWARM_AGENT_ID nor opts in as the orchestrator resolves to the
// anonymous SWARM_GUEST_ID. Such a guest is inert for swarm COORDINATION (no agent record, no PM pump,
// no orchestrator heartbeat refresh — see hooks.ts session_start). It should also NOT expose the swarm
// tool surface to the model: a plain `pi` session that merely loaded the extension has no business
// spawning agents, driving the task graph, or reading swarm state. The /swarm slash command stays
// available so an operator can still opt a guest in via `/swarm register here <role>`.
//
// Gating is implemented with pi.setActiveTools, NOT conditional registration: every tool still registers
// unconditionally (so registration counts, getAllTools(), and the smoke test stay stable), and the
// active set is toggled by identity at runtime. Removing a tool from the active set also drops its
// promptGuidelines bullets from the system prompt (see pi extensions.md). Idempotent and safe to re-run
// on an in-session identity change (e.g. after `/swarm register here`).
//
// === Issue 25 Phase 2: tier-based profile gating (proposal §E + §K.3) ===
// Under PI_SWARM_MINIMAL_PROTOCOL=1 the active set is additionally constrained by a per-tier
// allow-list (WORKER_TOOL_ALLOWLIST / ORCHESTRATOR_TOOL_ALLOWLIST). Tools remain registered (UX §N5);
// only the active set is filtered. Execution-time authority checks (requireOrchestratorAuthority)
// remain authoritative — tier-gating is the FIRST gate, authority is the SECOND. Admin mode
// (PI_SWARM_ADMIN_MODE=1) sees all registered tools (recovery workflows).
// Under gate=0 the Phase-1 guest-vs-registered behavior is preserved byte-identically (regression safe).
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ORCHESTRATOR_TOOL_ALLOWLIST, PI_SWARM_MINIMAL_PROTOCOL, SWARM_GUEST_ID, WORKER_TOOL_ALLOWLIST } from "../constants.ts";
import { currentAgentId } from "../session.ts";

export const SWARM_TOOL_PREFIX = "swarm_";

// All registered tool names that belong to this extension (self-maintaining as tools are added/renamed).
export function swarmToolNames(pi: ExtensionAPI): string[] {
	try {
		const all = (pi as any).getAllTools?.() ?? [];
		return (Array.isArray(all) ? all : []).map((t: any) => t?.name).filter((n: any): n is string => typeof n === "string" && n.startsWith(SWARM_TOOL_PREFIX));
	} catch {
		return [];
	}
}

function sameSet(a: Set<string>, b: Set<string>): boolean {
	if (a.size !== b.size) return false;
	for (const x of a) if (!b.has(x)) return false;
	return true;
}

function readRoleKindForAgent(me: string): string | undefined {
	// Best-effort, lock-free read of the caller agent's roleKind. Absent record (e.g. guest / freshly-
	// spawned-but-not-yet-persisted) -> undefined. We read the swarm-state.json without acquiring
	// withLock because the active-tool-set update is best-effort and out-of-band with durable state
	// (tier gating is advisory; authority is the second gate). Missing file / corrupt file -> undefined.
	try {
		const file = join(process.cwd(), ".pi/swarm/swarm-state.json");
		if (!existsSync(file)) return undefined;
		const st = JSON.parse(readFileSync(file, "utf8"));
		return st?.agents?.[me]?.roleKind;
	} catch {
		return undefined;
	}
}

// Apply identity-based gating. Guests lose swarm tools from the active set; registered agents and the
// orchestrator have them ensured present (so an in-session opt-in via `/swarm register here` re-enables
// them immediately). Under gate=1 the tier allow-list is consulted additionally: workers see only the
// 5-tool worker surface (with swarm_reconcile constrained at execution time to dryRun:true + scope:"self");
// orchestrators see the worker 5 + 5 orchestration + 2 goal tools. Never adds or removes non-swarm tools.
// No-op when the set is already correct (avoids a needless system-prompt rebuild on every session_start
// for non-guests). Defensive against partial/mocked pi objects (e.g. test harnesses without active-tool methods).
export function applySwarmToolGating(pi: ExtensionAPI): void {
	const getActive = (pi as any).getActiveTools;
	const setActive = (pi as any).setActiveTools;
	if (typeof getActive !== "function" || typeof setActive !== "function") return;
	let active: string[];
	try { active = Array.from((getActive.call(pi) as string[]) || []); }
	catch { return; }
	const swarm = new Set(swarmToolNames(pi));
	const next = new Set(active);
	if (PI_SWARM_MINIMAL_PROTOCOL === 0) {
		// Phase 1 path (unchanged): guest drops swarm tools; everyone else keeps them.
		if (currentAgentId() === SWARM_GUEST_ID) {
			for (const n of swarm) next.delete(n);
		} else {
			for (const n of swarm) next.add(n);
		}
	} else {
		// Phase 2 path: tier-based allow-list.
		const me = currentAgentId();
		const isAdmin = process.env.PI_SWARM_ADMIN_MODE === "1" || me === "admin";
		const isOrch = me === "orchestrator";
		if (currentAgentId() === SWARM_GUEST_ID) {
			// Guest loses swarm tools entirely (same as gate=0).
			for (const n of swarm) next.delete(n);
		} else if (isAdmin) {
			// Admin sees all registered swarm tools.
			for (const n of swarm) next.add(n);
		} else {
			// Tier filter: orchestrator vs worker (read roleKind for forward-compat w/ new roles).
			const roleKind = isOrch ? "orchestrator" : (readRoleKindForAgent(me) || "worker");
			const allow = roleKind === "orchestrator" ? ORCHESTRATOR_TOOL_ALLOWLIST : WORKER_TOOL_ALLOWLIST;
			for (const n of swarm) {
				if (allow.has(n)) next.add(n); else next.delete(n);
			}
		}
	}
	if (sameSet(new Set(active), next)) return; // nothing to do
	try { setActive.call(pi, [...next]); }
	catch { /* gating is advisory; never fail a session/command on it */ }
}
