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
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { parse as parseYaml } from "yaml";
import { logSwarmError } from "./errorlog.ts";
import { ROLE_CHARTER_DEFAULT, ROLE_PLAYBOOK_KINDS } from "./constants.ts";
import type { ModelSlot, RotationConfig, RotationStrategy, SwarmSettings } from "./types/index.ts";

export type SwarmConfigSource = "swarm.yml" | "swarm.yaml" | "global-swarm.yml" | "global-swarm.yaml";

// Needs "fileURLToPath" for bundledRolePlaybookPath (see bottom of file).

export type ConfigKey = "modelPool" | "rotation" | "defaultModel" | "defaultProvider" | "terminalManager" | "inheritGlobal" | "roles" | "agentGc";

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

const RECOGNIZED_KEYS: ConfigKey[] = ["modelPool", "rotation", "defaultModel", "defaultProvider", "terminalManager", "inheritGlobal", "roles", "agentGc"];

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
	// D4/D3/D2 (plan 2026-10-14): new rotation sub-keys. Only forwarded when present in the raw
	// config so defaults stay owned by effectiveConfig(); malformed values are rejected later by
	// validateSwarmSettings (which sees the RAW rotation object, not this parsed one).
	const benchMaxMs =
		typeof r.benchMaxMs === "number" && Number.isFinite(r.benchMaxMs) && r.benchMaxMs > 0 ? Math.floor(r.benchMaxMs) : r.benchMaxMs;
	const benchStreakDecayMs =
		typeof r.benchStreakDecayMs === "number" && Number.isFinite(r.benchStreakDecayMs) && r.benchStreakDecayMs >= 0
			? Math.floor(r.benchStreakDecayMs)
			: r.benchStreakDecayMs;
	const roleFallbackOnSwap = typeof r.roleFallbackOnSwap === "boolean" ? r.roleFallbackOnSwap : undefined;
	if (
		!strategy &&
		cooldownMs === undefined &&
		maxRetries === undefined &&
		benchMaxMs === undefined &&
		benchStreakDecayMs === undefined &&
		roleFallbackOnSwap === undefined
	)
		return undefined;
	return { strategy, cooldownMs, maxRetries, benchMaxMs, benchStreakDecayMs, roleFallbackOnSwap };
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

// ============================================================================
// === roles: config (task-role-playbooks) ====================================
// ============================================================================

// One role's resolved playbook configuration. `path` is the resolved (usually
// absolute) path from the yml config; `null` would mean "unset", but as of
// this implementation every kind always resolves to SOME path (custom or
// bundled default) so that spawn-time injection never silently degrades to
// "no playbook". Existence checks happen in validateRolesConfig (preflight
// error surface), NOT here — resolution is a pure path-map.
export type RolePlaybookConfig = {
	kind: string;
	path: string;
	source: SourceLayer;
	file?: string;
	// F1 (task-redteam-fixnow): true when the custom path's realpath resolves OUTSIDE the
	// project root (join/../, absolute-outside, or symlink escape). Mirrors the
	// resolveEvidencePath containment discipline (state.ts:378-383). validateRolesConfig
	// reports it (roles_playbook_outside_project) and resolveRolePlaybook refuses it (null).
	outsideProject?: boolean;
};

export type RolesConfig = {
	// Keys: planner, implementer, fixer, tester, reviewer
	roles: Record<string, RolePlaybookConfig>;
	// Path to the project-charter override; null = use ROLE_CHARTER_DEFAULT
	charter: { path: string | null; outsideProject?: boolean };
	// Whole-key provenance for the `roles:` object (informational)
	source: SourceInfo | null;
};

// Path to the bundled playbook skill directory for a role kind. Anchored to
// this module's location, NOT cwd, so a spawned worker receives a valid
// absolute path regardless of where pi was launched from (same discipline as
// session.ts defaultSwarmExtensionPath).
export function bundledRolePlaybookPath(kind: string): string {
	return fileURLToPath(new URL(`../role-skills/${kind}/`, import.meta.url));
}

