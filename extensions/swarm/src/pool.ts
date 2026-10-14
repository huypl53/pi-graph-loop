// === swarm/pool.ts — model pool: weighted rotation + health cooldown + failover picks ===
import { mkdir, readFile, stat, rm } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import type {
	ModelSlot,
	Paths,
	PoolHealthState,
	PoolProbeRound,
	PoolSlotHealth,
	PreflightError,
	PreflightResult,
	ProviderErrorKind,
	RotationConfig,
	RotationStrategy,
	SwarmSettings,
} from "./types/index.ts";
import { POOL_COOLDOWN_MS, POOL_MAX_RETRIES, POOL_BENCH_MAX_MS, POOL_BENCH_STREAK_DECAY_MS, POOL_FORCE_PROBE_ROUND } from "./constants.ts";
import { currentModel, currentProvider } from "./session.ts";
import {
	parseQuotaResetMs,
	readSwarmRawConfig,
	readSwarmSettings,
	readSwarmYml,
	swarmYmlPath,
	mergeSwarmConfig,
	findGlobalSwarmYaml,
	findSwarmYamlFile,
	readGlobalSwarmYml,
	GLOBAL_AGENT_DIR,
	getGlobalAgentDir,
	type SwarmConfigSource,
} from "./config.ts";
import { atomicWriteFile, trace } from "./state.ts";
import { expected, logSwarmError, traceLogged } from "./errorlog.ts";
import { getTerminalDriver } from "./terminal/index.ts";

export { parseQuotaResetMs } from "./config.ts";

export function classifyProviderError(message: string): ProviderErrorKind {
	const m = (message || "").toLowerCase();
	// Issue 70: usage_limit_reached / "usage limit has been reached" (live 429 quota bodies) must
	// classify quota — they route into the pool's immediate-bench policy (lastBenchReason=quota).
	// This branch runs BEFORE the 429/rate_limit branch so plain "429 rate limit" stays rate_limit.
	if (/quota|insufficient|billing|balance|exceeded your current quota|prepaid|usage_limit|usage limit/.test(m)) return "quota";
	if (/request buffer limit|request body too large|payload too large/.test(m)) return "request_limit";
	if (/rate.?limit|too many requests|429|overloaded/.test(m)) return "rate_limit";
	if (/auth_unavailable|no auth available|invalid api key|unauthorized|forbidden|401|403|authentication|api key/.test(m)) return "auth";
	if (/timeout|timed out|econnrefused|econnreset|enotfound|5\d\d|network|connection/.test(m)) return "transient";
	return "unknown";
}

// Issue 70: stable incident-identity string for an error message. Erases every digit run
// (resets_in_seconds, resets_at, request ids, ports, counts) and collapses whitespace so
// provider 429 bodies that mutate per-second normalize to ONE identity while genuinely
// different messages stay distinct. Paired with classifyProviderError kind + providerKey this
// forms the engine-retry incident identity (replaces raw error-text equality).
export function scrubErrorIdentity(message: string): string {
	return (message || "").toLowerCase().replace(/\d+/g, "n").replace(/\s+/g, " ").trim().slice(0, 200);
}

// Credential probe for preflightSpawn (3b): does this provider have a usable credential?
// Mirrors pi's own lookup order: ~/.pi/agent/auth.json entries, then the conventional
// <PROVIDER>_API_KEY / <PROVIDER>_APIKEY env vars. Returns undefined when a key exists.
//
// 2026-10-10 (live report): OAuth entries count as credentials. pi core (pi-ai
// resolveProviderAuth) resolves type:"oauth" entries — refreshing them at request time when
// near expiry — so a slot whose provider is OAuth-authenticated (e.g. cliproxyapi managed by
// ccs: {access, refresh, expires}) spawns fine and must NOT be flagged. Only an oauth entry
// with NEITHER access NOR refresh is unresolvable. (pi-ai also requires provider.auth.oauth
// support; this sync probe can't see provider config, so we accept any oauth entry — a
// provider that lacks oauth support would surface its own error at spawn, not 'No API key'.)
function missingProviderCredential(provider: string): string | undefined {
	if (!provider) return "no provider";
	try {
		const home = process.env.HOME || "";
		if (home) {
			const auth = JSON.parse(readFileSync(join(getGlobalAgentDir(), "auth.json"), "utf8")) as Record<string, any>;
			const entry = auth?.[provider];
			if (entry && typeof entry === "object") {
				if (entry.type === "api_key" && String(entry.key || entry.apiKey || "").trim()) return undefined;
				if (entry.type === "oauth" && (String(entry.access || "").trim() || String(entry.refresh || "").trim())) return undefined;
			}
		}
	} catch (err: any) {
		// Expected branches: no HOME or auth.json absent. A CORRUPT/unreadable auth.json silently
		// flipping the gate to env-fallback deserves a durable line.
		if (err?.code !== "ENOENT") {
			void logSwarmError(process.cwd(), "pool", "auth_key.read_failed", err);
		}
	}
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
	Number(process.env.PI_SWARM_QUOTA_RESET_MS) > 0 ? Math.floor(Number(process.env.PI_SWARM_QUOTA_RESET_MS)) : 0;

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
					const qrm = parseQuotaResetMs(s.quotaReset !== undefined ? s.quotaReset : s.quotaResetMs);
					if (qrm !== undefined) {
						const provider = typeof s.provider === "string" && s.provider ? s.provider : "(default)";
						const model = typeof s.model === "string" ? s.model : "";
						m.set(`${provider}/${model}`, qrm);
					}
				}
			}
		} catch (err) {
			// Quota cache is best-effort — but a corrupt cache silently zeroing quota resets would
			// starve slots that are actually cooled down. Log it (sync context: fire-and-forget).
			void logSwarmError(process.cwd(), "pool", "quota_cache.read_failed", err);
		}
	}
	return m.get(key) ?? 0;
}

// Pure helper: effective bench duration for a quota bench on the given slot. Returns
// max(rotation.cooldownMs, slot.quotaResetMs ?? QUOTA_RESET_DEFAULT_MS). Note the env default only
// applies when the per-slot value is undefined or 0 — if the slot explicitly sets quotaResetMs=0
// we want the same behavior as before (no env floor either). The D4 bench ceiling
// (rotation.benchMaxMs, default 1h) is applied by the caller (benchMsForStreak) — it applies to
// ALL kinds including auth (see plan §1.3 amendment: the historical "auth 6h floor" existed only
// in a comment; the Issue 21 refactor dropped it from code and two regression suites pin
// auth == cooldownMs).
export function effectiveBenchMs(
	slot: Pick<ModelSlot, "model" | "provider">,
	rotation: Required<RotationConfig>,
	cwd: string = process.cwd(),
): number {
	const key = slotKey(slot);
	const slotVal = (slot as ModelSlot).quotaResetMs;
	// Per-slot value wins when > 0; otherwise fall back to env default.
	const floor = typeof slotVal === "number" && slotVal > 0 ? slotVal : readQuotaResetMsFor(cwd, key) || QUOTA_RESET_DEFAULT_MS;
	return Math.max(rotation.cooldownMs, floor);
}

