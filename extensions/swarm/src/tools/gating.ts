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
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SWARM_GUEST_ID } from "../constants.ts";
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

// Apply identity-based gating. Guests lose swarm tools from the active set; registered agents and the
// orchestrator have them ensured present (so an in-session opt-in via `/swarm register here` re-enables
// them immediately). Never adds or removes non-swarm tools. No-op when the set is already correct
// (avoids a needless system-prompt rebuild on every session_start for non-guests). Defensive against
// partial/mocked pi objects (e.g. test harnesses without active-tool methods).
export function applySwarmToolGating(pi: ExtensionAPI): void {
	const getActive = (pi as any).getActiveTools;
	const setActive = (pi as any).setActiveTools;
	if (typeof getActive !== "function" || typeof setActive !== "function") return;
	let active: string[];
	try { active = Array.from((getActive.call(pi) as string[]) || []); }
	catch { return; }
	const swarm = new Set(swarmToolNames(pi));
	const next = new Set(active);
	if (currentAgentId() === SWARM_GUEST_ID) {
		for (const n of swarm) next.delete(n);
	} else {
		for (const n of swarm) next.add(n);
	}
	if (sameSet(new Set(active), next)) return; // nothing to do
	try { setActive.call(pi, [...next]); }
	catch { /* gating is advisory; never fail a session/command on it */ }
}
