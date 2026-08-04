// === swarm/utils.ts — auto-extracted from index.ts (verbatim bodies) ===
import { defineTool, CONFIG_DIR_NAME, truncateHead, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createHash, randomUUID } from "node:crypto";
import type { SwarmAgent, TaskNode } from "./types.ts";
import { trace } from "./state.ts";

export function now() {
	return new Date().toISOString();
}

export function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export function safeId(input: string) {
	const out = input.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
	return out || `agent-${randomUUID().slice(0, 8)}`;
}

export function projectSlug(cwd: string) {
	return safeId(cwd.split("/").filter(Boolean).pop() || "project").slice(0, 30);
}

export function inferRoleKind(id: string, role: string) {
	const lid = id.toLowerCase();
	const text = `${id} ${role}`.toLowerCase();
	// Strong id-based signals win first: an agent named `implementer-02` is an implementer even if its
	// role text incidentally mentions "reviewer" (e.g. "coordinate with tester/reviewer"). Then fall
	// back to the combined id+role text so node-role matching (inferRoleKind(nodeId, nodeRole)) and
	// ids without a role keyword still classify via the role text.
	const idHas = (kw: string) => lid.includes(kw);
	if (idHas("orchestrator")) return "orchestrator";
	if (idHas("planner")) return "planner";
	if (idHas("reviewer")) return "reviewer";
	if (idHas("tester") || idHas("qa")) return "tester";
	if (idHas("observer")) return "observer";
	if (idHas("implementer") || idHas("coder") || idHas("developer")) return "implementer";
	if (text.includes("orchestrator")) return "orchestrator";
	if (text.includes("planner") || text.includes("plan")) return "planner";
	if (text.includes("reviewer") || text.includes("review")) return "reviewer";
	if (text.includes("tester") || text.includes("test") || text.includes("qa")) return "tester";
	if (text.includes("observer")) return "observer";
	if (text.includes("implementer") || text.includes("coder") || text.includes("developer") || text.includes("fix")) return "implementer";
	return "worker";
}

export function ensureAgentDefaults(agent: SwarmAgent): SwarmAgent {
	// roleKind is re-derived from id+role unless explicitly pinned at spawn (roleKindExplicit). This
	// lets classification self-heal when inference improves, while preserving deliberate overrides.
	if (!agent.roleKindExplicit) agent.roleKind = inferRoleKind(agent.id, agent.role);
	agent.capabilities ||= [];
	agent.activeTaskIds ||= [];
	agent.maxConcurrentTasks ||= agent.roleKind === "orchestrator" ? 99 : 1;
	return agent;
}

export function normalizeTaskNode(node: TaskNode): TaskNode {
	return {
		...node,
		dependsOn: node.dependsOn || [],
		readArtifacts: node.readArtifacts || [],
		writeArtifacts: node.writeArtifacts || [],
		messageIds: node.messageIds || [],
		attempts: node.attempts || 0,
	};
}

export function isSafeRelativePath(value: string) {
	return Boolean(value) && !value.startsWith("/") && !value.includes("..");
}

// Returns the CURRENT orchestrator process's surfaced-id ledger (keyed by process.pid), creating it if
// needed. Returns null when the caller is not an orchestrator session — non-orchestrator callers then
// fall back to the shared `st.delivered[agentId]` ledger.
//
// WHY process.pid (NOT PI_SESSION_ID): each orchestrator-context pi PROCESS has its own pump instance
// and its own TUI to surface into, and process.pid is guaranteed distinct per process. PI_SESSION_ID is
// NOT a safe key: a child `pi -p` validation run spawned from an agent's bash INHERITS the parent's
// PI_SESSION_ID (pi's bash tool strips then re-exposes the current session id), so two distinct
// processes can share one session id — keying on it would let a validation run starve the PM. The
// per-pid ledger is what makes the orchestrator auto-pump session-safe AND read-safe: every
// orchestrator process surfaces each notification once, regardless of what any other orchestrator
// process, swarm_check_mailbox, or swarm_ack_message writes to st.delivered.orchestrator (which the
// pump never reads). PI_SESSION_ID is still recorded as `sid` in the pump trace for attribution.
export function capMap<T>(map: Record<string, T>, cap: number): Record<string, T> {
	const keys = Object.keys(map);
	if (keys.length <= cap) return map;
	const keep = new Set(keys.slice(keys.length - cap));
	const out: Record<string, T> = {};
	for (const k of keys) if (keep.has(k)) out[k] = map[k];
	return out;
}

export function truncate(text: string) {
	const t = truncateHead(text, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
	if (!t.truncated) return text;
	return `${t.content}\n\n[truncated: ${t.outputLines}/${t.totalLines} lines (${formatSize(t.outputBytes)}/${formatSize(t.totalBytes)})]`;
}

export function textResult(text: string, details: Record<string, unknown> = {}) {
	return { content: [{ type: "text" as const, text }], details };
}

export function shellQuote(value: string) {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

// Human-readable age from an ISO timestamp (e.g. "3d", "5h", "2m", "45s", "now", "?").
export function humanAge(iso?: string | null): string {
	if (!iso) return "?";
	const ms = Date.now() - new Date(iso).getTime();
	if (!Number.isFinite(ms)) return "?";
	if (ms < 0) return "now";
	const s = Math.floor(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}h`;
	return `${Math.floor(h / 24)}d`;
}