// D4 (plan 2026-10-14): the bench duration for a (slot, rotation) triple, BEFORE the exponential
// streak multiplier — clamped to the D4 ceiling so a slot is never benched longer than benchMaxMs.
// NOTE: every kind shares this path (auth included). The historical "auth 6h floor" existed only
// in a comment — the Issue 21 refactor dropped it from code, and pool-single-strike F2 +
// pool-retry-preserve-cache-no-6h pin auth == cooldownMs; the D4 ceiling supersedes backoff growth
// for ALL kinds (1h worst-case re-probe). See plan §1.3 amendment (2026-10-14, auth exemption removed).
function benchBaseMs(slot: Pick<ModelSlot, "model" | "provider">, rotation: Required<RotationConfig>, cwd: string = process.cwd()): number {
	return Math.min(effectiveBenchMs(slot, rotation, cwd), rotation.benchMaxMs);
}

// D4 (plan 2026-10-14): final bench ms for a fresh bench event on a slot with the given streak:
// base × 2^(streak-1), clamped to the D4 ceiling.
function benchMsForStreak(
	slot: Pick<ModelSlot, "model" | "provider">,
	kind: ProviderErrorKind,
	streak: number,
	rotation: Required<RotationConfig>,
	cwd: string = process.cwd(),
): number {
	return Math.min(benchBaseMs(slot, rotation, cwd) * Math.pow(2, streak - 1), rotation.benchMaxMs);
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
			} catch (err) {
				// Lost the stale-lock stat/rm race to a competing acquirer — expected contention path.
				await logSwarmError(undefined, "pool", "lock.stale_cleanup_skip", err, { lock, expected: expected("stale-lock race") });
			}
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
	} catch (err) {
		// existsSync passed, so a read/parse failure means the pool-health file is corrupt or
		// unreadable — reset-to-empty is the designed recovery, but it must be visible.
		await logSwarmError(p, "pool", "health.read_failed", err, { file });
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
			// D4/D3/D2 (plan 2026-10-14): env > yaml > default, same precedence shape as the other keys.
			benchMaxMs:
				Number(process.env.PI_SWARM_BENCH_MAX_MS) > 0
					? Math.floor(Number(process.env.PI_SWARM_BENCH_MAX_MS))
					: (r.benchMaxMs && r.benchMaxMs > 0 ? r.benchMaxMs : POOL_BENCH_MAX_MS),
			benchStreakDecayMs:
				Number(process.env.PI_SWARM_BENCH_STREAK_DECAY_MS) >= 0
					? Math.floor(Number(process.env.PI_SWARM_BENCH_STREAK_DECAY_MS))
					: (r.benchStreakDecayMs !== undefined && r.benchStreakDecayMs >= 0 ? r.benchStreakDecayMs : POOL_BENCH_STREAK_DECAY_MS),
			roleFallbackOnSwap: process.env.PI_SWARM_ROLE_FALLBACK_OFF === "1" ? false : (r.roleFallbackOnSwap ?? true),
			// D5 (§1.4): env off-switch wins, then yaml, then default ON.
			forceProbeRound: process.env.PI_SWARM_FORCE_PROBE_ROUND_OFF === "1" ? false : (r.forceProbeRound ?? POOL_FORCE_PROBE_ROUND),
		},
	};
}

// Canonical JSON format shown by /swarm pool help and copied verbatim into suggestions + docs.
// Kept in lock-step with the schema in docs/swarm/operations.md (see "Model pool configuration").
// Issue 21: quotaResetMs is optional (omit for slots without a known reset window). When set, the
// effective bench for a quota error becomes max(rotation.cooldownMs, quotaResetMs) — see
// effectiveBenchMs()). Canonical key: `quotaReset` (duration-friendly); `quotaResetMs` is a
// legacy alias. Accepts a duration string ("30m", "2h", "1h30m", "1d") or bare ms —
// parseQuotaResetMs().
export const POOL_FORMAT_EXAMPLE = {
	modelPool: [
		{ model: "gpt-5.4-mini", provider: "openai", weight: 50 },
		{ model: "claude-sonnet-4", provider: "anthropic", weight: 30, quotaReset: "30d" },
		{ model: "glm-5.1", provider: "zai-coding-cn", weight: 0 },
	],
	rotation: { strategy: "weighted", cooldownMs: 900000, maxRetries: 2 },
} as const;

