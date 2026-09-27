// === swarm/config.ts — raw swarm config resolution across global yml + project yml ===
//
// Single source of truth for reading the RAW swarm config block (the object that carries
// modelPool / rotation / defaultModel / defaultProvider) before session.ts's parsers
// normalize it. Two file sources, layered merge (per-top-level-key winner-takes-all):
//
//   1. `~/.pi/agent/swarm.yml` (or `.yaml`)  ← global base layer (NEW in v4.2)
//   2. `.pi/swarm.yml`     (or `.yaml`)      ← project-local override layer
//
// YAML-only: `.pi/settings.json` swarm blocks are no longer read (see v4.2 spec §3).
// Per-key merge: project key wins when present, global key fills when absent. modelPool
// is whole-array replacement (project array wins entirely when present).
//
// inheritGlobal: false in project yml disables global inheritance (global still READ
// for corrupt visibility, never applied). inheritGlobal is project-only; ignored in global.
//
// Error contract:
//   - readSwarmRawConfig: missing files → { cfg: null, source: null }; corrupt files →
//     the corrupt piece is skipped but reported via corrupt[] with {layer, file, errCode}.
//   - readSwarmYml / readGlobalSwarmYml: return null when absent, THROW on corrupt YAML
//     (so /swarm pool validate can surface the per-layer corrupt kinds).
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { parse as parseYaml } from "yaml";
import { logSwarmError } from "./errorlog.ts";
import type { ModelSlot, RotationConfig, RotationStrategy, SwarmSettings } from "./types/index.ts";

export type SwarmConfigSource = "swarm.yml" | "swarm.yaml" | "global-swarm.yml" | "global-swarm.yaml";

export type ConfigKey = "modelPool" | "rotation" | "defaultModel" | "defaultProvider" | "terminalManager" | "inheritGlobal";

export type SourceLayer = "global" | "project.swarm.yml" | "default";

export type SourceInfo = {
	layer: SourceLayer;
	file?: string;
	value?: unknown;
};

export type CorruptReport = {
	layer: "global" | "project";
	file: string;
	errCode?: string;
};

export type ResolvedConfig = {
	cfg: Record<string, any>;
	sources: Partial<Record<ConfigKey, SourceInfo>>;
	corrupt: CorruptReport[];
	globalInheritDisabled: boolean;
};

// === Global file paths ===
// HOME is read at call time (not module load) so tests can override HOME between fixtures.
export function getGlobalAgentDir(): string {
	return join(process.env.HOME || homedir(), ".pi", "agent");
}
export function getGlobalSwarmYmlPrimary(): string {
	return join(getGlobalAgentDir(), "swarm.yml");
}
export function getGlobalSwarmYmlAlias(): string {
	return join(getGlobalAgentDir(), "swarm.yaml");
}
// Back-compat: module-level constants computed at import time. Tests that override HOME
// should use the get*() functions instead.
export const GLOBAL_AGENT_DIR = join(process.env.HOME || homedir(), ".pi", "agent");
export const GLOBAL_SWARM_YML_PRIMARY = join(GLOBAL_AGENT_DIR, "swarm.yml");
export const GLOBAL_SWARM_YML_ALIAS = join(GLOBAL_AGENT_DIR, "swarm.yaml");

export function findGlobalSwarmYaml(): { file: string; source: "global-swarm.yaml" | "global-swarm.yml" } | null {
	const alias = getGlobalSwarmYmlAlias();
	const primary = getGlobalSwarmYmlPrimary();
	if (existsSync(alias)) return { file: alias, source: "global-swarm.yaml" };
	if (existsSync(primary)) return { file: primary, source: "global-swarm.yml" };
	return null;
}

export function findSwarmYamlFile(cwd: string): { file: string; source: "swarm.yaml" | "swarm.yml" } | null {
	const yaml = join(cwd, CONFIG_DIR_NAME, "swarm.yaml");
	if (existsSync(yaml)) return { file: yaml, source: "swarm.yaml" };
	const yml = join(cwd, CONFIG_DIR_NAME, "swarm.yml");
	if (existsSync(yml)) return { file: yml, source: "swarm.yml" };
	return null;
}

export function swarmYmlPath(cwd: string): string {
	const found = findSwarmYamlFile(cwd);
	if (found) return found.file;
	return join(cwd, CONFIG_DIR_NAME, "swarm.yml");
}

// Read + parse `.pi/swarm.yaml` or `.pi/swarm.yml`. null when absent; THROWS on corrupt YAML.
export function readSwarmYml(cwd: string): Record<string, any> | null {
	const found = findSwarmYamlFile(cwd);
	if (!found) return null;
	const doc = parseYaml(readFileSync(found.file, "utf8"));
	if (!doc || typeof doc !== "object" || Array.isArray(doc)) return null;
	return doc as Record<string, any>;
}

// === Global yml memo (simple per-process, no TTL) ===
let globalYmlMemo: Record<string, any> | null | undefined = undefined;
let globalYmlMemoHome: string | undefined = undefined;