// Memoized refusals for F1 containment — one durable logSwarmError per escaping path per
// process (readCharterText/resolveRolePlaybook run on every spawn/preflight; the escape is
// durable in errors.jsonl once, not once per call).
const containmentRefusalMemo = new Map<string, true>();

// F1 (task-redteam-fixnow): sync mirror of resolveEvidencePath's realpath containment
// (state.ts:378-383). A path is contained iff its realpath equals the project root's
// realpath or sits under it (verbatim prefix discipline: target === base ||
// target.startsWith(base + sep)).
// Error mapping (fail-closed except where nothing can load):
//   - ENOENT/ENOTDIR on the TARGET -> contained (nothing can load; the existing
//     roles_*_missing validations report it — keeps not-yet-created inside paths honest).
//   - Any other realpath error (EACCES...) -> NOT contained (fail closed).
export function containedInProjectSync(cwd: string, abs: string): boolean {
	let base: string;
	try {
		base = realpathSync(cwd);
	} catch {
		return false; // cannot anchor the project root -> fail closed
	}
	let target: string;
	try {
		target = realpathSync(abs);
	} catch (err: any) {
		if (err?.code === "ENOENT" || err?.code === "ENOTDIR") return true;
		return false;
	}
	return target === base || target.startsWith(`${base}${sep}`);
}

// Resolve a candidate playbook VALUE from yml into a RolePlaybookConfig.
// Accepted shapes: "default" (sentinel → bundled), null/undefined (→ bundled),
// or a string path (absolute, or relative to the project root `cwd`).
// The path may point at a DIRECTORY containing SKILL.md or a direct .md
// file — both are legal at the pi `--skill <path>` boundary.
export function resolveRolePlaybookPath(
	kind: string,
	value: unknown,
	cwd: string,
	source: SourceLayer,
	file?: string,
): RolePlaybookConfig {
	if (value === undefined || value === null) {
		return { kind, path: bundledRolePlaybookPath(kind), source };
	}
	if (typeof value !== "string") {
		return { kind, path: bundledRolePlaybookPath(kind), source };
	}
	const trimmed = value.trim();
	if (!trimmed || trimmed.toLowerCase() === "default") {
		return { kind, path: bundledRolePlaybookPath(kind), source };
	}
	const abs = trimmed.startsWith("/") ? trimmed : join(cwd, trimmed);
	// F1 containment: ONLY custom values are checked here — the bundled role-skills/ path
	// legitimately sits outside arbitrary project cwds and must never be flagged.
	const outsideProject = !containedInProjectSync(cwd, abs);
	return { kind, path: abs, source, file, outsideProject };
}

// Read and resolve the top-level `roles:` config key across both layers
// (global + project) with PER-SUB-KEY precedence: project > global > bundled
// default. This differs from `modelPool` (whole-array replacement): a project
// declaring only `roles.tester` preserves global `roles.planner` etc.
export function readRolesConfig(cwd: string, opts: { freshGlobal?: boolean } = {}): RolesConfig {
	const merged = mergeSwarmConfig(cwd, opts);

	// Re-read both layers individually for per-sub-key merge (mergeSwarmConfig
	// applied whole-OBJECT replacement for the roles key: the project object
	// fully replaced the global one in `merged.cfg`).
	let projRolesObj: Record<string, unknown> | null = null;
	let globalRolesObj: Record<string, unknown> | null = null;
	try {
		const projYml = readSwarmYml(cwd);
		projRolesObj =
			projYml?.roles && typeof projYml.roles === "object" && !Array.isArray(projYml.roles)
				? (projYml.roles as Record<string, unknown>)
				: null;
	} catch {
		projRolesObj = null; // corrupt project yml: corrupt[] already reports it
	}
	try {
		const globalYml = readGlobalSwarmYml(opts.freshGlobal === true);
		globalRolesObj =
			globalYml?.roles && typeof globalYml.roles === "object" && !Array.isArray(globalYml.roles)
				? (globalYml.roles as Record<string, unknown>)
				: null;
	} catch {
		globalRolesObj = null; // corrupt global yml: corrupt[] already reports it
	}

	// Resolve each playbook kind: project > global > bundled default.
	const roles: Record<string, RolePlaybookConfig> = {};
	for (const kind of ROLE_PLAYBOOK_KINDS) {
		const projVal = projRolesObj?.[kind];
		const globalVal = globalRolesObj?.[kind];
		if (projVal !== undefined && projVal !== null) {
			roles[kind] = resolveRolePlaybookPath(kind, projVal, cwd, "project.swarm.yml");
		} else if (globalVal !== undefined && globalVal !== null) {
			roles[kind] = resolveRolePlaybookPath(kind, globalVal, cwd, "global");
		} else {
			roles[kind] = { kind, path: bundledRolePlaybookPath(kind), source: "default" };
		}
	}

	// charter: project > global; resolve to abs path; null → embedded default.
	// F1 containment: flag escaping charter paths (outsideProject) so validateRolesConfig
	// reports them and readCharterText refuses the load (mirrors resolveEvidencePath).
	let charter: RolesConfig["charter"] = { path: null };
	const projCharter = projRolesObj?.charter;
	const globalCharter = globalRolesObj?.charter;
	if (typeof projCharter === "string" && projCharter.trim()) {
		const t = projCharter.trim();
		const path = t.startsWith("/") ? t : join(cwd, t);
		charter = { path, outsideProject: !containedInProjectSync(cwd, path) };
	} else if (typeof globalCharter === "string" && globalCharter.trim()) {
		const t = globalCharter.trim();
		const path = t.startsWith("/") ? t : join(cwd, t);
		charter = { path, outsideProject: !containedInProjectSync(cwd, path) };
	}

	return { roles, charter, source: merged.sources.roles ?? null };
}

