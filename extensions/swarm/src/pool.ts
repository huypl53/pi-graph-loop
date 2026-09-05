// === swarm/pool.ts — model pool: weighted rotation + health cooldown + failover picks ===
import { mkdir, readFile, stat, rm } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import type { ModelSlot, Paths, PoolHealthState, PoolSlotHealth, PreflightError, PreflightResult, ProviderErrorKind, RotationConfig, RotationStrategy, SwarmSettings } from "./types.ts";
import { POOL_COOLDOWN_MS, POOL_MAX_RETRIES } from "./constants.ts";
import { currentModel, currentProvider, readSwarmSettings } from "./session.ts";
import { readSwarmRawConfig, readSwarmYml, swarmYmlPath, type SwarmConfigSource } from "./config.ts";
import { atomicWriteFile, trace } from "./state.ts";

// Credential probe for preflightSpawn (3b): does this provider have a usable API key?
// Mirrors pi's own lookup order: ~/.pi/agent/auth.json entries, then the conventional
// <PROVIDER>_API_KEY / <PROVIDER>_APIKEY env vars. Returns undefined when a key exists.
function missingProviderCredential(provider: string): string | undefined {
	if (!provider) return "no provider";
	try {
		const home = process.env.HOME || "";
		if (home) {
			const auth = JSON.parse(readFileSync(join(home, ".pi", "agent", "auth.json"), "utf8")) as Record<string, any>;
			const entry = auth?.[provider];
			if (entry && typeof entry === "object" && entry.type === "api_key" && String(entry.key || entry.apiKey || "").trim()) return undefined;
		}
	} catch { /* missing/unreadable auth.json falls through to env check */ }
	const envKey = provider.toUpperCase().replace(/[^A-Z0-9]/g, "_");
	if (process.env[`${envKey}_API_KEY`] || process.env[`${envKey}_APIKEY`]) return undefined;
	return `no api key for provider '${provider}'`;
}
import { sleep } from "./utils.ts";

// === Issue 21 quota-reset-interval ===
// PI_SWARM_QUOTA_RESET_MS: fleet-wide env-var override for slot.quotaResetMs. Default 0 (disabled).
// Per-slot value wins when both are set; the env var only kicks in when the per-slot value is
// undefined or 0. Read at module-load time (mirrors constants.ts:ORPHAN_SPAWN_WARNING_TIMEOUT_MS
// + MAX_CONSECUTIVE_NUDGES_DEFAULT pattern). Tests that need to override this MUST delete the env
// var first, set the new value, then dynamic-import this module — the constants module's env read
// happens once at module-load and is captured thereafter.
const QUOTA_RESET_DEFAULT_MS =
	Number(process.env.PI_SWARM_QUOTA_RESET_MS) > 0
		? Math.floor(Number(process.env.PI_SWARM_QUOTA_RESET_MS))
		: 0;

// Quota-reset duration format (user request 2026-09-05): quotaResetMs is normally minutes or
// hours, and raw milliseconds are error-prone (a user writing 18000 meaning 18 minutes actually
// got 18 seconds). Accept a human duration string anywhere quotaResetMs is read:
//   "<n><unit>" segments, units ms | s | m | h | d (case-insensitive, combinable: "1h30m",
//   whitespace-separated: "2h 15m 30s"). Bare numbers (and bare numeric strings, for yml
//   ergonomics) stay milliseconds — back-compat. Returns the parsed non-negative integer ms,
// or undefined when unparseable.
const QUOTA_DURATION_UNIT_MS: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };
export function parseQuotaResetMs(input: unknown): number | undefined {
	if (typeof input === "number") return Number.isFinite(input) && input >= 0 ? Math.floor(input) : undefined;
	if (typeof input !== "string") return undefined;
	const trimmed = input.trim();
	if (!trimmed) return undefined;
	// Bare numeric string: milliseconds (parity with the number form).
	if (/^\d+$/.test(trimmed)) return parseInt(trimmed, 10);
	let total = 0;
	let matched = false;
	let rest = trimmed;
	while (rest) {
		const ws = rest.match(/^\s+/);
		if (ws) { rest = rest.slice(ws[0].length); continue; }
		const m = rest.match(/^(\d+)\s*(ms|s|m|h|d)/i);
		if (!m) return undefined; // unparseable remainder -> reject the whole input
		const unitMs = QUOTA_DURATION_UNIT_MS[m[2].toLowerCase()];
		if (unitMs === undefined) return undefined;
		total += parseInt(m[1], 10) * unitMs;
		matched = true;
		rest = rest.slice(m[0].length);
	}
	return matched && total >= 0 ? total : undefined;
}

// Read quotaResetMs directly from the raw config (settings.json blocks or swarm.yml — resolved by
// readSwarmRawConfig with the same precedence). `readSwarmSettings()` strips unknown fields
// (session.ts:parseModelPool only forwards model/provider/weight/label/roles), hence this raw path.
// The raw read is cached per cwd; chdir invalidates by re-reading the file. Cheap enough to call
// per bench (bench is a cold path, not a hot path).
const quotaResetCache = new Map<string, Map<string, number>>();
function readQuotaResetMsFor(cwd: string, key: string): number {
	let m = quotaResetCache.get(cwd);
	if (!m) {
		m = new Map();
		quotaResetCache.set(cwd, m);
		try {
			const { cfg } = readSwarmRawConfig(cwd);
			if (cfg && Array.isArray(cfg.modelPool)) {
				for (const s of cfg.modelPool) {
					if (!s || typeof s !== "object") continue;
					const qrm = parseQuotaResetMs(s.quotaResetMs);
					if (qrm !== undefined) {
						const provider = typeof s.provider === "string" && s.provider ? s.provider : "(default)";
						const model = typeof s.model === "string" ? s.model : "";
						m.set(`${provider}/${model}`, qrm);
					}
				}
			}
		} catch { /* ignore — empty cache */ }
	}
	return m.get(key) ?? 0;
}