export function readGlobalSwarmYml(fresh = false): Record<string, any> | null {
	const currentHome = process.env.HOME || homedir();
	// Bust memo if HOME changed (tests override HOME)
	if (!fresh && globalYmlMemo !== undefined && globalYmlMemoHome === currentHome) return globalYmlMemo;
	globalYmlMemoHome = currentHome;
	const found = findGlobalSwarmYaml();
	if (!found) {
		globalYmlMemo = null;
		return null;
	}
	try {
		const doc = parseYaml(readFileSync(found.file, "utf8"));
		if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
			globalYmlMemo = null;
			return null;
		}
		globalYmlMemo = doc as Record<string, any>;
		return globalYmlMemo;
	} catch (err: any) {
		throw err;
	}
}

// Test-only helper: clear the global yml memo. Exposed so tests that override HOME
// between fixtures can force a fresh read.
export function _clearGlobalYmlMemoForTests() {
	globalYmlMemo = undefined;
	globalYmlMemoHome = undefined;
}

const RECOGNIZED_KEYS: ConfigKey[] = ["modelPool", "rotation", "defaultModel", "defaultProvider", "terminalManager", "inheritGlobal"];

// Layered merge: global (lowest yml precedence) + project (highest yml precedence).
// Per-top-level-key winner-takes-all. modelPool is whole-array replacement.
// inheritGlobal is project-only; ignored in global.
// corrupt[] is populated regardless of inheritGlobal (global always read for visibility).
export function mergeSwarmConfig(cwd: string, opts: { freshGlobal?: boolean } = {}): ResolvedConfig {
	const result: ResolvedConfig = {
		cfg: {},
		sources: {},
		corrupt: [],
		globalInheritDisabled: false,
	};

	// Step 1: read project yml
	let projYml: Record<string, any> | null = null;
	let projFile: string | null = null;
	try {
		projYml = readSwarmYml(cwd);
		projFile = swarmYmlPath(cwd);
	} catch (err: any) {
		const found = findSwarmYamlFile(cwd);
		if (found) {
			result.corrupt.push({ layer: "project", file: found.file, errCode: err?.code });
			void logSwarmError(cwd, "config", "project_swarm_yml.parse_failed", err, { errCode: err?.code });
		}
	}

	// Step 2: read global yml ALWAYS (memoized). corrupt[] populated regardless of inheritGlobal.
	let globalYml: Record<string, any> | null = null;
	let globalFile: string | null = null;
	try {
		globalYml = readGlobalSwarmYml(opts.freshGlobal === true);
		const found = findGlobalSwarmYaml();
		globalFile = found?.file ?? null;
	} catch (err: any) {
		const found = findGlobalSwarmYaml();
		if (found) {
			result.corrupt.push({ layer: "global", file: found.file, errCode: err?.code });
			void logSwarmError(cwd, "config", "global_swarm_yml.read_failed", err, { errCode: err?.code });
		}
	}

	// Step 3: determine inheritGlobal from project (project-only key; ignored in global)
	const inheritDisabled = projYml?.inheritGlobal === false;
	if (inheritDisabled) {
		result.globalInheritDisabled = true;
	}

	// Step 4: apply global layer ONLY when not opted out
	if (globalYml && !inheritDisabled) {
		for (const key of RECOGNIZED_KEYS) {
			if (key === "inheritGlobal") continue; // ignored in global
			if (globalYml[key] !== undefined) {
				result.cfg[key] = globalYml[key];
				result.sources[key] = { layer: "global", file: globalFile ?? undefined };
			}
		}
	}

	// Step 5: apply project layer (highest yml precedence)
	if (projYml) {
		for (const key of RECOGNIZED_KEYS) {
			if (projYml[key] !== undefined) {
				result.cfg[key] = projYml[key];
				result.sources[key] = { layer: "project.swarm.yml", file: projFile ?? undefined };
			}
		}
		// inheritGlobal attribution
		if (projYml.inheritGlobal === undefined) {
			result.sources.inheritGlobal = { layer: "default", value: true };
		} else if (projYml.inheritGlobal !== false) {
			result.sources.inheritGlobal = { layer: "project.swarm.yml", file: projFile ?? undefined, value: true };
		} else {
			result.sources.inheritGlobal = { layer: "project.swarm.yml", file: projFile ?? undefined, value: false };
		}
	} else {
		result.sources.inheritGlobal = { layer: "default", value: true };
	}

	return result;
}

// Back-compat wrapper: returns the merged cfg + provenance + corrupt list.
export function readSwarmRawConfig(cwd: string): {
	cfg: Record<string, any> | null;
	source: SwarmConfigSource | null;
	sources: Partial<Record<ConfigKey, SourceInfo>>;
	corrupt: CorruptReport[];
	globalInheritDisabled: boolean;
} {
	const resolved = mergeSwarmConfig(cwd);

	// Determine highest-precedence source for back-compat
	let source: SwarmConfigSource | null = null;
	const projFile = findSwarmYamlFile(cwd);
	const globalFile = findGlobalSwarmYaml();
	// If any project key is set, project wins for `source`
	const projectKeys = Object.values(resolved.sources).filter((s) => s.layer === "project.swarm.yml");
	if (projectKeys.length > 0 && projFile) {
		source = projFile.source;
	} else if (globalFile) {
		source = globalFile.source;
	}

	return {
		cfg: Object.keys(resolved.cfg).length > 0 ? resolved.cfg : null,
		source,
		sources: resolved.sources,
		corrupt: resolved.corrupt,
		globalInheritDisabled: resolved.globalInheritDisabled,
	};
}