// Structural error shape for roles config validation (mirrors PoolValidationError).
export type RoleConfigError = { kind: string; field?: string; message: string; source?: string };

// Validate the roles config: custom paths must exist and be shaped correctly
// (directory containing SKILL.md, or a direct .md file). Bundled defaults are
// package-shipped and always valid. Returns an array of errors (empty = valid).
// Callers surface these through the preflight error surface (preflightSpawn /
// /swarm pool validate) — invalid paths NEVER silently fall back to bundled.
export function validateRolesConfig(cwd: string, opts: { freshGlobal?: boolean } = {}): RoleConfigError[] {
	const errors: RoleConfigError[] = [];
	const rc = readRolesConfig(cwd, opts);

	// Charter: when a path is configured, it must exist, be a readable file, AND resolve
	// inside the project root (F1 containment). Escapes are reported as
	// roles_charter_outside_project and the normal existence check is skipped for them
	// (the escape itself is the error; missing-vs-present inside an attacker dir is noise).
	if (rc.charter.path) {
		if (rc.charter.outsideProject) {
			errors.push({
				kind: "roles_charter_outside_project",
				field: "roles.charter",
				message: `roles.charter resolves outside the project root (realpath containment, mirrors resolveEvidencePath): ${rc.charter.path}`,
			});
		} else if (!existsSync(rc.charter.path)) {
			errors.push({
				kind: "roles_charter_missing",
				field: "roles.charter",
				message: `roles.charter points at a missing file: ${rc.charter.path}`,
			});
		}
	}

	// Role playbooks: each resolved CUSTOM path must exist. Directories must
	// contain a SKILL.md; loose files must end in .md. F1 containment first: an
	// escaping path is reported as roles_playbook_outside_project and the normal
	// existence/shape checks are skipped for it (same rationale as charter above).
	for (const [kind, conf] of Object.entries(rc.roles)) {
		if (!conf.path) continue;
		if (conf.source === "default") continue; // bundled, cannot miss
		if (conf.outsideProject) {
			errors.push({
				kind: "roles_playbook_outside_project",
				field: `roles.${kind}`,
				message: `roles.${kind} resolves outside the project root (realpath containment, mirrors resolveEvidencePath): ${conf.path}`,
				source: conf.source,
			});
			continue;
		}
		let st: import("node:fs").Stats | null = null;
		try {
			st = statSync(conf.path);
		} catch {
			st = null;
		}
		if (!st) {
			errors.push({
				kind: "roles_playbook_missing",
				field: `roles.${kind}`,
				message: `roles.${kind} points at a missing path: ${conf.path}`,
				source: conf.source,
			});
			continue;
		}
		if (st.isDirectory()) {
			if (!existsSync(join(conf.path, "SKILL.md"))) {
				errors.push({
					kind: "roles_playbook_no_skill_md",
					field: `roles.${kind}`,
					message: `roles.${kind} directory has no SKILL.md: ${conf.path}`,
					source: conf.source,
				});
			}
		} else if (!conf.path.endsWith(".md")) {
			errors.push({
				kind: "roles_playbook_not_skill",
				field: `roles.${kind}`,
				message: `roles.${kind} must be a directory containing SKILL.md or a direct .md file; got: ${conf.path}`,
				source: conf.source,
			});
		}
	}

	return errors;
}

