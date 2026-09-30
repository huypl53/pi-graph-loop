// === swarm/pool-scaffold.ts — Issue 20 + v4.2: scaffold swarm config placeholders ===
//
// v4.2: YAML-only. Two scaffolds:
//   1. ensurePoolScaffold(cwd) — writes POOL_SCAFFOLD_YML_PLACEHOLDER to .pi/swarm.yml
//      when neither global yml nor project yml declares a modelPool.
//   2. ensureGlobalPoolScaffold() — writes POOL_SCAFFOLD_GLOBAL_YML_PLACEHOLDER to
//      ~/.pi/agent/swarm.yml on first registration. Never overwrites corrupt global.
//
// Both scaffolds are one-shot via durable flags in SwarmState:
//   - poolScaffoldNotifiedAt (project)
//   - poolScaffoldGlobalNotifiedAt (global)
//
// Skip paths:
//   - modelpool_present       — yml already declares modelPool (either layer)
//   - no_pi_dir               — .pi/ directory absent (project scaffold only)
//   - corrupt                 — yml is unreadable (validate path reports the corrupt kind)
//
// Reads via readSwarmYml / readGlobalSwarmYml. Writes via atomicWriteFile.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import {
	POOL_SCAFFOLD_GLOBAL_YML_NOTIFY_TEXT,
	POOL_SCAFFOLD_GLOBAL_YML_PLACEHOLDER,
	POOL_SCAFFOLD_YML_NOTIFY_TEXT,
	POOL_SCAFFOLD_YML_PLACEHOLDER,
} from "./constants.ts";
import { atomicWriteFile, ensureDirs, paths as statePaths, readState, trace, withLock, writeState } from "./state.ts";
import { expected, logSwarmError, traceLogged } from "./errorlog.ts";
import { now } from "./utils.ts";
import { validateSwarmSettings } from "./pool.ts";
import type { Paths } from "./types.ts";
import {
	findGlobalSwarmYaml,
	GLOBAL_AGENT_DIR,
	GLOBAL_SWARM_YML_PRIMARY,
	getGlobalSwarmYmlPrimary,
	mergeSwarmConfig,
	readGlobalSwarmYml,
	readSwarmYml,
	swarmYmlPath,
} from "./config.ts";

// Result of one ensurePoolScaffold invocation. The discriminated union lets the caller pattern-match
// without inspecting booleans. `notify` is only present on the `wrote:true` branch.
export type ScaffoldResult =
	| { wrote: true; path: string; previousKeys: string[]; notify: string }
	| { wrote: false; skipped: "modelpool_present"; path: string }
	| { wrote: false; skipped: "no_pi_dir"; path: string }
	| { wrote: false; skipped: "corrupt"; path: string; error: string };

// Result of one ensureGlobalPoolScaffold invocation.
export type GlobalScaffoldResult =
	| { wrote: true; path: string; notify: string }
	| { wrote: false; skipped: "modelpool_present"; path: string }
	| { wrote: false; skipped: "corrupt"; path: string; error: string }
	| { wrote: false; skipped: "exists"; path: string };

// The YAML home for the scaffold (swarm.yml feature). Exposed for tests + docs.
export function poolScaffoldYmlPath(cwd: string): string {
	return swarmYmlPath(cwd);
}

// PUBLIC: ensure `.pi/swarm.yml` has a modelPool placeholder. Idempotent across sessions and
// reloads via the durable `SwarmState.poolScaffoldNotifiedAt` flag (gated by the hook, NOT here:
// `ensurePoolScaffold` always reflects file truth; the caller decides whether to notify).
export async function ensurePoolScaffold(cwd: string, opts: { alreadyNotified?: boolean } = {}): Promise<ScaffoldResult> {
	const p = statePaths(cwd);
	const ymlPath = swarmYmlPath(cwd);
	const piDir = join(cwd, CONFIG_DIR_NAME);

	// Skip path: no `.pi/` directory. We deliberately do NOT mkdir it.
	if (!existsSync(piDir)) {
		return { wrote: false, skipped: "no_pi_dir", path: ymlPath };
	}

	// Check project yml: if it declares modelPool, skip.
	let projYml: any = null;
	let projCorrupt = false;
	try {
		projYml = readSwarmYml(cwd);
	} catch (err) {
		await logSwarmError(p, "pool-scaffold", "scaffold_yml.parse_failed", err);
		projCorrupt = true;
	}
	if (projCorrupt) {
		await trace(p, "pool.scaffold_skipped_yml_unparseable", { path: ymlPath }).catch(() => {});
		return { wrote: false, skipped: "corrupt", path: ymlPath, error: "project yml corrupt" };
	}
	if (projYml && Object.prototype.hasOwnProperty.call(projYml, "modelPool")) {
		return { wrote: false, skipped: "modelpool_present", path: ymlPath };
	}

	// Check global yml: if it declares modelPool, skip (global covers it).
	let globalYml: any = null;
	let globalCorrupt = false;
	try {
		globalYml = readGlobalSwarmYml(true);
	} catch (err) {
		await logSwarmError(p, "pool-scaffold", "scaffold_global.parse_failed", err);
		globalCorrupt = true;
	}
	if (globalCorrupt) {
		await trace(p, "pool.scaffold_skipped_global_unparseable", { path: GLOBAL_SWARM_YML_PRIMARY }).catch(() => {});
		return { wrote: false, skipped: "corrupt", path: GLOBAL_SWARM_YML_PRIMARY, error: "global yml corrupt" };
	}
	if (globalYml && Object.prototype.hasOwnProperty.call(globalYml, "modelPool")) {
		return { wrote: false, skipped: "modelpool_present", path: GLOBAL_SWARM_YML_PRIMARY };
	}

	// Neither layer declares a pool — write the scaffold to project yml.
	await atomicWriteFile(ymlPath, POOL_SCAFFOLD_YML_PLACEHOLDER);
	await trace(p, "pool.scaffold_created", {
		path: ymlPath,
		previousKeys: [],
		source: "swarm.yml",
	}).catch(() => {});
	return { wrote: true, path: ymlPath, previousKeys: [], notify: POOL_SCAFFOLD_YML_NOTIFY_TEXT };
}

