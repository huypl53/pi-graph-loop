// === swarm/pool-scaffold.ts — Issue 20: scaffold swarm.modelPool placeholder on root session_start ===
//
// On the root's first `session_start`, if `.pi/settings.json` does not declare a `modelPool`
// under either `swarm` or `extensions.swarm` (runtime precedence: `extensions.swarm` is checked FIRST
// per `session.ts:readSwarmSettings`), write a placeholder slot `[{ "model": null, "provider": null }]`
// into the resolved swarm block while preserving every other top-level key. Emits a one-shot
// `ctx.ui.notify` and a `pool.scaffold_created` trace. Idempotent across sessions and `/reload`s via a
// durable `SwarmState.poolScaffoldNotifiedAt` flag (see hooks.ts). Three skip paths:
//
//   - modelpool_present       — `swarm.modelPool` (or `extensions.swarm.modelPool`) is already a key in
//                                the file (even `[]`). Idempotent no-op, no notify, no trace.
//   - no_pi_dir               — `.pi/` directory is absent. We must NOT silently `mkdir -p` to create a
//                                pi directory inside a non-pi project. Trace + early-return.
//   - settings_unparseable    — `.pi/settings.json` is corrupt JSON. Trace + leave file untouched.
//
// Reads via `readJsonSafe` (utils.ts) so missing-file and unparseable-file are distinguishable. Writes
// via `atomicWriteFile` (state.ts) — the file's parent directory is `.pi/` which is already required
// to exist (the no_pi_dir skip branch returns before any write), so the recursive mkdir inside
// atomicWriteFile is safe (it would never extend into a parent that did not exist).
import { existsSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import {
	POOL_SCAFFOLD_DOC_HINT,
	POOL_SCAFFOLD_NOTIFY_TEXT,
	POOL_SCAFFOLD_PLACEHOLDER,
	POOL_SCAFFOLD_YML_NOTIFY_TEXT,
	POOL_SCAFFOLD_YML_PLACEHOLDER,
} from "./constants.ts";
import { atomicWriteFile, paths as statePaths, trace } from "./state.ts";
import { readJsonSafe } from "./utils.ts";
import { readSwarmYml, swarmYmlPath } from "./config.ts";

// Result of one ensurePoolScaffold invocation. The discriminated union lets the caller pattern-match
// without inspecting booleans. `notify` is only present on the `wrote:true` branch — the caller emits
// it ONLY when (a) `wrote:true` AND (b) the durable `poolScaffoldNotifiedAt` flag is absent.
export type ScaffoldResult =
	| { wrote: true; path: string; previousKeys: string[]; notify: string }
	| { wrote: false; skipped: "modelpool_present"; path: string }
	| { wrote: false; skipped: "no_pi_dir"; path: string }
	| { wrote: false; skipped: "settings_unparseable"; path: string; error: string };

// settingsPath is exposed for tests + docs. The constant is computed off `cwd` so the public
// signature stays simple; tests call this directly to assert the resolved path.
export function poolScaffoldSettingsPath(cwd: string): string {
	return join(cwd, CONFIG_DIR_NAME, "settings.json");
}

// The YAML home for the scaffold (swarm.yml feature). Exposed for tests + docs.
export function poolScaffoldYmlPath(cwd: string): string {
	return swarmYmlPath(cwd);
}

// Inspect the raw `.pi/settings.json` object and decide where to write the placeholder. RUNTIME
// PRECEDENCE (per session.ts:readSwarmSettings + pool.ts:validateSwarmSettings): `extensions.swarm`
// wins over top-level `swarm` when both exist as objects. Per binding B1, we check
// `extensions.swarm.modelPool` BEFORE `swarm.modelPool` when deciding whether to skip. Returns:
//   - destination: which block to merge the placeholder into. extensions.swarm wins when it exists as
//     an object (consistent with runtime precedence); top-level swarm is the fallback; absent writes
//     a fresh top-level `swarm.modelPool`.
//   - skip: the resolved destination already declares modelPool — caller should no-op.
function resolveScaffoldPlan(raw: any): {
	source: "extensions.swarm" | "swarm" | "absent";
	skip: boolean;
	destinationBlock: Record<string, any>;
	previousKeys: string[];
} {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		return { source: "absent", skip: false, destinationBlock: {}, previousKeys: [] };
	}
	const fromExt = raw?.extensions?.swarm;
	const fromTop = raw?.swarm;
	const extIsObject = fromExt && typeof fromExt === "object" && !Array.isArray(fromExt);
	const topIsObject = fromTop && typeof fromTop === "object" && !Array.isArray(fromTop);
	const extHasPool = extIsObject && Object.prototype.hasOwnProperty.call(fromExt, "modelPool");
	const topHasPool = topIsObject && Object.prototype.hasOwnProperty.call(fromTop, "modelPool");
	if (extHasPool || topHasPool) {
		// Per binding B1: if EITHER block declares modelPool, skip. The runtime precedence resolves
		// `extensions.swarm` first (mirrors session.ts), but for the scaffold's purpose either
		// declaration counts as "the user already configured pool rotation".
		const dest = extIsObject ? fromExt : (topIsObject ? fromTop : {});
		return { source: extIsObject ? "extensions.swarm" : "swarm", skip: true, destinationBlock: dest, previousKeys: Object.keys(dest) };
	}
	if (extIsObject) {
		return { source: "extensions.swarm", skip: false, destinationBlock: fromExt, previousKeys: Object.keys(fromExt) };
	}
	if (topIsObject) {
		return { source: "swarm", skip: false, destinationBlock: fromTop, previousKeys: Object.keys(fromTop) };
	}
	return { source: "absent", skip: false, destinationBlock: {}, previousKeys: [] };
}

