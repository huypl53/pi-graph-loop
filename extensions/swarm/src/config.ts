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

export type SwarmConfigSource = "extensions.swarm" | "swarm" | "swarm.yml";

export function swarmYmlPath(cwd: string): string {
	return join(cwd, CONFIG_DIR_NAME, "swarm.yml");
}

// Read + parse `.pi/swarm.yml`. null when absent; THROWS on unparseable YAML.
export function readSwarmYml(cwd: string): Record<string, any> | null {
	const file = swarmYmlPath(cwd);
	if (!existsSync(file)) return null;
	const doc = parseYaml(readFileSync(file, "utf8"));
	if (!doc || typeof doc !== "object" || Array.isArray(doc)) return null;
	return doc as Record<string, any>;
}

// Resolve the winning raw config. Precedence: extensions.swarm > swarm > swarm.yml.
// Never throws; corrupt sources are reported via `corrupt` for the validate path.
export function readSwarmRawConfig(cwd: string): { cfg: Record<string, any> | null; source: SwarmConfigSource | null; corrupt: Array<"settings.json" | "swarm.yml"> } {
	const corrupt: Array<"settings.json" | "swarm.yml"> = [];

	// --- settings.json blocks ---
	let raw: Record<string, any> | null = null;
	const settingsFile = join(cwd, CONFIG_DIR_NAME, "settings.json");
	if (existsSync(settingsFile)) {
		try {
			raw = JSON.parse(readFileSync(settingsFile, "utf8")) as Record<string, any>;
		} catch {
			corrupt.push("settings.json");
			raw = null;
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

	// --- swarm.yml (throws → treat as corrupt, reported not raised) ---
	let yml: Record<string, any> | null = null;
	try {
		yml = readSwarmYml(cwd);
	} catch {
		corrupt.push("swarm.yml");
		yml = null;
	}
	if (yml && Object.keys(yml).length) return { cfg: yml, source: "swarm.yml", corrupt };

	return { cfg: null, source: null, corrupt };
}