// Read the charter text. Priority: custom path (when configured + readable) →
// ROLE_CHARTER_DEFAULT. A custom path that fails to read at this layer logs
// durably (logSwarmError) and falls back to the default; validateRolesConfig
// already reported the miss as a preflight error. F1 containment: a charter
// that resolves OUTSIDE the project root is NEVER loaded — the refusal is durable
// (logSwarmError, memoized per path per process) and the default is returned.
export function readCharterText(cwd: string, opts: { freshGlobal?: boolean } = {}): string {
	const rc = readRolesConfig(cwd, opts);
	if (rc.charter.path) {
		if (rc.charter.outsideProject) {
			if (!containmentRefusalMemo.has(`charter:${rc.charter.path}`)) {
				containmentRefusalMemo.set(`charter:${rc.charter.path}`, true);
				void logSwarmError(cwd, "config", "roles_charter_outside_project_refused", new Error("charter path resolves outside the project root; load refused"), {
					charterPath: rc.charter.path,
				});
			}
			return ROLE_CHARTER_DEFAULT;
		}
		try {
			return readFileSync(rc.charter.path, "utf8");
		} catch (err: any) {
			logSwarmError(cwd, "config", "roles_charter_read_failed", err, { charterPath: rc.charter.path });
			return ROLE_CHARTER_DEFAULT;
		}
	}
	return ROLE_CHARTER_DEFAULT;
}

// Resolve the playbook path for a role kind at call time.
//
// Fix-node remap: when `opts.nodeId` is "fix", or the role TEXT strongly
// indicates a fixer (starts with "fix"), an implementer-kind resolves the
// FIXER playbook instead of the generic implementer playbook. This is a
// PLAYBOOK-LAYER remap only — the graph keeps role "implementer" on the fix
// node so model-pool routing is unchanged.
export function resolveRolePlaybook(
	roleKind: string,
	opts: { nodeId?: string; role?: string; cwd?: string; freshGlobal?: boolean } = {},
	cwdArg?: string,
): string | null {
	const cwd = typeof cwdArg === "string" ? cwdArg : opts.cwd || process.cwd();

	let kind: string = roleKind;
	if (roleKind === "implementer") {
		const nodeId = (opts.nodeId || "").toLowerCase();
		const roleStr = (opts.role || "").trim().toLowerCase();
		if (nodeId === "fix" || /^fix(er)?$/.test(roleStr) || roleStr.startsWith("fix ")) {
			kind = "fixer";
		}
	}

	if (!(ROLE_PLAYBOOK_KINDS as readonly string[]).includes(kind)) return null;
	const rc = readRolesConfig(cwd, { freshGlobal: opts?.freshGlobal });
	const conf = rc.roles[kind];
	// F1 containment: an escaping playbook is NEVER returned — spawn would hand it to
	// --skill and identity would embed it. Refusal is durable (logSwarmError, memoized per
	// path per process) and the caller (agents.ts --skill guard, identity.ts playbook
	// section) proceeds as if no playbook were configured.
	if (conf?.outsideProject) {
		if (!containmentRefusalMemo.has(`playbook:${conf.path}`)) {
			containmentRefusalMemo.set(`playbook:${conf.path}`, true);
			void logSwarmError(cwd, "config", "roles_playbook_outside_project_refused", new Error("playbook path resolves outside the project root; resolve refused"), {
				kind,
				playbookPath: conf.path,
			});
		}
		return null;
	}
	return conf?.path ?? null;
}
