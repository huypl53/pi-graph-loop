// === swarm/config.ts — raw swarm config resolution across settings.json + swarm.yml ===
//
// Single source of truth for reading the RAW swarm config block (the object that carries
// modelPool / rotation / defaultModel / defaultProvider) before session.ts's parsers
// normalize it. Two file sources, strict precedence:
//
//   1. `.pi/settings.json` → `extensions.swarm` block   (highest — runtime parity with pi core)
//   2. `.pi/settings.json` → top-level `swarm` block
//   3. `.pi/swarm.yml`     → top-level keys, no `swarm:` wrapper (the filename is the namespace)
//
// swarm.yml exists because pi core parses settings.json with bare JSON.parse (no comments,
// no JSONC, no YAML — settings-manager.js), and a comment there would make pi silently drop
// the whole project settings block. swarm.yml is swarm-owned: comments allowed anywhere.
// docs/swarm-task-graph.md sanctioned YAML with an explicit dependency (yaml@2.9.0 in
// package.json — not transitive reliance on pi's own dep tree).
//
// Error contract mirrors the JSON readers: callers decide how loud to be.
//   - readSwarmRawConfig: missing files → { cfg: null, source: null }; corrupt settings.json
//     or corrupt swarm.yml → the corrupt piece is skipped (its source resolves to null) but a
//     `corrupt: ["settings.json"|"swarm.yml"]` list tells validateSwarmSettings what happened.
//   - readSwarmYml: returns null when absent, THROWS on corrupt YAML (so /swarm pool validate
//     can surface swarm_yml_unreadable while runtime readers degrade silently to {}).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { parse as parseYaml } from "yaml";
import { logSwarmError } from "./errorlog.ts";
import type { ModelSlot, RotationConfig, RotationStrategy, SwarmSettings } from "./types/index.ts";

export type SwarmConfigSource = "extensions.swarm" | "swarm" | "swarm.yml" | "swarm.yaml";

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

// Read + parse `.pi/swarm.yaml` or `.pi/swarm.yml`. null when absent; THROWS on unparseable YAML.
export function readSwarmYml(cwd: string): Record<string, any> | null {
	const found = findSwarmYamlFile(cwd);
	if (!found) return null;
	const doc = parseYaml(readFileSync(found.file, "utf8"));
	if (!doc || typeof doc !== "object" || Array.isArray(doc)) return null;
	return doc as Record<string, any>;
}

// Resolve the winning raw config. Precedence: extensions.swarm > swarm > swarm.yaml / swarm.yml.
// Never throws; corrupt sources are reported via `corrupt` for the validate path.
export function readSwarmRawConfig(cwd: string): {
	cfg: Record<string, any> | null;
	source: SwarmConfigSource | null;
	corrupt: Array<"settings.json" | "swarm.yml">;
} {
	const corrupt: Array<"settings.json" | "swarm.yml"> = [];

	// --- settings.json blocks ---
	let raw: Record<string, any> | null = null;
	const settingsFile = join(cwd, CONFIG_DIR_NAME, "settings.json");
	if (existsSync(settingsFile)) {
		try {
			raw = JSON.parse(readFileSync(settingsFile, "utf8")) as Record<string, any>;
		} catch (err) {
			corrupt.push("settings.json");
			raw = null;
			// Corrupt config is REPORTED to callers (validate path) — but the raw-read path also
			// silently falls back to defaults. Leave one durable line per discovery.
			void logSwarmError(cwd, "config", "settings.parse_failed", err, { file: settingsFile });
		}
	}
	if (raw) {
		const fromExt = raw?.extensions?.swarm;
		if (fromExt && typeof fromExt === "object") return { cfg: fromExt, source: "extensions.swarm", corrupt };
		const fromTop = raw?.swarm;
		if (fromTop && typeof fromTop === "object") return { cfg: fromTop, source: "swarm", corrupt };
		// A parseable settings.json WITHOUT a swarm block does NOT win over swarm.yml —
		// yml is the dedicated swarm home; a settings.json that never mentions swarm
		// must not silently mask it. Fall through to the yml read below.
	}

	// --- swarm.yaml / swarm.yml (throws → treat as corrupt, reported not raised) ---
	let yml: Record<string, any> | null = null;
	const foundYaml = findSwarmYamlFile(cwd);
	const ymlSource = foundYaml?.source || "swarm.yml";
	try {
		yml = readSwarmYml(cwd);
	} catch (err) {
		corrupt.push("swarm.yml");
		yml = null;
		void logSwarmError(cwd, "config", "swarm_yml.parse_failed", err);
	}
	if (yml && Object.keys(yml).length) return { cfg: yml, source: ymlSource, corrupt };

	return { cfg: null, source: null, corrupt };
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
	// Bare numeric string: milliseconds (parity with the number form).
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
		if (!m) return undefined; // unparseable remainder -> reject the whole input
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
		// Quota-reset duration format (2026-09-05): quotaReset (canonical) / quotaResetMs
		// (legacy alias) may be a duration string ("30m", "2h", "1h30m") or a bare number
		// (ms). quotaReset wins when both are set. Parse to ms here so every downstream
		// consumer (pickSlot quotas, poolStatus display, effectiveBenchMs) sees a number.
		// Malformed values are dropped (undefined) — validateSwarmSettings reports them.
		const qrmRaw = (s as any).quotaReset !== undefined ? (s as any).quotaReset : (s as any).quotaResetMs;
		const qrm = qrmRaw === undefined ? undefined : parseQuotaResetMs(qrmRaw);
		slots.push({
			model,
			provider: typeof (s as any).provider === "string" && (s as any).provider.trim() ? (s as any).provider.trim() : undefined,
			weight,
			label: typeof (s as any).label === "string" ? (s as any).label.trim() || undefined : undefined,
			// Issue 22 roles-filter: forward the optional per-slot roleKind allow-list. Absent / empty
			// preserved verbatim so slotMatchesRole can detect "no filter set". Malformed shapes become
			// undefined (no filter applied); validateSwarmSettings reports slot_bad_roles for visibility.
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
