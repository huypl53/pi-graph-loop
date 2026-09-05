// === swarm/session.ts — auto-extracted from index.ts (verbatim bodies) ===
import { defineTool, CONFIG_DIR_NAME, truncateHead, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ModelSlot, RotationConfig, RotationStrategy, SwarmSettings } from "./types.ts";
import { DEFAULT_MODEL, DEFAULT_PROVIDER, SWARM_GUEST_ID } from "./constants.ts";
import { ensureRoot } from "./identity.ts";
import { readSwarmRawConfig } from "./config.ts";
import { parseQuotaResetMs } from "./pool.ts";

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

export function readSwarmSettings(cwd = process.cwd()): SwarmSettings {
	const { cfg } = readSwarmRawConfig(cwd);
	if (!cfg || typeof cfg !== "object") return {};
	return {
		defaultModel: typeof cfg.defaultModel === "string" && cfg.defaultModel.trim() ? cfg.defaultModel.trim() : undefined,
		defaultProvider: typeof cfg.defaultProvider === "string" && cfg.defaultProvider.trim() ? cfg.defaultProvider.trim() : undefined,
		modelPool: parseModelPool(cfg.modelPool),
		rotation: parseRotationConfig(cfg.rotation),
	};
}
function parseModelPool(raw: unknown): ModelSlot[] | undefined {
	if (!Array.isArray(raw) || !raw.length) return undefined;
	const slots: ModelSlot[] = [];
	for (const s of raw) {
		if (!s || typeof s !== "object") continue;
		const model = typeof (s as any).model === "string" ? (s as any).model.trim() : "";
		if (!model) continue;
		const weight = typeof (s as any).weight === "number" && Number.isFinite((s as any).weight) ? Math.max(0, (s as any).weight) : 1;
		// Quota-reset duration format (2026-09-05): quotaResetMs may be a duration string
		// ("30m", "2h", "1h30m") or a bare number (ms). Parse to ms here so every downstream
		// consumer (pickSlot quotas, poolStatus display, effectiveBenchMs) sees a number.
		// Malformed values are dropped (undefined) — validateSwarmSettings reports them.
		const qrmRaw = (s as any).quotaResetMs;
		const qrm = qrmRaw === undefined ? undefined : parseQuotaResetMs(qrmRaw);
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
			quotaResetMs: qrm,
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