// Pure helper: effective bench duration for a quota bench on the given slot. Returns
// max(rotation.cooldownMs, slot.quotaResetMs ?? QUOTA_RESET_DEFAULT_MS). Note the env default only
// applies when the per-slot value is undefined or 0 — if the slot explicitly sets quotaResetMs=0
// we want the same behavior as before (no env floor either). The 24h exponential backoff cap is
// applied at the caller, NOT here. The auth branch uses a separate, longer floor (6h) that is
// independent of quotaResetMs (auth benches do not self-heal on a known reset window).
export function effectiveBenchMs(slot: Pick<ModelSlot, "model" | "provider">, rotation: Required<RotationConfig>, cwd: string = process.cwd()): number {
	const key = slotKey(slot);
	const slotVal = (slot as ModelSlot).quotaResetMs;
	// Per-slot value wins when > 0; otherwise fall back to env default.
	const floor = (typeof slotVal === "number" && slotVal > 0)
		? slotVal
		: (readQuotaResetMsFor(cwd, key) || QUOTA_RESET_DEFAULT_MS);
	return Math.max(rotation.cooldownMs, floor);
}

// Test-only helper: clear the quotaResetMs per-cwd cache. Exposed so tests that re-seed settings
// between fixtures (without changing cwd) can force a fresh read. NOT used in production code.
export function _clearQuotaResetCacheForTests() {
	quotaResetCache.clear();
}

// Health state lives next to swarm-state.json so every swarm process (root, workers,
// spawned agents) shares one view of which slots are benched.
export function poolHealthFile(p: Paths) {
	return join(p.root, "pool-state.json");
}

// Dedicated lock for pool-state.json. The swarm state lock (withLock) guards swarm-state.json only;
// pool health is read-modify-written concurrently by every agent process (turn_end hook), so it needs
// its own mutex. Same mkdir-based algorithm as withLock (atomic mkdir, stale-break, bounded wait).
function poolLockFile(p: Paths) {
	return join(p.root, "pool-state.lock");
}

export async function withPoolLock<T>(p: Paths, fn: () => Promise<T>): Promise<T> {
	await mkdir(p.root, { recursive: true });
	const lock = poolLockFile(p);
	const started = Date.now();
	while (true) {
		try {
			await mkdir(lock);
			break;
		} catch (err: any) {
			if (err?.code !== "EEXIST") throw err;
			try {
				const s = await stat(lock);
				if (Date.now() - s.mtimeMs > 60_000) await rm(lock, { recursive: true, force: true });
			} catch {}
			if (Date.now() - started > 120_000) throw new Error(`Timed out acquiring pool lock: ${lock}`);
			await sleep(50);
		}
	}
	try {
		return await fn();
	} finally {
		await rm(lock, { recursive: true, force: true });
	}
}

export async function readPoolHealth(p: Paths): Promise<PoolHealthState> {
	const file = poolHealthFile(p);
	if (!existsSync(file)) return { slots: {} };
	try {
		const st = JSON.parse(await readFile(file, "utf8")) as PoolHealthState;
		st.slots ||= {};
		st.rrCursor = typeof st.rrCursor === "number" ? st.rrCursor : 0;
		return st;
	} catch {
		return { slots: {} };
	}
}

export async function writePoolHealth(p: Paths, h: PoolHealthState) {
	await atomicWriteFile(poolHealthFile(p), `${JSON.stringify(h, null, 2)}\n`);
}

export function slotKey(slot: Pick<ModelSlot, "model" | "provider">): string {
	return `${slot.provider || "(default)"}/${slot.model}`;
}

export function effectiveConfig(): { slots: ModelSlot[]; rotation: Required<RotationConfig> } {
	const settings = readSwarmSettings();
	const slots = settings.modelPool && settings.modelPool.length ? settings.modelPool : [];
	const r = settings.rotation || {};
	return {
		slots,
		rotation: {
			strategy: (r.strategy || "weighted") as RotationStrategy,
			cooldownMs: r.cooldownMs ?? POOL_COOLDOWN_MS,
			maxRetries: r.maxRetries ?? POOL_MAX_RETRIES,
		},
	};
}

// Canonical JSON format shown by /swarm pool help and copied verbatim into suggestions + docs.
// Kept in lock-step with the schema in docs/swarm/operations.md (see "Model pool configuration").
// Issue 21: quotaResetMs is optional (omit for slots without a known reset window). When set, the
// effective bench for a quota error becomes max(rotation.cooldownMs, quotaResetMs) — see
// effectiveBenchMs(). Accepts a duration string ("30m", "2h", "1h30m", "1d") or bare ms —
// parseQuotaResetMs().
export const POOL_FORMAT_EXAMPLE = {
	modelPool: [
		{ model: "gpt-5.4-mini", provider: "openai", weight: 50 },
		{ model: "claude-sonnet-4", provider: "anthropic", weight: 30, quotaResetMs: "30d" },
		{ model: "glm-5.1", provider: "zai-coding-cn", weight: 0 },
	],
	rotation: { strategy: "weighted", cooldownMs: 900000, maxRetries: 2 },
} as const;

