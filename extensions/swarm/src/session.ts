// === swarm/session.ts — auto-extracted from index.ts (verbatim bodies) ===
import { fileURLToPath } from "node:url";
import { DEFAULT_MODEL, DEFAULT_PROVIDER, SWARM_GUEST_ID } from "./constants.ts";
import { readSwarmSettings } from "./config.ts";
import { shellQuote } from "./utils.ts";

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

export function defaultSwarmExtensionPath(): string {
	return fileURLToPath(new URL("../index.ts", import.meta.url));
}

export function childPiArgs() {
	// Default loads the swarm extension so spawned agents have swarm tools (swarm_send_message,
	// swarm_update_task, etc.). The path is resolved to the absolute location of this extension's
	// entry point so it resolves regardless of the target agent's working directory.
	// Tests or unusual projects override via PI_SWARM_CHILD_ARGS, e.g. PI_SWARM_CHILD_ARGS="--approve --no-extensions".
	if (process.env.PI_SWARM_CHILD_ARGS) return process.env.PI_SWARM_CHILD_ARGS;
	const extPath = defaultSwarmExtensionPath();
	return `--approve -e ${shellQuote(extPath)}`;
}

// === Role playbook injection (task-role-playbooks) ==========================
// Same contract as childPiArgs(), but appends one `--skill <abs-path>` flag per
// resolved playbook AFTER the `-e <ext>` args. `--skill` is additive pi CLI
// surface (docs/skills.md): normal skill discovery still happens, so
// user/project skills are preserved and playbooks are added on top.
//
// Contract:
//   - default (no skills): identical string to childPiArgs() — existing
//     callers and child-pi-args-cwd.test.mjs assertions stay valid verbatim.
//   - PI_SWARM_CHILD_ARGS passthrough STILL WINS VERBATIM even when skills are
//     passed (an explicit operator override composes the whole argv; injecting
//     extra flags after it would defeat the override).
//   - empty/absent skills list: falls back to childPiArgs() (no --skill flags).
export function childPiArgsWithSkills(skills: string[]): string {
	if (process.env.PI_SWARM_CHILD_ARGS) return process.env.PI_SWARM_CHILD_ARGS;
	if (!skills || skills.length === 0) return childPiArgs();
	const args = childPiArgs(); // "--approve -e <ext>"
	const skillFlags = skills.map((p) => `--skill ${shellQuote(p)}`).join(" ");
	return `${args} ${skillFlags}`;
}