// A singleton config (only defaultModel + defaultProvider) is treated as an OBSERVABLE implicit
// singleton pool of size 1 — it remains the canonical backward-compatible path for users who do not
// need rotation. This function answers "what does the implicit singleton look like right now?"
// without rewriting the user's settings file. Used by `/swarm pool show`, `/swarm pool help`, and
// preflight (so the singleton path is described in the same vocabulary as an explicit pool).
export function implicitSingletonPool(): {
	slots: ModelSlot[];
	rotation: Required<RotationConfig>;
	source: "settings" | "env" | "constants";
} {
	const settings = readSwarmSettings();
	const model = currentModel();
	const provider = currentProvider(model);
	const source =
		settings.defaultModel || settings.defaultProvider
			? "settings"
			: process.env.PI_SWARM_DEFAULT_MODEL || process.env.PI_SWARM_DEFAULT_PROVIDER
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
	| {
			kind: "both";
			slots: number;
			rotation?: RotationConfig;
			singleton: { defaultModel?: string; defaultProvider?: string };
			source: SwarmConfigSource;
	  };

export function classifySwarmSettings(cwd = process.cwd()): SettingsShape {
	const { cfg, source } = readSwarmRawConfig(cwd);
	if (!cfg) return { kind: "empty" };
	const slots = Array.isArray(cfg.modelPool) ? cfg.modelPool.length : 0;
	const rotation = cfg.rotation && typeof cfg.rotation === "object" ? (cfg.rotation as RotationConfig) : undefined;
	const hasSingleton = typeof cfg.defaultModel === "string" || typeof cfg.defaultProvider === "string";
	if (slots && hasSingleton)
		return {
			kind: "both",
			slots,
			rotation,
			singleton: { defaultModel: cfg.defaultModel, defaultProvider: cfg.defaultProvider },
			source: source!,
		};
	if (slots) return { kind: "explicit-pool", slots, rotation, source: source! };
	if (hasSingleton) return { kind: "singleton", defaultModel: cfg.defaultModel, defaultProvider: cfg.defaultProvider, source: source! };
	return { kind: "empty" };
}

// Validation errors caught by `/swarm pool validate` and `preflightSpawn`. Each carries a stable
// `kind` so the formatter can render an actionable suggestion; `field` is purely informational.
// `source` attributes the error to its config layer (v4.2).
export type PoolValidationError = { kind: string; field?: string; message: string; source?: "global" | "project" | "merged" | "default" };

// Validate a settings shape WITHOUT mutating the file. Returns [] on success; otherwise an array
// of structured errors suitable for `/swarm pool validate` rendering. Read-only. `warnings` are
// advisory (never flip ok).
//
// v4.2 changes:
//   - YAML-only: settings.json swarm blocks are no longer read; stale_swarm_json_block warning
//     fires unconditionally when settings.json carries a swarm block (self-extinguishing).
//   - Per-layer corrupt reporting: global_swarm_yml_unreadable / global_swarm_yml_eacces /
//     project_swarm_yml_unreadable / project_swarm_yml_eacces. No both_* aggregation kind.
//   - Per-key + per-slot provenance in output.
//   - Unknown-key warning (plain list, no suggestions) for both layers.
//   - inheritGlobal: false → global_inheritance_disabled warning.
//
// Follow-up 2026-09-05 (user report): `opts.registryProbe` (mirrors ctx.modelRegistry.find)
// enables LIVE resolvability checks per slot: `slot_unresolvable` when the provider/model pair
// is not in the registry, `slot_no_credential` when the provider has no API key (auth.json/env
// probe). Without a probe, validation degrades to structural-only (back-compat).
export function validateSwarmSettings(
	cwd = process.cwd(),
	opts: { registryProbe?: { find: (provider: string, modelId: string) => any } } = {},
): { ok: boolean; errors: PoolValidationError[]; warnings: PoolValidationError[]; shape: SettingsShape } {
	const errors: PoolValidationError[] = [];
	const warnings: PoolValidationError[] = [];
	let shape: SettingsShape;

	// v4.2: stale_swarm_json_block fires ALWAYS when settings.json carries a non-empty swarm block.
	const settingsFile = join(cwd, CONFIG_DIR_NAME, "settings.json");
	if (existsSync(settingsFile)) {
		try {
			const raw = JSON.parse(readFileSync(settingsFile, "utf8")) as Record<string, any>;
			const fromExt = raw?.extensions?.swarm;
			const fromTop = raw?.swarm;
			const hasSwarmBlock =
				(fromExt && typeof fromExt === "object" && Object.keys(fromExt).length > 0) ||
				(fromTop && typeof fromTop === "object" && Object.keys(fromTop).length > 0);
			if (hasSwarmBlock) {
				warnings.push({
					kind: "stale_swarm_json_block",
					field: ".pi/settings.json",
					message: `.pi/settings.json contains a swarm block that is no longer read by swarm. Remove it or move its contents to .pi/swarm.yml. See docs/swarm/tools.md.`,
					source: "default",
				});
			}
		} catch (err: any) {
			// Corrupt settings.json — pi core handles its own errors; swarm ignores.
			// Documented expected branch: settings.json is not a swarm config source in v4.2,
			// so a corrupt file is irrelevant to swarm. Logged once via expected() for the census.
			expected("settings_json_corrupt_ignored_by_swarm", err);
		}
	}

	// v4.2: use mergeSwarmConfig for layered merge with per-layer corrupt reporting.
	const resolved = mergeSwarmConfig(cwd, { freshGlobal: true });

	// Per-layer corrupt reporting (no aggregation kind).
	for (const c of resolved.corrupt) {
		const isEacces = c.errCode === "EACCES";
		const kind = isEacces
			? c.layer === "global"
				? "global_swarm_yml_eacces"
				: "project_swarm_yml_eacces"
			: c.layer === "global"
				? "global_swarm_yml_unreadable"
				: "project_swarm_yml_unreadable";
		const label = c.layer === "global" ? "~/.pi/agent/swarm.yml" : ".pi/swarm.yml";
		errors.push({
			kind,
			field: c.file,
			message: isEacces
				? `Cannot read ${label}: permission denied`
				: `Could not parse ${label}: corrupt YAML (comments are fine; check indentation/colons)`,
			source: c.layer,
		});
	}
	if (resolved.corrupt.length > 0) {
		shape = { kind: "empty" };
		return { ok: false, errors, warnings, shape };
	}

	const cfg = resolved.cfg;
	// v4.2: unknown-key warning (plain list, no suggestions) for both layers.
	// MUST fire before the empty-cfg early return, because unknown keys are stripped from cfg.
	// 2026-10-10: `issues` + `issue-sequencer` are project-layer keys (issues/config.ts reads
	// readSwarmYml(cwd) only) and are documented in the project scaffold (constants.ts) —
	// recognizing them only at the project layer keeps the global warning truthful (a global
	// `issues:` block really is ignored).
	const RECOGNIZED_BOTH = new Set([
		"modelPool",
		"rotation",
		"defaultModel",
		"defaultProvider",
		"terminalManager",
		"inheritGlobal",
		"roles",
	]);
	const RECOGNIZED_PROJECT = new Set([...RECOGNIZED_BOTH, "issues", "issue-sequencer"]);
	const projFile = findSwarmYamlFile(cwd);
	if (projFile) {
		try {
			const projYml = readSwarmYml(cwd);
			if (projYml) {
				for (const key of Object.keys(projYml)) {
					if (!RECOGNIZED_PROJECT.has(key)) {
						warnings.push({
							kind: "unknown_top_level_key",
							field: key,
							message: `[project] unknown key '${key}' in ${projFile.file} — ignored`,
							source: "project",
						});
					}
				}
			} else {
				// yml parses to null (empty/comments-only)
				warnings.push({
					kind: "swarm_yml_empty",
					field: ".pi/swarm.yml",
					message: `.pi/swarm.yml exists but declares no config (empty or comments-only) — fill it in (see /swarm pool help) or remove it to silence this warning.`,
					source: "project",
				});
			}
		} catch {
			/* corrupt already reported */
		}
	}
	const globalFile = findGlobalSwarmYaml();
	if (globalFile) {
		try {
			const globalYml = readGlobalSwarmYml(true);
			if (globalYml) {
				for (const key of Object.keys(globalYml)) {
					if (!RECOGNIZED_BOTH.has(key)) {
						warnings.push({
							kind: "unknown_top_level_key",
							field: key,
							message: `[global] unknown key '${key}' in ${globalFile.file} — ignored`,
							source: "global",
						});
					}
				}
			}
		} catch {
			/* corrupt already reported */
		}
	}

	if (!cfg || Object.keys(cfg).length === 0) {
		shape = { kind: "empty" };
		// Only emit swarm_yaml_missing if neither global nor project yml exists.
		const projExists = existsSync(swarmYmlPath(cwd));
		const globalExists = findGlobalSwarmYaml() !== null;
		if (!projExists && !globalExists) {
			warnings.push({
				kind: "swarm_yaml_missing",
				field: ".pi/swarm.yaml",
				message:
					"No swarm configuration found (.pi/swarm.yaml or .pi/swarm.yml, or ~/.pi/agent/swarm.yml). Run /swarm pool help or create .pi/swarm.yaml to configure defaultModel and defaultProvider.",
				source: "default",
			});
		}
		return { ok: true, errors, warnings, shape };
	}

	// v4.2: inheritGlobal: false → global_inheritance_disabled warning.
	if (resolved.globalInheritDisabled) {
		warnings.push({
			kind: "global_inheritance_disabled",
			field: "inheritGlobal",
			message: `Project has inheritGlobal: false — ~/.pi/agent/swarm.yml is ignored for this project`,
			source: "project",
		});
	}

	const source = resolved.source;
	const slots = Array.isArray(cfg.modelPool) ? cfg.modelPool : null;
	const rotation = cfg.rotation && typeof cfg.rotation === "object" ? cfg.rotation : null;
	// v4.2: source attribution for slot/rotation errors.
	const poolSource =
		resolved.sources.modelPool?.layer === "global"
			? "global"
			: resolved.sources.modelPool?.layer === "project.swarm.yml"
				? "project"
				: "merged";
	const rotationSource =
		resolved.sources.rotation?.layer === "global"
			? "global"
			: resolved.sources.rotation?.layer === "project.swarm.yml"
				? "project"
				: "merged";
	if (slots) {
		const seen = new Set<string>();
		slots.forEach((s: any, idx: number) => {
			if (!s || typeof s !== "object") {
				errors.push({
					kind: "slot_not_object",
					field: `modelPool[${idx}]`,
					message: `modelPool[${idx}] must be an object`,
					source: poolSource,
				});
				return;
			}
			const model = typeof s.model === "string" ? s.model.trim() : "";
			const provider = typeof s.provider === "string" ? s.provider.trim() : "";
			if (!model)
				errors.push({
					kind: "slot_empty_model",
					field: `modelPool[${idx}].model`,
					message: `Slot #${idx + 1} has an empty model name`,
					source: poolSource,
				});
			if (s.weight !== undefined) {
				if (typeof s.weight !== "number" || !Number.isFinite(s.weight) || s.weight < 0) {
					errors.push({
						kind: "slot_bad_weight",
						field: `modelPool[${idx}].weight`,
						message: `Slot #${idx + 1} weight must be a non-negative number (0 = fallback-only)`,
						source: poolSource,
					});
				}
			}
			const key = `${provider || "(default)"}/${model}`;
			if (seen.has(key) && model)
				errors.push({ kind: "slot_duplicate", field: `modelPool[${idx}]`, message: `Duplicate slot: ${key}`, source: poolSource });
			if (model) seen.add(key);
			// Issue 21: validate the optional quotaResetMs field. Reject non-numeric / negative / NaN
			// values so a typo is caught at validate time rather than silently treated as 0.
			// quotaReset is canonical; quotaResetMs is a back-compat alias (same semantics). When
			// both are present, quotaReset wins. Validate whichever field(s) the user actually set.
			const qrRaw = s.quotaReset !== undefined ? s.quotaReset : s.quotaResetMs;
			if (qrRaw !== undefined && parseQuotaResetMs(qrRaw) === undefined) {
				const fname = s.quotaReset !== undefined ? "quotaReset" : "quotaResetMs";
				errors.push({
					kind: "slot_bad_quota_reset",
					field: `modelPool[${idx}].${fname}`,
					message: `Slot #${idx + 1} ${fname} must be a duration ("30m", "2h", "1h30m", "1d") or a non-negative number of milliseconds (floor for quota benches; 1h benchMaxMs ceiling still applies)`,
					source: poolSource,
				});
			}
			if (s.quotaReset === undefined && s.quotaResetMs !== undefined && parseQuotaResetMs(s.quotaResetMs) !== undefined) {
				warnings.push({
					kind: "quota_reset_alias",
					field: `modelPool[${idx}].quotaResetMs`,
					message: `Slot #${idx + 1} uses the legacy field name quotaResetMs — rename it to quotaReset (same semantics, duration-friendly). The alias keeps working.`,
					source: poolSource,
				});
			}
			// Issue 22: validate the optional roles allow-list (warning-grade, informational — the
			// malformed value is treated as "no filter" by parseModelPool, but the operator should see it).
			if (s.roles !== undefined && (!Array.isArray(s.roles) || !s.roles.every((r: any) => typeof r === "string" && r.length > 0))) {
				errors.push({
					kind: "slot_bad_roles",
					field: `modelPool[${idx}].roles`,
					message: `Slot #${idx + 1} roles must be a string array of role-kind names (see completion.ts ROLE_KINDS for the closed set: root, planner, reviewer, tester, implementer, worker, observer)`,
					source: poolSource,
				});
			}
			// Follow-up F2 (2026-09-05): live resolvability probe — only when a registry probe is
			// supplied (the /swarm tool path passes ctx.modelRegistry; structural callers don't).
			// A slot that cannot resolve is a launch-time failure for spawns: flag it now.
			if (opts.registryProbe && model && provider) {
				const found = opts.registryProbe.find(provider, model);
				if (!found) {
					errors.push({
						kind: "slot_unresolvable",
						field: `modelPool[${idx}]`,
						message: `Slot #${idx + 1} ${provider}/${model} is not resolvable: no such model registered under that provider (pi auth / --list-models to inspect). Spawns targeting it would fail.`,
						source: poolSource,
					});
				} else if (missingProviderCredential(provider)) {
					errors.push({
						kind: "slot_no_credential",
						field: `modelPool[${idx}]`,
						message: `Slot #${idx + 1} provider '${provider}' has no stored API key — a spawned pi would exit with 'No API key found for ${provider}'. Authenticate it (pi auth) or set ${provider.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY.`,
						source: poolSource,
					});
				}
			}
		});
	}
	if (rotation) {
		if (rotation.strategy !== undefined && !["weighted", "round-robin", "sticky"].includes(rotation.strategy)) {
			errors.push({
				kind: "rotation_bad_strategy",
				field: "rotation.strategy",
				message: `rotation.strategy must be one of weighted | round-robin | sticky (got ${JSON.stringify(rotation.strategy)})`,
				source: rotationSource,
			});
		}
		if (
			rotation.cooldownMs !== undefined &&
			(typeof rotation.cooldownMs !== "number" || !Number.isFinite(rotation.cooldownMs) || rotation.cooldownMs < 0)
		) {
			errors.push({
				kind: "rotation_bad_cooldown",
				field: "rotation.cooldownMs",
				message: `rotation.cooldownMs must be a non-negative number of milliseconds`,
				source: rotationSource,
			});
		}
		if (
			rotation.maxRetries !== undefined &&
			(typeof rotation.maxRetries !== "number" || !Number.isFinite(rotation.maxRetries) || rotation.maxRetries < 1)
		) {
			errors.push({
				kind: "rotation_bad_maxretries",
				field: "rotation.maxRetries",
				message: `rotation.maxRetries must be a positive integer (>= 1)`,
				source: rotationSource,
			});
		}
		// D4 (plan 2026-10-14): bench ceiling must be a positive duration (0 would mean "never re-probe").
		if (
			rotation.benchMaxMs !== undefined &&
			(typeof rotation.benchMaxMs !== "number" || !Number.isFinite(rotation.benchMaxMs) || rotation.benchMaxMs <= 0)
		) {
			errors.push({
				kind: "rotation_bad_bench_max",
				field: "rotation.benchMaxMs",
				message: `rotation.benchMaxMs must be a positive number of milliseconds (bench ceiling for all kinds)`,
				source: rotationSource,
			});
		}
		// D3 (plan 2026-10-14): streak decay window — non-negative (0 = off).
		if (
			rotation.benchStreakDecayMs !== undefined &&
			(typeof rotation.benchStreakDecayMs !== "number" || !Number.isFinite(rotation.benchStreakDecayMs) || rotation.benchStreakDecayMs < 0)
		) {
			errors.push({
				kind: "rotation_bad_bench_decay",
				field: "rotation.benchStreakDecayMs",
				message: `rotation.benchStreakDecayMs must be a non-negative number of milliseconds (0 = decay off)`,
				source: rotationSource,
			});
		}
		// D2 (plan 2026-10-14): roles-bypass escape hatch must be boolean.
		if (rotation.roleFallbackOnSwap !== undefined && typeof rotation.roleFallbackOnSwap !== "boolean") {
			errors.push({
				kind: "rotation_bad_role_fallback",
				field: "rotation.roleFallbackOnSwap",
				message: `rotation.roleFallbackOnSwap must be true or false (roles-bypass swap fallback on empty role-filtered pick)`,
				source: rotationSource,
			});
		}
		// D5 (plan 2026-10-14 §1.4): forced probe round must be boolean.
		if (rotation.forceProbeRound !== undefined && typeof rotation.forceProbeRound !== "boolean") {
			errors.push({
				kind: "rotation_bad_force_probe",
				field: "rotation.forceProbeRound",
				message: `rotation.forceProbeRound must be true or false (probe each distinct model once when all slots benched)`,
				source: rotationSource,
			});
		}
	}
	const hasSingleton = typeof cfg.defaultModel === "string" || typeof cfg.defaultProvider === "string";
	const slotsCount = slots ? slots.length : 0;
	if (slotsCount && hasSingleton) {
		shape = {
			kind: "both",
			slots: slotsCount,
			rotation: rotation || undefined,
			singleton: { defaultModel: cfg.defaultModel, defaultProvider: cfg.defaultProvider },
			source,
		};
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

// Pool-avoid-failed-slot-20260926: pure helper — remove the just-failed slot from a candidate
// list BEFORE selection (the avoidance is a PRE-FILTER, not a re-roll). Live defect (2026-09-26):
// pool-swap supplies avoidKey: slotKey(currentSlot), but pickSlot only consulted it in the
// round-robin branch, so weighted selection still included the just-failed slot while it stayed
// eligible (first rate_limit failure does not bench) → h6-planner swapped ccs/glm-4.7 →
// ccs/glm-4.7 (reason=weighted(w=1)) and re-hit the same 429s until the swap-chain cap. Filtering
// FIRST preserves the alternatives' relative configured weights exactly (same distribution over a
// subset), keeps the roll deterministic under a pinned Math.random, and cannot recurse or bias.
function filterAvoiding<T extends { slot: ModelSlot }>(items: T[], avoidKey?: string): T[] {
	if (!avoidKey) return items;
	// Strict avoidance: when every candidate IS the just-failed slot (single-slot pool, or all
	// alternatives benched earlier in this failover), return EMPTY — the caller's existing
	// undefined safe-fallback path then reports pool.swap_no_candidate and keeps the current model,
	// instead of re-selecting the slot that just failed and pretending a swap occurred.
	return items.filter((e) => slotKey(e.slot) !== avoidKey);
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

export async function pickSlot(
	p: Paths,
	opts: { stickyKey?: string; avoidKey?: string; roleKind?: string; bypassRolesFilter?: boolean } = {},
): Promise<PickResult | undefined> {
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

		// Pool-avoid-failed-slot: pre-filter the just-failed slot from BOTH candidate pools before
		// any strategy selects (previously only round-robin honored avoidKey; weighted + sticky
		// re-picked the slot that just failed). filterAvoiding strictly removes that slot; when
		// every candidate would be filtered (single-slot / no alternatives), the arrays are empty
		// and the selection falls through to the existing undefined safe fallback below.
		const eligibleAlt = filterAvoiding(eligible, opts.avoidKey);
		const fallbackAlt = filterAvoiding(fallbacks, opts.avoidKey);

		if (eligibleAlt.length) {
			if (rotation.strategy === "sticky" && opts.stickyKey) {
				// Stable alternative: hash over the FILTERED candidate set (indices shift only when
				// the failed slot is removed) so an avoid-pass never lands back on the failed slot
				// while remaining deterministic for the same (stickyKey, candidate set).
				const { slot, index } = eligibleAlt[stickyIndex(opts.stickyKey, eligibleAlt.length)];
				return { slot, index, fromPool: true, reason: `sticky(${opts.stickyKey})` };
			}
			if (rotation.strategy === "round-robin") {
				let cursor = (((h.rrCursor ?? 0) % eligibleAlt.length) + eligibleAlt.length) % eligibleAlt.length;
				if (opts.avoidKey && eligibleAlt.length > 1 && slotKey(eligibleAlt[cursor].slot) === opts.avoidKey) {
					cursor = (cursor + 1) % eligibleAlt.length;
				}
				h.rrCursor = cursor + 1;
				await writePoolHealth(p, h).catch((err) => logSwarmError(p, "pool", "writePoolHealth.failed", err));
				const { slot, index } = eligibleAlt[cursor];
				return { slot, index, fromPool: true, reason: `round-robin(${cursor})` };
			}
			const { slot, index } = weightedPick(eligibleAlt.map((e) => ({ ...e, weight: e.slot.weight ?? 1 })));
			return { slot, index, fromPool: true, reason: `weighted(w=${slot.weight ?? 1})` };
		}

		if (fallbackAlt.length) {
			const { slot, index } = fallbackAlt[0];
			return { slot, index, fromPool: true, reason: "fallback-only (all weighted slots benched)" };
		}

		// Everything is in cooldown (or the ONLY slot is the one that just failed): return undefined —
		// the caller keeps its current model and simply retries on it (quota errors on every slot means
		// the swap loop cannot help; thrashing between benched slots would burn the remaining turn
		// budget). PoolStatus/traces make the outage visible. With avoidKey set and no alternatives,
		// returning undefined (instead of the failed slot) makes pool-swap record swap_no_candidate
		// and keep the current model — an honest no-swap beats a same-slot "swap".
		return undefined;
	});
}

// === D5 (plan 2026-10-14 §1.4): forced model probe round ===
// A proxy provider (cliproxyapi) is TRANSPORT only: cliproxyapi/glm-5.3, …/terra, …/fable each
// have an INDEPENDENT quota window. A cooldown on one model says nothing about the next — yet
// pickSlot treated every cooldown as a wall, so two cooling root slots produced 225x
// swap_no_candidate while the other models were never even tried (live incident 2026-10-13).
//
// advanceProbeRound is the D5 selection core. Called by the swap hook ONLY after the engine
// retry gate exhausted (light blips still get pi retry + gated swarm retry first). It walks the
// CANONICAL modelPool order from `cursor`, ignores cooldown AND roles entirely (this is a
// bounded diagnostic ring, not normal scheduling), and de-duplicates: a slot gets at most ONE
// forced probe per round, ever, across reloads (state is durable on swarm-state.json).
//
// Contract (returns):
//   { slot, round }   — next untried slot in canonical order; triedSlots + cursor already
//                        persisted BEFORE the caller burns pi.setModel on it (crash after pick
//                        may sacrifice one probe, but can never duplicate it after reload)
//   { slot: undefined, round } — round exhausted: every configured slot is in triedSlots.
//                        round.exhaustedAt + nextProbeAt are stamped (earliest cooldown among
//                        tried slots, clamped to ≤ benchMaxMs from now — D4); NO probe fires
//                        before nextProbeAt. The caller records swap_no_candidate / exhausted.
//   undefined          — D5 disabled (config/env) or no pool: caller falls back to D2 behavior.
//
// NO pool-lock here: the mutation target is swarm-state.json (withLock), not pool-state.json.
// Must be called OUTSIDE withLock (the swap hook's own lock usage wraps state reads separately).
export async function advanceProbeRound(
	p: Paths,
	cwd: string,
	agentId: string,
	failedSlot: ModelSlot,
	resolvable?: (slot: ModelSlot) => boolean,
): Promise<{ slot?: ModelSlot; round: PoolProbeRound } | undefined> {
	const { slots, rotation } = effectiveConfig();
	if (!rotation.forceProbeRound || !slots.length) return undefined;
	// Canonical ordered unique slot keys (dedupe identical provider/model entries).
	const canonical = slots.map((s) => ({ slot: s, key: slotKey(s) }));
	const uniqueKeys = [...new Set(canonical.map((c) => c.key))];
	const failedKey = slotKey(failedSlot);
	// Read-modify-write the durable round under the state lock (same lock the swap hook uses for
	// its roleKind read — sequential with the hook's own state access).
	const { readState, writeState, withLock } = await import("./state.ts");
	return withLock(p, async () => {
		const st = await readState(p, cwd);
		const rounds = st.poolProbeRounds ?? {};
		let round = rounds[agentId];
		const nowMs = Date.now();
		// A round that already recorded its exhaustion stays fenced until nextProbeAt: errors on
		// the current slot BEFORE due must not re-open or extend the round (S3's "no 4th probe").
		if (round?.exhaustedAt && round.nextProbeAt) {
			const dueMs = new Date(round.nextProbeAt).getTime();
			if (Number.isFinite(dueMs) && nowMs < dueMs) {
				return { slot: undefined, round };
			}
			// Due (or overdue — e.g. bench ceiling elapsed while the session was down): open a FRESH
			// round seeded with only the current failed slot. triedSlots from the old round are
			// eligible again: their cooldowns expired or the operator cleared them.
			round = { roundId: `probe-${nowMs}`, startedAt: new Date(nowMs).toISOString(), triedSlots: [], cursor: 0 };
		}
		if (!round) {
			round = { roundId: `probe-${nowMs}`, startedAt: new Date(nowMs).toISOString(), triedSlots: [], cursor: 0 };
		}
		// The failing CURRENT slot counts as tried — the probe ring starts AFTER it.
		if (!round.triedSlots.includes(failedKey)) round.triedSlots.push(failedKey);
		// Walk canonical order from the cursor for the first untried unique slot.
		const startIdx = Math.min(Math.max(0, round.cursor || 0), Math.max(0, canonical.length - 1));
		let pickedIdx = -1;
		const skippedUnresolvable: string[] = [];
		for (let off = 0; off < canonical.length; off++) {
			const idx = (startIdx + off) % canonical.length;
			const key = canonical[idx].key;
			if (round.triedSlots.includes(key)) continue;
			// Deduplicate identical keys: only the FIRST canonical occurrence may be probed.
			if (canonical.findIndex((c) => c.key === key) !== idx) continue;
			// D5 S6: a slot the caller cannot resolve to a live model (registry miss) is durably
			// skipped WITHOUT burning a probe on it — recorded in triedSlots so it is never
			// revisited this round, and traced once here (the trace fires under the state lock
			// but is append-only IO; acceptable — same shape as writePoolHealth inside withPoolLock).
			if (resolvable && !resolvable(canonical[idx].slot)) {
				round.triedSlots.push(key);
				skippedUnresolvable.push(key);
				continue;
			}
			pickedIdx = idx;
			break;
		}
		if (skippedUnresolvable.length) {
			await trace(p, "pool.probe_round_slot_unresolvable", { agentId, roundId: round.roundId, slots: skippedUnresolvable }).catch(() => {});
		}
		if (pickedIdx === -1) {
			// Round exhausted: stamp durable fence + earliest cooldown (clamped to benchMaxMs — D4).
			const h = await readPoolHealth(p);
			let earliest = Number.POSITIVE_INFINITY;
			for (const key of round.triedSlots) {
				const cd = h.slots[key]?.cooldownUntil ? new Date(h.slots[key].cooldownUntil as string).getTime() : NaN;
				if (Number.isFinite(cd)) earliest = Math.min(earliest, cd);
			}
			// No cooldown recorded (all expired/cleared) → probe again after the ceiling; else the
			// earliest deadline, never past now + benchMaxMs (D4 operator invariant).
			const base = Number.isFinite(earliest) ? earliest : nowMs;
			const due = Math.min(Math.max(base, nowMs), nowMs + rotation.benchMaxMs);
			round.exhaustedAt = new Date(nowMs).toISOString();
			round.nextProbeAt = new Date(due).toISOString();
			round.cursor = 0;
			rounds[agentId] = round;
			st.poolProbeRounds = rounds;
			await writeState(p, st);
			return { slot: undefined, round };
		}
		const picked = canonical[pickedIdx];
		round.triedSlots.push(picked.key);
		round.cursor = (pickedIdx + 1) % canonical.length;
		delete round.exhaustedAt;
		delete round.nextProbeAt;
		delete round.wakeSentAt;
		rounds[agentId] = round;
		st.poolProbeRounds = rounds;
		await writeState(p, st);
		return { slot: picked.slot, round };
	});
}

// Clear an agent's open probe round (success path, /swarm pool clear, or manual un-bench).
// Returns true when a round existed and was removed.
export async function clearProbeRound(p: Paths, cwd: string, agentId: string): Promise<boolean> {
	const { readState, writeState, withLock } = await import("./state.ts");
	return withLock(p, async () => {
		const st = await readState(p, cwd);
		if (!st.poolProbeRounds?.[agentId]) return false;
		delete st.poolProbeRounds[agentId];
		await writeState(p, st);
		return true;
	});
}

// Record a failure for a slot. Once consecutive failures reach maxRetries, bench it for cooldownMs
// and reset the counter (so post-cooldown it gets a fresh chance). Returns the new health.
// Record a provider/turn error for a slot (the in-process turn_end hook path). Error KIND drives
// the bench policy: quota/auth bench IMMEDIATELY (retrying will not fix an exhausted quota or a
// bad key); rate_limit/transient follow the maxRetries streak before a normal cooldown.
// All bench durations are capped at rotation.benchMaxMs (default 1h). Quota benches honor slot.quotaResetMs
// as a base floor (effective = max(rotation.cooldownMs, slot.quotaResetMs)) before the ceiling, and stamp
// lastBenchReason so the root pump's recovery scan can detect quota benches specifically.
export async function recordProviderError(p: Paths, slot: ModelSlot, kind: ProviderErrorKind, error: string): Promise<PoolSlotHealth> {
	const { rotation } = effectiveConfig();
	return withPoolLock(p, async () => {
		const h = await readPoolHealth(p);
		const key = slotKey(slot);
		const prev = h.slots[key] || { failures: 0 };
		const nowMs = Date.now();
		// Deduplicate pi-internal retries of the SAME incident: pi can emit several error turns for one
		// underlying failure (stream retry, overflow-recovery re-run). An identical error on the same
		// slot within 30s counts once toward the streak, so maxRetries means real distinct failures.
		const sameIncident =
			prev.lastError === `${kind}: ${error}`.slice(0, 200) &&
			prev.lastErrorAt &&
			nowMs - new Date(prev.lastErrorAt).getTime() < 30_000;
		const failures = sameIncident ? prev.failures || 0 : (prev.failures || 0) + 1;
		const next: PoolSlotHealth = {
			failures,
			lastError: `${kind}: ${error}`.slice(0, 200),
			lastErrorAt: new Date(nowMs).toISOString(),
			deduped: sameIncident || undefined,
		};
		const immediate = kind === "quota" || kind === "auth" || kind === "request_limit";
		// === D1 (plan 2026-10-14): no rolling re-bench while already benched ===
		// A slot benched-but-still-serving (no swap candidate existed) re-enters here on every error
		// turn. Re-benching would roll cooldownUntil forward forever and inflate benchStreak within a
		// single outage (live incident: 225 iterations, streak 315→540 in 4 minutes). While benched,
		// repeat errors carry no new information: record the error, keep the bench — EXCEPT when the
		// new bench would be strictly more severe (severity escalation, R3), e.g. rate_limit 15m → auth/quota 1h.
		// NOTE: the carry-over check runs for EVERY error while benched (not only bench-eligible
		// ones) because failures are forced to 0 in the carry-over path — a non-immediate kind can
		// never reach maxRetries on a benched slot, so gating on (failures >= maxRetries || immediate)
		// would let its errors silently accumulate nothing while the bench keeps rolling on the next
		// immediate kind. Carry-over is the correct outcome for every sub-severe error while benched.
		const prevCooldownEnd = prev.cooldownUntil ? new Date(prev.cooldownUntil).getTime() : 0;
		const alreadyBenched = prevCooldownEnd > nowMs;
		let benchedAlready = false;
		if (alreadyBenched) {
			// What would the new bench look like? (next bench streak, D4-capped duration)
			const escalStreak = (prev.benchStreak || 0) + 1;
			const benchMsCandidate = benchMsForStreak(slot, kind, escalStreak, rotation, p.cwd);
			const newEnd = nowMs + benchMsCandidate;
			if (newEnd > prevCooldownEnd) {
				// Severity escalation: apply the new (longer) bench as a REAL bench event — upgrade
				// lastBenchReason so the recovery scan's quota gate sees the true kind (R3). Falls
				// through to the normal bench branch below (which recomputes the same ms).
			} else {
				// Plain carry-over: keep the existing bench entirely; do not accumulate failures
				// (probe-failure info only counts post-cooldown — R2) and do not touch the streak.
				benchedAlready = true;
				next.failures = 0;
				next.cooldownUntil = prev.cooldownUntil;
				next.benchStreak = prev.benchStreak;
				next.lastBenchReason = prev.lastBenchReason;
				next.lastBenchMs = prev.lastBenchMs;
				next.lastBenchAt = prev.lastBenchAt;
				next.lastRecoveredAt = prev.lastRecoveredAt;
				h.slots[key] = next;
				await writePoolHealth(p, h);
				await trace(p, "pool.slot_failure", {
					slot: key,
					failures: next.failures,
					kind,
					error: error.slice(0, 200),
					cooldownUntil: next.cooldownUntil,
					benchReason: next.lastBenchReason,
					benchedAlready: true,
				}).catch(() => {});
				return next;
			}
		}
		if (failures >= rotation.maxRetries || immediate) {
			// Exponential backoff for repeated benching: a slot that keeps failing right after each
			// cooldown re-benches longer (D4: clamped to rotation.benchMaxMs, default 1h — replacing
			// the historical 24h cap which starved pools because it exceeded every real provider recovery window;
			// a benched slot must come back for a fresh probe within benchMaxMs so an N-slot pool always cycles).
			// Note: applies to all kinds including auth (no special auth exemption or 6h floor).
			const benchStreak = (prev.benchStreak || 0) + 1;
			const ms = benchMsForStreak(slot, kind, benchStreak, rotation, p.cwd);
			next.cooldownUntil = new Date(nowMs + ms).toISOString();
			next.failures = 0; // fresh chance after cooldown
			next.benchStreak = benchStreak;
			// Issue 21: stamp the reason on every bench so the recovery scan can filter on "quota".
			// Always overwrite (a fresh bench invalidates any prior reason stamp).
			next.lastBenchReason = kind;
			// Stamp the original bench duration for the recovery trace's benchMs payload.
			next.lastBenchMs = ms;
			// D3 (plan 2026-10-14): stamp bench-start for recordSlotSuccess's streak decay.
			next.lastBenchAt = new Date(nowMs).toISOString();
			// A new bench also invalidates the prior recovery dedupe stamp — if the slot was recovered
			// and is being benched again, the NEXT recovery after THIS bench must fire (not be deduped
			// by the stale lastRecoveredAt from the previous cycle).
			delete next.lastRecoveredAt;
		}
		h.slots[key] = next;
		await writePoolHealth(p, h);
		await trace(p, "pool.slot_failure", {
			slot: key,
			failures,
			kind,
			error: error.slice(0, 200),
			cooldownUntil: next.cooldownUntil,
			benchReason: next.lastBenchReason,
			benchedAlready: benchedAlready || undefined,
		}).catch(() => {});
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
		// === D3 (plan 2026-10-14): bench-streak decay ===
		// A slot healthy for >= benchStreakDecayMs since its last bench has outlived the world that
		// caused the streak; reset it so the next failure starts at the short base bench, not 2^n.
		// R1 (red-team): the original early-return fired on the SECOND+ healthy turn (the first
		// success cleared failures/cooldownUntil/lastError), so decay must be part of the guard
		// itself, and lastBenchAt must be preserved below (it was previously wiped by the rebuild).
		const { rotation } = effectiveConfig();
		const decayMs = rotation.benchStreakDecayMs ?? 0;
		const lastBenchAtMs = prev?.lastBenchAt ? new Date(prev.lastBenchAt).getTime() : 0;
		const decayFire = !!(prev?.benchStreak && prev.benchStreak > 0 && lastBenchAtMs && decayMs > 0 && Date.now() - lastBenchAtMs >= decayMs);
		if (!prev || (!prev.failures && !prev.cooldownUntil && !prev.lastError && !decayFire)) return;
		h.slots[key] = {
			failures: 0,
			lastBenchReason: prev.lastBenchReason,
			lastBenchMs: prev.lastBenchMs,
			benchStreak: decayFire ? 0 : prev.benchStreak, // D3 decay
			lastBenchAt: prev.lastBenchAt, // R1: preserved, never wiped by success
			lastRecoveredAt: prev.lastRecoveredAt,
		};
		if (decayFire) {
			await trace(p, "pool.slot_streak_decayed", { slot: key, was: prev.benchStreak, afterMs: decayMs }).catch(() => {});
		}
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
			// D3: fresh-start — a cleared slot has no bench age, so decay starts counting from the
			// next bench (R5: without this delete, a stale lastBenchAt could decay a future streak early).
			delete h.slots[key].lastBenchAt;
		} else {
			h.slots[key].cooldownUntil = new Date(Date.now() + ms).toISOString();
			// D3: manual benches stamp bench-start too (R5) — otherwise decay would key off a stale
			// stamp from days earlier or never fire.
			h.slots[key].lastBenchAt = new Date().toISOString();
			// Manual bench leaves lastBenchReason undefined so the recovery scan ignores it (only
			// error-driven quota benches trigger slot_recovered).
		}
		await writePoolHealth(p, h);
		return true;
	});
}

export async function poolStatus(p: Paths): Promise<{
	slots: Array<
		ModelSlot & {
			key: string;
			health: PoolSlotHealth | undefined;
			inCooldown: boolean;
			cooldownRemainingMs: number;
			quotaResetMs: number;
			quotaAware: boolean;
		}
	>;
	rotation: Required<RotationConfig>;
}> {
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
			const qrMs =
				typeof (slot as ModelSlot).quotaResetMs === "number" && (slot as ModelSlot).quotaResetMs! > 0
					? (slot as ModelSlot).quotaResetMs!
					: readQuotaResetMsFor(cwd, key) || QUOTA_RESET_DEFAULT_MS;
			return {
				...slot,
				key,
				health,
				inCooldown: until > nowMs,
				cooldownRemainingMs: Math.max(0, until - nowMs),
				quotaResetMs: qrMs,
				quotaAware: qrMs > 0 && qrMs > rotation.cooldownMs,
			};
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
	return {
		configured: true,
		reason: `all ${total} slot(s) benched (${benched} in cooldown); wait for cooldown to expire or /swarm pool clear <slot>`,
	};
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
				suggestion: `Run /swarm pool validate for the full list of issues; fix in .pi/swarm.yaml (or .pi/swarm.yml).`,
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
				suggestion: `Set defaultModel in .pi/swarm.yaml, or PI_SWARM_DEFAULT_MODEL in your shell.`,
			},
		};
	}
	if (!provider || !provider.trim()) {
		return {
			ok: false,
			error: {
				kind: "provider_not_found",
				provider: provider || "",
				suggestion: `Set defaultProvider in .pi/swarm.yaml, or PI_SWARM_DEFAULT_PROVIDER in your shell.`,
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

// Lazy terminal-session probe. Resolves the active terminal driver (consults env var
// PI_SWARM_TERMINAL_MANAGER, then swarm.yml terminalManager, defaulting to tmux).
// Under herdr, no $TMUX check is needed.
export async function checkTmuxSession(session: string): Promise<{ ok: boolean; message?: string }> {
	if (!session || session === "unknown")
		return { ok: false, message: "tmux session name is unknown (no swarm started yet; run /swarm init)." };
	const driver = getTerminalDriver();
	if (driver.id === "herdr" || process.env.PI_SWARM_TERMINAL_MANAGER === "herdr") {
		return { ok: true };
	}
	if (!process.env.TMUX && !process.env.PI_SWARM_TMUX_OK) {
		return { ok: false, message: `No $TMUX env var set — the swarm normally runs inside tmux. Session requested: ${session}.` };
	}
	return { ok: true };
}

export const checkTerminalSession = checkTmuxSession;