// A singleton config (only defaultModel + defaultProvider) is treated as an OBSERVABLE implicit
// singleton pool of size 1 — it remains the canonical backward-compatible path for users who do not
// need rotation. This function answers "what does the implicit singleton look like right now?"
// without rewriting the user's settings file. Used by `/swarm pool show`, `/swarm pool help`, and
// preflight (so the singleton path is described in the same vocabulary as an explicit pool).
export function implicitSingletonPool(): { slots: ModelSlot[]; rotation: Required<RotationConfig>; source: "settings" | "env" | "constants" } {
	const settings = readSwarmSettings();
	const model = currentModel();
	const provider = currentProvider(model);
	const source = settings.defaultModel || settings.defaultProvider
		? "settings"
		: (process.env.PI_SWARM_DEFAULT_MODEL || process.env.PI_SWARM_DEFAULT_PROVIDER)
			? "env"
			: "constants";
	return {
		slots: [{ model, provider, weight: 1 }],
		rotation: effectiveConfig().rotation,
		source,
	};
}

// Decide if a settings file represents the explicit-pool shape OR the legacy singleton shape OR
// is empty. Read-only: never rewrites the file. Used by `/swarm pool show|validate|help` and tests.
export type SettingsShape =
	| { kind: "empty" }
	| { kind: "singleton"; defaultModel?: string; defaultProvider?: string; source: SwarmConfigSource }
	| { kind: "explicit-pool"; slots: number; rotation?: RotationConfig; source: SwarmConfigSource }
	| { kind: "both"; slots: number; rotation?: RotationConfig; singleton: { defaultModel?: string; defaultProvider?: string }; source: SwarmConfigSource };

export function classifySwarmSettings(cwd = process.cwd()): SettingsShape {
	const { cfg, source } = readSwarmRawConfig(cwd);
	if (!cfg) return { kind: "empty" };
	const slots = Array.isArray(cfg.modelPool) ? cfg.modelPool.length : 0;
	const rotation = (cfg.rotation && typeof cfg.rotation === "object") ? cfg.rotation as RotationConfig : undefined;
	const hasSingleton = typeof cfg.defaultModel === "string" || typeof cfg.defaultProvider === "string";
	if (slots && hasSingleton) return { kind: "both", slots, rotation, singleton: { defaultModel: cfg.defaultModel, defaultProvider: cfg.defaultProvider }, source: source! };
	if (slots) return { kind: "explicit-pool", slots, rotation, source: source! };
	if (hasSingleton) return { kind: "singleton", defaultModel: cfg.defaultModel, defaultProvider: cfg.defaultProvider, source: source! };
	return { kind: "empty" };
}

// Validation errors caught by `/swarm pool validate` and `preflightSpawn`. Each carries a stable
// `kind` so the formatter can render an actionable suggestion; `field` is purely informational.
export type PoolValidationError = { kind: string; field?: string; message: string };