// PUBLIC: ensure `~/.pi/agent/swarm.yml` has a modelPool placeholder. One-shot via
// `SwarmState.poolScaffoldGlobalNotifiedAt`. Never overwrites corrupt global.
export async function ensureGlobalPoolScaffold(opts: { alreadyNotified?: boolean } = {}): Promise<GlobalScaffoldResult> {
	const found = findGlobalSwarmYaml();
	const targetPath = found?.file || getGlobalSwarmYmlPrimary();

	// If global yml exists, check if it declares modelPool or is corrupt.
	if (found) {
		let globalYml: any = null;
		let globalCorrupt = false;
		try {
			globalYml = readGlobalSwarmYml(true);
		} catch (err) {
			await logSwarmError(undefined, "pool-scaffold", "global_scaffold.parse_failed", err);
			globalCorrupt = true;
		}
		if (globalCorrupt) {
			return { wrote: false, skipped: "corrupt", path: targetPath, error: "global yml corrupt" };
		}
		if (globalYml && Object.prototype.hasOwnProperty.call(globalYml, "modelPool")) {
			return { wrote: false, skipped: "modelpool_present", path: targetPath };
		}
		// Global exists but doesn't declare modelPool — don't overwrite (user has content there).
		return { wrote: false, skipped: "exists", path: targetPath };
	}

	// Global yml doesn't exist — write the scaffold.
	await atomicWriteFile(targetPath, POOL_SCAFFOLD_GLOBAL_YML_PLACEHOLDER);
	await traceLogged(undefined, "pool.global_scaffold_created", {
		path: targetPath,
		source: "global-swarm.yml",
	});
	return { wrote: true, path: targetPath, notify: POOL_SCAFFOLD_GLOBAL_YML_NOTIFY_TEXT };
}

/**
 * Run root pool scaffold and launch health check.
 * Called on root session_start, when registering as root (/swarm register here root),
 * or when explicitly initializing the swarm (/swarm init).
 */
export async function runRootPoolScaffoldAndHealth(ctx: any, p: Paths): Promise<void> {
	await ensureDirs(p);
	// 1. Project pool scaffold (.pi/swarm.yml)
	try {
		const result = await ensurePoolScaffold(ctx.cwd, {});
		if (result.wrote) {
			await withLock(p, async () => {
				const locked = await readState(p, ctx.cwd);
				if (!locked.poolScaffoldNotifiedAt) {
					locked.poolScaffoldNotifiedAt = now();
					await writeState(p, locked);
				}
			});
			if (ctx.hasUI && result.notify) {
				try {
					ctx.ui.notify(result.notify, "info");
				} catch (err: any) {
					expected("ui_notify_failed", err);
				}
			}
		}
	} catch (err: any) {
		await trace(p, "pool.scaffold_error", { error: String((err as Error)?.message || err) }).catch(() => {});
	}

	// 2. Global pool scaffold (~/.pi/agent/swarm.yml)
	try {
		const globalResult = await ensureGlobalPoolScaffold();
		if (globalResult.wrote) {
			await withLock(p, async () => {
				const locked = await readState(p, ctx.cwd);
				if (!locked.poolScaffoldGlobalNotifiedAt) {
					locked.poolScaffoldGlobalNotifiedAt = now();
					await writeState(p, locked);
				}
			});
			if (ctx.hasUI && globalResult.notify) {
				try {
					ctx.ui.notify(globalResult.notify, "info");
				} catch (err: any) {
					expected("ui_notify_failed", err);
				}
			}
		}
	} catch (err: any) {
		await trace(p, "pool.global_scaffold_error", { error: String((err as Error)?.message || err) }).catch(() => {});
	}

	// 3. Pool health validation check
	try {
		const validation = validateSwarmSettings(ctx.cwd, { registryProbe: ctx.modelRegistry as any });
		if (!validation.ok) {
			const lines = [`Swarm pool config has ${validation.errors.length} issue(s) — /swarm pool validate for details:`];
			for (const e of validation.errors.slice(0, 3)) lines.push(`  \u2717 ${e.field || "config"}: ${e.message}`);
			if (validation.errors.length > 3) lines.push(`  … and ${validation.errors.length - 3} more`);
			if (ctx.hasUI) {
				try {
					ctx.ui.notify(lines.join("\n"), "warning");
				} catch (err: any) {
					expected("ui_notify_failed", err);
				}
			}
			await trace(p, "pool.launch_health", {
				ok: false,
				errors: validation.errors.length,
				warnings: validation.warnings.length,
			}).catch(() => {});
		} else if (validation.warnings.length && ctx.hasUI) {
			const w = validation.warnings[0];
			try {
				ctx.ui.notify(`Swarm pool: ${w.message}`, "warning");
			} catch (err: any) {
				expected("ui_notify_failed", err);
			}
			await trace(p, "pool.launch_health", { ok: true, errors: 0, warnings: validation.warnings.length }).catch(() => {});
		}
	} catch (err: any) {
		expected("pool_launch_health_failed", err);
	}
}