// Quota-reset duration format (user request 2026-09-05): quotaResetMs is normally minutes or
// hours, and raw milliseconds are error-prone (a user writing 18000 meaning 18 minutes actually
// got 18 seconds). Accept a human duration string anywhere quotaResetMs is read:
//   "<n><unit>" segments, units ms | s | m | h | d (case-insensitive, combinable: "1h30m",
//   whitespace-separated: "2h 15m 30s"). Bare numbers (and bare numeric strings, for yml
//   ergonomics) stay milliseconds — back-compat. Returns the parsed non-negative integer ms,
// or undefined when unparseable.
export const QUOTA_DURATION_UNIT_MS: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };

export function parseQuotaResetMs(input: unknown): number | undefined {
	if (typeof input === "number") return Number.isFinite(input) && input >= 0 ? Math.floor(input) : undefined;
	if (typeof input !== "string") return undefined;
	const trimmed = input.trim();
	if (!trimmed) return undefined;
	if (/^\d+$/.test(trimmed)) return parseInt(trimmed, 10);
	let total = 0;
	let matched = false;
	let rest = trimmed;
	while (rest) {
		const ws = rest.match(/^\s+/);
		if (ws) {
			rest = rest.slice(ws[0].length);
			continue;
		}
		const m = rest.match(/^(\d+)\s*(ms|s|m|h|d)/i);
		if (!m) return undefined;
		const unitMs = QUOTA_DURATION_UNIT_MS[m[2].toLowerCase()];
		if (unitMs === undefined) return undefined;
		total += parseInt(m[1], 10) * unitMs;
		matched = true;
		rest = rest.slice(m[0].length);
	}
	return matched && total >= 0 ? total : undefined;
}

export function parseModelPool(raw: unknown): ModelSlot[] | undefined {
	if (!Array.isArray(raw) || !raw.length) return undefined;
	const slots: ModelSlot[] = [];
	for (const s of raw) {
		if (!s || typeof s !== "object") continue;
		const model = typeof (s as any).model === "string" ? (s as any).model.trim() : "";
		if (!model) continue;
		const weight = typeof (s as any).weight === "number" && Number.isFinite((s as any).weight) ? Math.max(0, (s as any).weight) : 1;
		const qrmRaw = (s as any).quotaReset !== undefined ? (s as any).quotaReset : (s as any).quotaResetMs;
		const qrm = qrmRaw === undefined ? undefined : parseQuotaResetMs(qrmRaw);
		slots.push({
			model,
			provider: typeof (s as any).provider === "string" && (s as any).provider.trim() ? (s as any).provider.trim() : undefined,
			weight,
			label: typeof (s as any).label === "string" ? (s as any).label.trim() || undefined : undefined,
			roles:
				Array.isArray((s as any).roles) && (s as any).roles.every((r: any) => typeof r === "string" && r.length > 0)
					? (s as any).roles.map((r: string) => r.trim()).filter(Boolean)
					: undefined,
			quotaResetMs: qrm,
		});
	}
	return slots.length ? slots : undefined;
}

export function parseRotationConfig(raw: unknown): RotationConfig | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const r = raw as Record<string, any>;
	const strategy = ["weighted", "round-robin", "sticky"].includes(r.strategy) ? (r.strategy as RotationStrategy) : undefined;
	const cooldownMs =
		typeof r.cooldownMs === "number" && Number.isFinite(r.cooldownMs) && r.cooldownMs >= 0 ? Math.floor(r.cooldownMs) : undefined;
	const maxRetries =
		typeof r.maxRetries === "number" && Number.isFinite(r.maxRetries) && r.maxRetries >= 1 ? Math.floor(r.maxRetries) : undefined;
	if (!strategy && cooldownMs === undefined && maxRetries === undefined) return undefined;
	return { strategy, cooldownMs, maxRetries };
}

export function readSwarmSettings(cwd = process.cwd()): SwarmSettings {
	const { cfg } = readSwarmRawConfig(cwd);
	if (!cfg || typeof cfg !== "object") return {};
	return {
		defaultModel: typeof cfg.defaultModel === "string" && cfg.defaultModel.trim() ? cfg.defaultModel.trim() : undefined,
		defaultProvider: typeof cfg.defaultProvider === "string" && cfg.defaultProvider.trim() ? cfg.defaultProvider.trim() : undefined,
		modelPool: parseModelPool(cfg.modelPool),
		rotation: parseRotationConfig(cfg.rotation),
		terminalManager: typeof cfg.terminalManager === "string" && cfg.terminalManager.trim() ? cfg.terminalManager.trim() : undefined,
	};
}