// Validate a settings shape WITHOUT mutating the file. Returns [] on success; otherwise an array
// of structured errors suitable for `/swarm pool validate` rendering. Read-only. `warnings` are
// advisory (never flip ok): the both_sources_present warning fires when settings.json declares a
// swarm block AND .pi/swarm.yml exists with recognized config — precedence means the JSON wins, so
// the operator should know their yml edits are being masked.
//
// Follow-up 2026-09-05 (user report): `opts.registryProbe` (mirrors ctx.modelRegistry.find)
// enables LIVE resolvability checks per slot: `slot_unresolvable` when the provider/model pair
// is not in the registry, `slot_no_credential` when the provider has no API key (auth.json/env
// probe). Without a probe, validation degrades to structural-only (back-compat).
export function validateSwarmSettings(cwd = process.cwd(), opts: { registryProbe?: { find: (provider: string, modelId: string) => any } } = {}): { ok: boolean; errors: PoolValidationError[]; warnings: PoolValidationError[]; shape: SettingsShape } {
	const errors: PoolValidationError[] = [];
	const warnings: PoolValidationError[] = [];
	let shape: SettingsShape;
	const resolved = readSwarmRawConfig(cwd);
	if (resolved.corrupt.includes("settings.json")) {
		shape = { kind: "empty" };
		errors.push({ kind: "settings_unreadable", message: `Could not parse .pi/settings.json: corrupt JSON` });
		return { ok: false, errors, warnings, shape };
	}
	if (resolved.corrupt.includes("swarm.yml")) {
		shape = { kind: "empty" };
		errors.push({ kind: "swarm_yml_unreadable", message: `Could not parse .pi/swarm.yml: corrupt YAML (comments are fine; check indentation/colons)` });
		return { ok: false, errors, warnings, shape };
	}
	const cfg = resolved.cfg;
	if (!cfg) {
		shape = { kind: "empty" };
		return { ok: true, errors, warnings, shape }; // empty is valid (use defaults)
	}
	const source = resolved.source!;

	// Both-sources warning: settings.json declares a swarm block AND swarm.yml carries config.
	// Follow-up F1: an EMPTY (0-byte / comments-only) swarm.yml is also worth flagging — the user
	// created the file (clear intent to migrate) but it declares nothing, so the JSON config keeps
	// winning silently. swarm_yml_empty steers them to either fill it or delete it.
	if (source !== "swarm.yml" && existsSync(swarmYmlPath(cwd))) {
		let ymlCfg: any = null;
		try { ymlCfg = readSwarmYml(cwd); } catch { /* corrupt already reported above */ }
		if (ymlCfg && (Array.isArray(ymlCfg.modelPool) || ymlCfg.defaultModel || ymlCfg.defaultProvider || ymlCfg.rotation)) {
			warnings.push({ kind: "both_sources_present", field: ".pi/swarm.yml", message: `Both .pi/settings.json (swarm block) and .pi/swarm.yml declare swarm config — settings.json (${source}) wins and the .pi/swarm.yml contents are ignored. Move your config into one file.` });
		} else if (!ymlCfg) {
			warnings.push({ kind: "swarm_yml_empty", field: ".pi/swarm.yml", message: `.pi/swarm.yml exists but declares no config (empty or comments-only) — settings.json (${source}) remains in effect. Fill it in (see /swarm pool help) or remove it to silence this warning.` });
		}
	}
	const slots = Array.isArray(cfg.modelPool) ? cfg.modelPool : null;
	const rotation = (cfg.rotation && typeof cfg.rotation === "object") ? cfg.rotation : null;
	if (slots) {
		const seen = new Set<string>();
		slots.forEach((s: any, idx: number) => {
			if (!s || typeof s !== "object") {
				errors.push({ kind: "slot_not_object", field: `modelPool[${idx}]`, message: `modelPool[${idx}] must be an object` });
				return;
			}
			const model = typeof s.model === "string" ? s.model.trim() : "";
			const provider = typeof s.provider === "string" ? s.provider.trim() : "";
			if (!model) errors.push({ kind: "slot_empty_model", field: `modelPool[${idx}].model`, message: `Slot #${idx + 1} has an empty model name` });
			if (s.weight !== undefined) {
				if (typeof s.weight !== "number" || !Number.isFinite(s.weight) || s.weight < 0) {
					errors.push({ kind: "slot_bad_weight", field: `modelPool[${idx}].weight`, message: `Slot #${idx + 1} weight must be a non-negative number (0 = fallback-only)` });
				}
			}
			const key = `${provider || "(default)"}/${model}`;
			if (seen.has(key) && model) errors.push({ kind: "slot_duplicate", field: `modelPool[${idx}]`, message: `Duplicate slot: ${key}` });
			if (model) seen.add(key);
			// Issue 21: validate the optional quotaResetMs field. Reject non-numeric / negative / NaN
			// values so a typo is caught at validate time rather than silently treated as 0.
			if (s.quotaResetMs !== undefined && parseQuotaResetMs(s.quotaResetMs) === undefined) {
				errors.push({ kind: "slot_bad_quota_reset", field: `modelPool[${idx}].quotaResetMs`, message: `Slot #${idx + 1} quotaResetMs must be a duration ("30m", "2h", "1h30m", "1d") or a non-negative number of milliseconds (floor for quota benches; 24h cap still applies)` });
			}
			// Issue 22: validate the optional roles allow-list (warning-grade, informational — the
			// malformed value is treated as "no filter" by parseModelPool, but the operator should see it).
			if (s.roles !== undefined && (!Array.isArray(s.roles) || !s.roles.every((r: any) => typeof r === "string" && r.length > 0))) {
				errors.push({ kind: "slot_bad_roles", field: `modelPool[${idx}].roles`, message: `Slot #${idx + 1} roles must be a string array of role-kind names (see completion.ts ROLE_KINDS for the closed set: root, planner, reviewer, tester, implementer, worker, observer)` });
			}
			// Follow-up F2 (2026-09-05): live resolvability probe — only when a registry probe is
			// supplied (the /swarm tool path passes ctx.modelRegistry; structural callers don't).
			// A slot that cannot resolve is a launch-time failure for spawns: flag it now.
			if (opts.registryProbe && model && provider) {
				const found = opts.registryProbe.find(provider, model);
				if (!found) {
					errors.push({ kind: "slot_unresolvable", field: `modelPool[${idx}]`, message: `Slot #${idx + 1} ${provider}/${model} is not resolvable: no such model registered under that provider (pi auth / --list-models to inspect). Spawns targeting it would fail.` });
				} else if (missingProviderCredential(provider)) {
					errors.push({ kind: "slot_no_credential", field: `modelPool[${idx}]`, message: `Slot #${idx + 1} provider '${provider}' has no stored API key — a spawned pi would exit with 'No API key found for ${provider}'. Authenticate it (pi auth) or set ${provider.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY.` });
				}
			}
		});
	}
	if (rotation) {
		if (rotation.strategy !== undefined && !["weighted", "round-robin", "sticky"].includes(rotation.strategy)) {
			errors.push({ kind: "rotation_bad_strategy", field: "rotation.strategy", message: `rotation.strategy must be one of weighted | round-robin | sticky (got ${JSON.stringify(rotation.strategy)})` });
		}
		if (rotation.cooldownMs !== undefined && (typeof rotation.cooldownMs !== "number" || !Number.isFinite(rotation.cooldownMs) || rotation.cooldownMs < 0)) {
			errors.push({ kind: "rotation_bad_cooldown", field: "rotation.cooldownMs", message: `rotation.cooldownMs must be a non-negative number of milliseconds` });
		}
		if (rotation.maxRetries !== undefined && (typeof rotation.maxRetries !== "number" || !Number.isFinite(rotation.maxRetries) || rotation.maxRetries < 1)) {
			errors.push({ kind: "rotation_bad_maxretries", field: "rotation.maxRetries", message: `rotation.maxRetries must be a positive integer (>= 1)` });
		}
	}
	const hasSingleton = typeof cfg.defaultModel === "string" || typeof cfg.defaultProvider === "string";
	const slotsCount = slots ? slots.length : 0;
	if (slotsCount && hasSingleton) {
		shape = { kind: "both", slots: slotsCount, rotation: rotation || undefined, singleton: { defaultModel: cfg.defaultModel, defaultProvider: cfg.defaultProvider }, source };
	} else if (slotsCount) {
		shape = { kind: "explicit-pool", slots: slotsCount, rotation: rotation || undefined, source };
	} else if (hasSingleton) {
		shape = { kind: "singleton", defaultModel: cfg.defaultModel, defaultProvider: cfg.defaultProvider, source };
	} else {
		shape = { kind: "empty" };
	}
	return { ok: errors.length === 0, errors, warnings, shape };
}