// PUBLIC: ensure `.pi/settings.json` has a `modelPool` placeholder. Idempotent across sessions and
// reloads via the durable `SwarmState.poolScaffoldNotifiedAt` flag (gated by the hook, NOT here:
// `ensurePoolScaffold` always reflects file truth; the caller decides whether to notify).
//
// `opts.alreadyNotified` is reserved for future symmetry with the durable flag (e.g. a test can short-
// circuit the flag-check). Currently unused — the durable flag is read by the hook from SwarmState.
export async function ensurePoolScaffold(
	cwd: string,
	opts: { alreadyNotified?: boolean } = {},
): Promise<ScaffoldResult> {
	const p = statePaths(cwd);
	const settingsPath = poolScaffoldSettingsPath(cwd);
	const piDir = join(cwd, CONFIG_DIR_NAME);

	// Skip path: no `.pi/` directory. We deliberately do NOT mkdir it (the root's first
	// session_start in a non-pi project must not silently create one). Also deliberately do NOT emit a
	// trace event here — `trace()` would mkdir the entire `.pi/swarm/...` chain via appendJsonl, which
	// is the exact side-effect we are trying to avoid.
	if (!existsSync(piDir)) {
		return { wrote: false, skipped: "no_pi_dir", path: settingsPath };
	}

	// Read raw settings.json. Missing file = {} (fresh scaffold). Corrupt JSON = hard skip.
	let raw: any;
	try {
		raw = await readJsonSafe(settingsPath);
	} catch (err: any) {
		const message = String(err?.message || err);
		await trace(p, "pool.scaffold_skipped_unparseable", { path: settingsPath, error: message }).catch(() => {});
		return { wrote: false, skipped: "settings_unparseable", path: settingsPath, error: message };
	}
	if (raw === undefined) raw = {};

	// swarm.yml check: decide whether the yml declares a pool. An EMPTY yml (0 bytes /
	// comments-only, parses to null) is NOT a user declaration — it is a fresh-scaffold
	// opportunity (follow-up F1b): if no other source declares modelPool we fill the commented
	// placeholder INTO the yml. Only a yml that parses AND has a modelPool key (or a corrupt one
	// we refuse to clobber) counts as modelpool_present.
	const ymlPath = swarmYmlPath(cwd);
	if (existsSync(ymlPath)) {
		let yml: any = null;
		let ymlCorrupt = false;
		try { yml = readSwarmYml(cwd); } catch { ymlCorrupt = true; }
		if (ymlCorrupt) {
			await trace(p, "pool.scaffold_skipped_yml_unparseable", { path: ymlPath }).catch(() => {});
			return { wrote: false, skipped: "modelpool_present", path: ymlPath };
		}
		if (yml && Object.prototype.hasOwnProperty.call(yml, "modelPool")) {
			return { wrote: false, skipped: "modelpool_present", path: ymlPath };
		}
		// yml === null (empty/comments-only): fall through to the JSON plan; if the JSON side also
		// declares nothing, the absent-branch below writes the placeholder into THIS yml file.
	}

	// Resolve the scaffold plan: which block to write into, whether to skip, and the existing keys.
	const plan = resolveScaffoldPlan(raw);
	if (plan.skip) {
		return { wrote: false, skipped: "modelpool_present", path: settingsPath };
	}

	const nextSwarmBlock = { ...plan.destinationBlock, modelPool: POOL_SCAFFOLD_PLACEHOLDER };
	let nextRaw: any;
	if (plan.source === "extensions.swarm") {
		// Preserve `raw.extensions` shape (could have other sub-keys); only `extensions.swarm` is mutated.
		nextRaw = {
			...raw,
			extensions: { ...(raw.extensions || {}), swarm: nextSwarmBlock },
		};
	} else if (plan.source === "swarm") {
		nextRaw = { ...raw, swarm: nextSwarmBlock };
	} else {
		// source === "absent": neither JSON block exists. Scaffold `.pi/swarm.yml` — the comment-friendly
		// dedicated home (swarm.yml feature; user decision 2026-09-04). settings.json is left untouched.
		await atomicWriteFile(ymlPath, POOL_SCAFFOLD_YML_PLACEHOLDER);
		await trace(p, "pool.scaffold_created", { path: ymlPath, previousKeys: [], source: "swarm.yml", modelPool: POOL_SCAFFOLD_PLACEHOLDER }).catch(() => {});
		return { wrote: true, path: ymlPath, previousKeys: [], notify: POOL_SCAFFOLD_YML_NOTIFY_TEXT };
	}

	await atomicWriteFile(settingsPath, `${JSON.stringify(nextRaw, null, 2)}\n`);
	await trace(p, "pool.scaffold_created", { path: settingsPath, previousKeys: plan.previousKeys, source: plan.source, modelPool: nextSwarmBlock.modelPool }).catch(() => {});
	return { wrote: true, path: settingsPath, previousKeys: plan.previousKeys, notify: POOL_SCAFFOLD_NOTIFY_TEXT };
}
