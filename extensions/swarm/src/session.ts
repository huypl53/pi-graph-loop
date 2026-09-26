// === swarm/session.ts — auto-extracted from index.ts (verbatim bodies) ===
import { DEFAULT_MODEL, DEFAULT_PROVIDER, SWARM_GUEST_ID } from "./constants.ts";
import { readSwarmSettings } from "./config.ts";

export { readSwarmSettings } from "./config.ts";

// Explicit opt-in for the root/PM identity. Truthy PI_SWARM_IS_ROOT (1/true/yes)
// asserts "this session IS the human-driven root". A bare `pi` session opened in the project
// must NOT implicitly become the root: that would let it run the root mailbox pump
// (surfacing PM traffic to an unintended TUI), call ensureRoot (refreshing the root
// pseudo-agent heartbeat and masking a dead/stalled PM), and default mailbox reads/sends to the
// root. The PM opts in explicitly; an anonymous session resolves to SWARM_GUEST_ID (inert).
export function isRootSession() {
	const v = process.env.PI_SWARM_IS_ROOT;
	return Boolean(v) && !/^(0|false|no|)$/i.test(v.trim());
}

export function currentAgentId() {
	// Explicit agent id always wins (spawned agents set PI_SWARM_AGENT_ID=<id>). Setting it to
	// "root" is an affirmative root claim, not a silent default.
	if (process.env.PI_SWARM_AGENT_ID) return process.env.PI_SWARM_AGENT_ID;
	// Explicit root opt-in (the human PM sets PI_SWARM_IS_ROOT=1).
	if (isRootSession()) return "root";
	// No identity and no explicit root claim: anonymous/inert swarm session.
	return SWARM_GUEST_ID;
}

export function currentModel() {
	const settings = readSwarmSettings();
	return settings.defaultModel || process.env.PI_SWARM_DEFAULT_MODEL || DEFAULT_MODEL;
}

export function providerForModel(model: string): string | undefined {
	// Issue E: never force the zai hardcode onto an unknown model. Known presets win, then an explicit
	// settings/env default; otherwise undefined — the caller decides (spawn falls back to
	// DEFAULT_PROVIDER only at the final spawn-command boundary with a trace warning).
	const settings = readSwarmSettings();
	return settings.defaultProvider || process.env.PI_SWARM_DEFAULT_PROVIDER || undefined;
}

export function currentProvider(model = currentModel()) {
	const settings = readSwarmSettings();
	return settings.defaultProvider || process.env.PI_SWARM_DEFAULT_PROVIDER || providerForModel(model) || DEFAULT_PROVIDER;
}

export function childPiArgs() {
	// Default loads the swarm extension so spawned agents have swarm tools (swarm_send_message,
	// swarm_update_task, etc.). The path is repo-canonical ("extensions/swarm/index.ts") so it
	// resolves regardless of cwd — the root pi must be running from the repo root for the
	// extension to load (same precondition as parent-load). Tests or unusual projects override
	// via PI_SWARM_CHILD_ARGS, e.g. PI_SWARM_CHILD_ARGS="--approve --no-extensions".
	return process.env.PI_SWARM_CHILD_ARGS || "--approve -e extensions/swarm/index.ts";
}