function inCooldown(h: PoolSlotHealth | undefined, nowMs: number): boolean {
	if (!h?.cooldownUntil) return false;
	return new Date(h.cooldownUntil).getTime() > nowMs;
}

function weightedPick<T extends { weight: number }>(items: T[]): T {
	const total = items.reduce((s, i) => s + i.weight, 0);
	let roll = Math.random() * total;
	for (const item of items) {
		roll -= item.weight;
		if (roll <= 0) return item;
	}
	return items[items.length - 1];
}

function stickyIndex(key: string, n: number): number {
	const hash = createHash("sha256").update(key).digest();
	return hash.readUInt32BE(0) % n;
}

export type PickResult = {
	slot: ModelSlot;
	index: number;
	fromPool: true;
	reason: string;
};

// Pick a slot from the pool. Tries: eligible weighted slots (weight>0, not in cooldown) ->
// fallback-only slots (weight=0, not in cooldown) -> any slot at all (all benched: best effort).
// `stickyKey` (agent id) pins sticky strategy; `avoidKey` (the slot that just failed) is deprioritized
// for round-robin so a failover restart doesn't land back on the same benched slot.
// Issue 22 roles-filter: true when the slot is eligible for the given roleKind. Absent / empty
// roles matches every role; roleKind === undefined (legacy callers) matches everything too.
export function slotMatchesRole(slot: ModelSlot, roleKind: string | undefined): boolean {
	const roles = slot.roles;
	if (!Array.isArray(roles) || roles.length === 0) return true;
	if (!roleKind) return true; // no role filter applied
	return roles.includes(roleKind);
}

export async function pickSlot(p: Paths, opts: { stickyKey?: string; avoidKey?: string; roleKind?: string; bypassRolesFilter?: boolean } = {}): Promise<PickResult | undefined> {
	const { slots, rotation } = effectiveConfig();
	if (!slots.length) return undefined;
	// Issue 22: filter slots through the role allow-list unless bypassed (manual operator rotate)
	// or no roleKind was threaded (legacy callers — full backward compat).
	const applyRoles = !opts.bypassRolesFilter && opts.roleKind !== undefined;
	let visible = applyRoles ? slots.filter((s) => slotMatchesRole(s, opts.roleKind)) : slots;
	// Strict roles (user mandate 2026-08-31): when ANY slot is tagged for this roleKind, the roleKind
	// is served by ONLY its tagged slots — untagged slots are no longer a silent fallback for it.
	// Untagged slots remain the serving set for roleKinds that have no tags at all. When every
	// tagged slot is benched there is NO candidate (swap keeps the current model; spawn falls back
	// via the traced role_filter_all_filtered_fallback path).
	if (applyRoles && visible.length) {
		const tagged = visible.filter((s) => Array.isArray(s.roles) && s.roles.length > 0);
		if (tagged.length) visible = tagged;
	}
	if (!visible.length) return undefined;
	// Round-robin mutates the shared cursor, so the whole pick runs under the pool lock.
	return withPoolLock(p, async () => {
	const h = await readPoolHealth(p);
	const nowMs = Date.now();

	const eligible = visible
		.map((slot, index) => ({ slot, index }))
		.filter(({ slot }) => (slot.weight ?? 1) > 0 && !inCooldown(h.slots[slotKey(slot)], nowMs));
	const fallbacks = visible
		.map((slot, index) => ({ slot, index }))
		.filter(({ slot }) => (slot.weight ?? 1) === 0 && !inCooldown(h.slots[slotKey(slot)], nowMs));

	if (eligible.length) {
		if (rotation.strategy === "sticky" && opts.stickyKey) {
			const { slot, index } = eligible[stickyIndex(opts.stickyKey, eligible.length)];
			return { slot, index, fromPool: true, reason: `sticky(${opts.stickyKey})` };
		}
		if (rotation.strategy === "round-robin") {
			let cursor = ((h.rrCursor ?? 0) % eligible.length + eligible.length) % eligible.length;
			if (opts.avoidKey && eligible.length > 1 && slotKey(eligible[cursor].slot) === opts.avoidKey) {
				cursor = (cursor + 1) % eligible.length;
			}
			h.rrCursor = cursor + 1;
			await writePoolHealth(p, h).catch(() => {});
			const { slot, index } = eligible[cursor];
			return { slot, index, fromPool: true, reason: `round-robin(${cursor})` };
		}
		const { slot, index } = weightedPick(eligible.map((e) => ({ ...e, weight: e.slot.weight ?? 1 })));
		return { slot, index, fromPool: true, reason: `weighted(w=${slot.weight ?? 1})` };
	}

	if (fallbacks.length) {
		const { slot, index } = fallbacks[0];
		return { slot, index, fromPool: true, reason: "fallback-only (all weighted slots benched)" };
	}

	// Everything is in cooldown: return undefined — the caller keeps its current model and simply
	// retries on it (quota errors on every slot means the swap loop cannot help; thrashing between
	// benched slots would burn the remaining turn budget). PoolStatus/traces make the outage visible.
	return undefined;
	});
}

