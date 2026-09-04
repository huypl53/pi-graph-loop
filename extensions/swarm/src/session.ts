// === swarm/session.ts — auto-extracted from index.ts (verbatim bodies) ===
import { defineTool, CONFIG_DIR_NAME, truncateHead, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname, relative, sep } from "node:path";
import type { ModelSlot, RotationConfig, RotationStrategy, SwarmSettings } from "./types.ts";
import { DEFAULT_MODEL, DEFAULT_PROVIDER, EXT, SWARM_GUEST_ID } from "./constants.ts";
import { ensureOrchestrator } from "./identity.ts";

// Explicit opt-in for the orchestrator/PM identity. Truthy PI_SWARM_IS_ORCHESTRATOR (1/true/yes)
// asserts "this session IS the human-driven orchestrator". A bare `pi` session opened in the project
// must NOT implicitly become the orchestrator: that would let it run the orchestrator mailbox pump
// (surfacing PM traffic to an unintended TUI), call ensureOrchestrator (refreshing the orchestrator
// pseudo-agent heartbeat and masking a dead/stalled PM), and default mailbox reads/sends to the
// orchestrator. The PM opts in explicitly; an anonymous session resolves to SWARM_GUEST_ID (inert).
export function isOrchestratorSession() {
	const v = process.env.PI_SWARM_IS_ORCHESTRATOR;
	return Boolean(v) && !/^(0|false|no|)$/i.test(v.trim());
}

export function currentAgentId() {
	// Explicit agent id always wins (spawned agents set PI_SWARM_AGENT_ID=<id>). Setting it to
	// "orchestrator" is an affirmative orchestrator claim, not a silent default.
	if (process.env.PI_SWARM_AGENT_ID) return process.env.PI_SWARM_AGENT_ID;
	// Explicit orchestrator opt-in (the human PM sets PI_SWARM_IS_ORCHESTRATOR=1).
	if (isOrchestratorSession()) return "orchestrator";
	// No identity and no explicit orchestrator claim: anonymous/inert swarm session.
	return SWARM_GUEST_ID;
}

export function readSwarmSettings(cwd = process.cwd()): SwarmSettings {
	const file = join(cwd, CONFIG_DIR_NAME, "settings.json");
	if (!existsSync(file)) return {};
	try {
		const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, any>;
		const fromExtensions = raw?.extensions?.[EXT];
		const fromTopLevel = raw?.swarm;
		const cfg = (fromExtensions && typeof fromExtensions === "object" ? fromExtensions : undefined) ||
			(fromTopLevel && typeof fromTopLevel === "object" ? fromTopLevel : undefined);
		if (!cfg || typeof cfg !== "object") return {};
		return {
			defaultModel: typeof cfg.defaultModel === "string" && cfg.defaultModel.trim() ? cfg.defaultModel.trim() : undefined,
			defaultProvider: typeof cfg.defaultProvider === "string" && cfg.defaultProvider.trim() ? cfg.defaultProvider.trim() : undefined,
			modelPool: parseModelPool(cfg.modelPool),
			rotation: parseRotationConfig(cfg.rotation),
		};
	} catch {
		return {};
	}
}

function parseModelPool(raw: unknown): ModelSlot[] | undefined {
	if (!Array.isArray(raw) || !raw.length) return undefined;
	const slots: ModelSlot[] = [];
	for (const s of raw) {
		if (!s || typeof s !== "object") continue;
		const model = typeof (s as any).model === "string" ? (s as any).model.trim() : "";
		if (!model) continue;
		const weight = typeof (s as any).weight === "number" && Number.isFinite((s as any).weight) ? Math.max(0, (s as any).weight) : 1;
		slots.push({
			model,
			provider: typeof (s as any).provider === "string" && (s as any).provider.trim() ? (s as any).provider.trim() : undefined,
			weight,
			label: typeof (s as any).label === "string" ? (s as any).label.trim() || undefined : undefined,
			// Issue 22 roles-filter: forward the optional per-slot roleKind allow-list. Absent / empty
			// preserved verbatim so slotMatchesRole can detect "no filter set". Malformed shapes become
		// undefined (no filter applied); validateSwarmSettings reports slot_bad_roles for visibility.
			roles: Array.isArray((s as any).roles) && (s as any).roles.every((r: any) => typeof r === "string" && r.length > 0)
				? (s as any).roles.map((r: string) => r.trim()).filter(Boolean)
				: undefined,
		});
	}
	return slots.length ? slots : undefined;
}

function parseRotationConfig(raw: unknown): RotationConfig | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const r = raw as Record<string, any>;
	const strategy = ["weighted", "round-robin", "sticky"].includes(r.strategy) ? r.strategy as RotationStrategy : undefined;
	const cooldownMs = typeof r.cooldownMs === "number" && Number.isFinite(r.cooldownMs) && r.cooldownMs >= 0 ? Math.floor(r.cooldownMs) : undefined;
	const maxRetries = typeof r.maxRetries === "number" && Number.isFinite(r.maxRetries) && r.maxRetries >= 1 ? Math.floor(r.maxRetries) : undefined;
	if (!strategy && cooldownMs === undefined && maxRetries === undefined) return undefined;
	return { strategy, cooldownMs, maxRetries };
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
	// Default keeps spawned agents in the same trusted project so they discover project extensions/skills.
	// Tests or unusual projects can override, e.g. PI_SWARM_CHILD_ARGS="--approve --no-extensions -e extensions/swarm/index.ts".
	return process.env.PI_SWARM_CHILD_ARGS || "--approve";
}