// Record a failure for a slot. Once consecutive failures reach maxRetries, bench it for cooldownMs
// and reset the counter (so post-cooldown it gets a fresh chance). Returns the new health.
// Record a provider/turn error for a slot (the in-process turn_end hook path). Error KIND drives
// the bench policy: quota/auth bench IMMEDIATELY (retrying will not fix an exhausted quota or a
// bad key); auth benches extra-long (6h floor) because keys do not self-heal; rate_limit/transient
// follow the maxRetries streak before a normal cooldown. Quota benches honor slot.quotaResetMs
// (effective = max(rotation.cooldownMs, slot.quotaResetMs)) and stamp lastBenchReason so the
// root pump's recovery scan can detect quota benches specifically.
export async function recordProviderError(p: Paths, slot: ModelSlot, kind: ProviderErrorKind, error: string): Promise<PoolSlotHealth> {
	const { rotation } = effectiveConfig();
	return withPoolLock(p, async () => {
	const h = await readPoolHealth(p);
	const key = slotKey(slot);
	const prev = h.slots[key] || { failures: 0 };
	// Deduplicate pi-internal retries of the SAME incident: pi can emit several error turns for one
	// underlying failure (stream retry, overflow-recovery re-run). An identical error on the same
	// slot within 30s counts once toward the streak, so maxRetries means real distinct failures.
	const sameIncident = prev.lastError === `${kind}: ${error}`.slice(0, 200)
		&& prev.lastErrorAt && (Date.now() - new Date(prev.lastErrorAt).getTime()) < 30_000;
	const failures = sameIncident ? (prev.failures || 0) : (prev.failures || 0) + 1;
	const next: PoolSlotHealth = { failures, lastError: `${kind}: ${error}`.slice(0, 200), lastErrorAt: new Date().toISOString(), deduped: sameIncident || undefined };
	const immediate = kind === "quota" || kind === "auth";
	if (failures >= rotation.maxRetries || immediate) {
		// Exponential backoff for repeated benching: a slot that keeps failing right after each
		// cooldown doubles its bench time (capped at 24h), so a long outage (monthly quota reset)
		// costs at most one probe attempt per doubling instead of one per cooldownMs.
		const benchStreak = (prev.benchStreak || 0) + 1;
		// B-1: effectiveBenchMs already floors on rotation.cooldownMs — drop the redundant Math.max.
		// auth is unaffected by quotaResetMs (auth benches do not self-heal on a known reset window).
		const base = kind === "auth" ? Math.max(rotation.cooldownMs, 6 * 60 * 60_000) : effectiveBenchMs(slot, rotation);
		const ms = Math.min(base * Math.pow(2, benchStreak - 1), 24 * 60 * 60_000);
		next.cooldownUntil = new Date(Date.now() + ms).toISOString();
		next.failures = 0; // fresh chance after cooldown
		next.benchStreak = benchStreak;
		// Issue 21: stamp the reason on every bench so the recovery scan can filter on "quota".
		// Always overwrite (a fresh bench invalidates any prior reason stamp).
		next.lastBenchReason = kind;
		// Stamp the original bench duration for the recovery trace's benchMs payload.
		next.lastBenchMs = ms;
		// A new bench also invalidates the prior recovery dedupe stamp — if the slot was recovered
		// and is being benched again, the NEXT recovery after THIS bench must fire (not be deduped
		// by the stale lastRecoveredAt from the previous cycle).
		delete next.lastRecoveredAt;
	}
	h.slots[key] = next;
	await writePoolHealth(p, h);
	await trace(p, "pool.slot_failure", { slot: key, failures, kind, error: error.slice(0, 200), cooldownUntil: next.cooldownUntil, benchReason: next.lastBenchReason }).catch(() => {});
	return next;
	});
}

// Record a success: clears the failure streak AND the bench backoff (a healthy call proves the
// slot works again — the next failure starts a fresh, short cooldown). Issue 21 B-3: preserve
// lastBenchReason + benchStreak + lastRecoveredAt across successes so the recovery scan's gate
// (bench expired + lastBenchReason === "quota" + activeTaskIds > 0) stays accurate even if a
// successful turn is followed by a re-bench. Only failures/lastError/lastErrorAt/cooldownUntil are
// cleared; lastRecoveredAt is preserved across successes so the next bench's eventual recovery
// event is not deduped by a stale stamp.
export async function recordSlotSuccess(p: Paths, slot: ModelSlot): Promise<void> {
	await withPoolLock(p, async () => {
	const h = await readPoolHealth(p);
	const key = slotKey(slot);
	const prev = h.slots[key];
	if (!prev || (!prev.failures && !prev.cooldownUntil && !prev.lastError)) return;
	h.slots[key] = {
		failures: 0,
		lastBenchReason: prev.lastBenchReason,
		lastBenchMs: prev.lastBenchMs,
		benchStreak: prev.benchStreak,
		lastRecoveredAt: prev.lastRecoveredAt,
	};
	await writePoolHealth(p, h);
	await trace(p, "pool.slot_success", { slot: key }).catch(() => {});
	});
}

// Manual cooldown control for `/swarm pool cooldown <key> <ms|clear>`. Issue 21: stamp
// lastBenchReason when a manual bench is applied (defaults to undefined so the recovery scan
// ignores manual benches — only error-driven quota benches trigger slot_recovered). Clear also
// wipes lastBenchReason + lastRecoveredAt so a future quota bench starts with a fresh recovery
// dedupe state.
export async function setSlotCooldown(p: Paths, key: string, ms: number | null): Promise<boolean> {
	return withPoolLock(p, async () => {
	const h = await readPoolHealth(p);
	const slot = h.slots[key];
	if (!slot && ms === null) return false;
	h.slots[key] = slot || { failures: 0 };
	if (ms === null) {
		delete h.slots[key].cooldownUntil;
		// Manual clear wipes both the bench reason stamp and the recovery dedupe stamp — a fresh
		// quota bench after the clear should NOT be deduped by an old lastRecoveredAt.
		delete h.slots[key].lastBenchReason;
		delete h.slots[key].lastBenchMs;
		delete h.slots[key].lastRecoveredAt;
	} else {
		h.slots[key].cooldownUntil = new Date(Date.now() + ms).toISOString();
		// Manual bench leaves lastBenchReason undefined so the recovery scan ignores it (only
		// error-driven quota benches trigger slot_recovered).
	}
	await writePoolHealth(p, h);
	return true;
	});
}

export async function poolStatus(p: Paths): Promise<{ slots: Array<ModelSlot & { key: string; health: PoolSlotHealth | undefined; inCooldown: boolean; cooldownRemainingMs: number; quotaResetMs: number; quotaAware: boolean }>; rotation: Required<RotationConfig> }> {
	const { slots, rotation } = effectiveConfig();
	const h = await readPoolHealth(p);
	const nowMs = Date.now();
	const cwd = process.cwd();
	return {
		rotation,
		slots: slots.map((slot) => {
			const key = slotKey(slot);
			const health = h.slots[key];
			const until = health?.cooldownUntil ? new Date(health.cooldownUntil).getTime() : 0;
			// Issue 21: surface the effective quotaResetMs (slot value or env default) so /swarm
			// pool list can render a "quota-aware" annotation. quotaAware=true means the effective
			// bench floor exceeds rotation.cooldownMs.
			const qrMs = (typeof (slot as ModelSlot).quotaResetMs === "number" && (slot as ModelSlot).quotaResetMs! > 0)
				? (slot as ModelSlot).quotaResetMs!
				: (readQuotaResetMsFor(cwd, key) || QUOTA_RESET_DEFAULT_MS);
			return { ...slot, key, health, inCooldown: until > nowMs, cooldownRemainingMs: Math.max(0, until - nowMs), quotaResetMs: qrMs, quotaAware: qrMs > 0 && qrMs > rotation.cooldownMs };
		}),
	};
}

// Pure helper: would `effectiveConfig()`'s pool currently produce an eligible pick? Used by
// preflightSpawn to classify "pool_exhausted" before spawning. Returns the reason string pickSlot
// WOULD use (or undefined if no pool is configured at all — caller treats that as "use singleton").
export async function previewPickable(p: Paths): Promise<{ configured: boolean; reason?: string; wouldPick?: PickResult }> {
	const { slots } = effectiveConfig();
	if (!slots.length) return { configured: false };
	const r = await pickSlot(p);
	if (r) return { configured: true, reason: r.reason, wouldPick: r };
	// No eligible slot: rephrase the pickSlot() empty result for the operator.
	const h = await readPoolHealth(p);
	const nowMs = Date.now();
	const total = slots.length;
	const benched = slots.filter((s) => {
		const until = h.slots[slotKey(s)]?.cooldownUntil;
		return typeof until === "string" && new Date(until).getTime() > nowMs;
	}).length;
	return { configured: true, reason: `all ${total} slot(s) benched (${benched} in cooldown); wait for cooldown to expire or /swarm pool clear <slot>` };
}

// Preflight a spawn/restart. Validates (1) settings shape — if a pool is configured but every slot
// has bad data, we report it; (2) the chosen (or defaulted) model resolves to a non-empty string and
// its provider is set; (3) tmux is alive for the swarm session — spawnAgent does its own tmux
// recovery on miss, but we surface it early so the operator gets an actionable message instead of
// a half-spawned window. Pure (no side effects), read-only — never mutates settings or pool state.
// Errors are classified with stable `kind` values for the formatter to render suggestions.
export type PreflightOptions = {
	/** Explicit model the caller wants; if undefined, pool/default resolution runs. */
	model?: string;
	/** Explicit provider; if undefined, derived from the resolved model. */
	provider?: string;
	/** Tmux session the spawn will land in (so we don't probe tmux for nothing). */
	tmuxSession?: string;
};

export async function preflightSpawn(p: Paths, opts: PreflightOptions = {}): Promise<PreflightResult> {
	// (1) Settings shape + integrity: surface any invalid config so we don't pretend everything
	// is fine when the user has a typo in their pool.
	const validation = validateSwarmSettings();
	if (!validation.ok) {
		const first = validation.errors[0];
		return {
			ok: false,
			error: {
				kind: "invalid_settings",
				message: `Settings validation failed: ${first.message}`,
				suggestion: `Run /swarm pool validate for the full list of issues; fix .pi/settings.json under the \`swarm\` (or \`extensions.swarm\`) key.`,
				errors: validation.errors.map((e) => `${e.field || "config"}: ${e.message}`),
			},
		};
	}

	// (2) Pool eligibility: if a pool is configured, can it yield a slot right now?
	const preview = await previewPickable(p);
	if (preview.configured) {
		if (!preview.wouldPick) {
			return {
				ok: false,
				error: {
					kind: "pool_exhausted",
					message: `All configured model-pool slots are in cooldown. ${preview.reason || ""}`.trim(),
					suggestion: `Wait for cooldown to expire (/swarm pool list), or /swarm pool clear <provider/model>.`,
				},
			};
		}
	}

	// (3) Model/provider resolution: figure out what would actually be used and sanity-check it.
	let model = opts.model;
	let provider = opts.provider;
	if (!model) {
		if (preview.wouldPick) {
			model = preview.wouldPick.slot.model;
			provider = provider || preview.wouldPick.slot.provider || currentProvider(model);
		} else {
			model = currentModel();
			provider = provider || currentProvider(model);
		}
	} else {
		provider = provider || currentProvider(model);
	}
	if (!model || !model.trim()) {
		return {
			ok: false,
			error: {
				kind: "unknown_model",
				model: model || "",
				suggestion: `Set swarm.defaultModel in .pi/settings.json, or PI_SWARM_DEFAULT_MODEL in your shell.`,
			},
		};
	}
	if (!provider || !provider.trim()) {
		return {
			ok: false,
			error: {
				kind: "provider_not_found",
				provider: provider || "",
				suggestion: `Set swarm.defaultProvider in .pi/settings.json, or PI_SWARM_DEFAULT_PROVIDER in your shell.`,
			},
		};
	}

	// (3b) Credential check (user-reported spawn-dead class): the resolved provider must have a
	// usable API key, otherwise the child `pi --provider X` exits with `No API key found for X`
	// and the spawned pane looks inexplicably dead. Key sources mirror pi's own lookup:
	// ~/.pi/agent/auth.json first, then the conventional env vars.
	const credErr = missingProviderCredential(provider);
	if (credErr) {
		return {
			ok: false,
			error: {
				kind: "provider_not_found",
				provider,
				suggestion: `Provider '${provider}' has no stored API key — a spawned pi would exit with 'No API key found for ${provider}'. Authenticate it (pi auth / ~/.pi/agent/auth.json), pick another slot (/swarm pool list), or set ${provider.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY in your shell.`,
			},
		};
	}

	// (4) tmux session liveness: only when the caller passes a session. Skip otherwise — `register`
	// paths adopt an existing pane instead of needing a session.
	if (opts.tmuxSession) {
		const tmuxCheck = await checkTmuxSession(opts.tmuxSession);
		if (!tmuxCheck.ok) {
			return {
				ok: false,
				error: {
					kind: "tmux_not_running",
					message: tmuxCheck.message || `tmux session '${opts.tmuxSession}' is not running.`,
					suggestion: `Start tmux: tmux new-session -d -s ${opts.tmuxSession} (or set TMUX to a running server).`,
				},
			};
		}
	}

	return { ok: true, resolved: { model, provider, fromPool: Boolean(preview.wouldPick) } };
}

// Render a PreflightError as an actionable multi-line message suitable for a `notify`/`throw`.
// Used by both spawnAgent and restartAgent to surface a uniform error to the user.
export function formatPreflightError(err: PreflightError): string {
	switch (err.kind) {
		case "unknown_model":
			return `PREFLIGHT: unknown model '${err.model}'.\nAction: ${err.suggestion}\nRun /swarm pool validate to check your full config.`;
		case "provider_not_found":
			return `PREFLIGHT: provider '${err.provider}' is not configured.\nAction: ${err.suggestion}\nRun /swarm pool validate to check your full config.`;
		case "pool_exhausted":
			return `PREFLIGHT: all model-pool slots are benched.\nReason: ${err.message}\nAction: ${err.suggestion}\nCurrent pool status: /swarm pool list`;
		case "tmux_not_running":
			return `PREFLIGHT: tmux is not running.\nReason: ${err.message}\nAction: ${err.suggestion}`;
		case "tmux_create_failed":
			return `PREFLIGHT: tmux window creation failed.\nReason: ${err.message}\nAction: ${err.suggestion}`;
		case "invalid_settings":
			return `PREFLIGHT: invalid swarm settings.\n${(err.errors || []).map((e) => `  - ${e}`).join("\n")}\nAction: ${err.suggestion}`;
		default: {
			// Exhaustiveness fallback: keep TS happy without `any`. Should be unreachable.
			const _exhaustive: never = err;
			return `PREFLIGHT: ${String((_exhaustive as any)?.message ?? "spawn aborted")}`;
		}
	}
}

// Lazy tmux-session probe (no tmux exec when not needed). Pure helper to keep preflightSpawn
// self-contained; uses $TMUX awareness rather than spawning `tmux has-session` so it stays fast
// and side-effect free. The real tmux probe is intentionally left to spawnAgent (which performs
// the actual new-session fallback).
export async function checkTmuxSession(session: string): Promise<{ ok: boolean; message?: string }> {
	if (!session || session === "unknown") return { ok: false, message: "tmux session name is unknown (no swarm started yet; run /swarm init)." };
	if (!process.env.TMUX && !process.env.PI_SWARM_TMUX_OK) {
		return { ok: false, message: `No $TMUX env var set — the swarm normally runs inside tmux. Session requested: ${session}.` };
	}
	return { ok: true };
}
