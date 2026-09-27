// Global + project YAML-only swarm config tests (task global-swarm-config-v4-2)
//
// Run: node extensions/swarm/tests/global-config.test.mjs
//
// Covers spec v4.2 acceptance criteria. Red-first: test #1 (globalConfig_globalYmlIsReadAsBaseLayer)
// is the regression test for the global-layer feature; it FAILS before implementation and PASSES after.
//
// All assertions use real file IO in scratch tmp dirs; nothing touches the host project .pi/.
// The HOME env var is overridden to a tmp dir so ~/.pi/agent/swarm.yml is test-isolated.
import { mkdtemp, mkdir, writeFile, rm, readFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { parse as parseYaml } from "yaml";

let pass = 0,
	fail = 0;
const ok = (name, cond) => {
	if (cond) pass++;
	else {
		fail++;
		console.error("  FAIL:", name);
	}
};

// Isolated HOME so ~/.pi/agent/swarm.yml is test-only.
const testHome = await mkdtemp(join(tmpdir(), "global-config-home-"));
process.env.HOME = testHome;
await mkdir(join(testHome, ".pi", "agent"), { recursive: true });

const dir = await mkdtemp(join(tmpdir(), "global-config-test-"));
await mkdir(join(dir, ".pi"), { recursive: true });
const projectYml = join(dir, ".pi", "swarm.yml");
const projectYaml = join(dir, ".pi", "swarm.yaml");
const settingsFile = join(dir, ".pi", "settings.json");
const globalYml = join(testHome, ".pi", "agent", "swarm.yml");
const globalYaml = join(testHome, ".pi", "agent", "swarm.yaml");

// === Test #1: RED REPRODUCTION — global yml is read as base layer ===
await writeFile(
	globalYml,
	`modelPool:
  - model: gpt-5.4-mini
    provider: openai
    weight: 50
rotation:
  strategy: weighted
  cooldownMs: 900000
`,
);
process.chdir(dir);
{
	// Dynamic import so HOME is set before config.ts reads it.
	const { mergeSwarmConfig } = await import("../src/config.ts");
	const result = mergeSwarmConfig(dir, { freshGlobal: true });
	ok("globalConfig_globalYmlIsReadAsBaseLayer: global pool appears", result.cfg.modelPool?.length === 1);
	ok("globalConfig_globalYmlIsReadAsBaseLayer: global slot attributed to global", result.sources.modelPool?.layer === "global");
	ok("globalConfig_globalYmlIsReadAsBaseLayer: global rotation appears", result.cfg.rotation?.strategy === "weighted");
}

await rm(globalYml, { force: true });

// === Test #2: only global ===
await writeFile(
	globalYml,
	`modelPool:
  - model: gpt-5.4-mini
    provider: openai
    weight: 50
rotation:
  strategy: weighted
  cooldownMs: 900000
`,
);
{
	const { mergeSwarmConfig } = await import("../src/config.ts");
	const result = mergeSwarmConfig(dir, { freshGlobal: true });
	ok("globalConfig_onlyGlobal: pool has 1 slot", result.cfg.modelPool?.length === 1);
	ok("globalConfig_onlyGlobal: pool attributed to global", result.sources.modelPool?.layer === "global");
	ok("globalConfig_onlyGlobal: rotation attributed to global", result.sources.rotation?.layer === "global");
	ok("globalConfig_onlyGlobal: no project file", !existsSync(projectYml));
}

await rm(globalYml, { force: true });

// === Test #3: only project ===
await writeFile(
	projectYml,
	`modelPool:
  - model: glm-5.1
    provider: zai-coding-cn
    weight: 100
`,
);
{
	const { mergeSwarmConfig } = await import("../src/config.ts");
	const result = mergeSwarmConfig(dir, { freshGlobal: true });
	ok("globalConfig_onlyProject: pool has 1 slot", result.cfg.modelPool?.length === 1);
	ok("globalConfig_onlyProject: pool attributed to project", result.sources.modelPool?.layer === "project.swarm.yml");
}

await rm(projectYml, { force: true });

// === Test #4: both layers, per-key override ===
await writeFile(
	globalYml,
	`modelPool:
  - model: gpt-5.4-mini
    provider: openai
    weight: 50
rotation:
  strategy: weighted
  cooldownMs: 900000
`,
);
await writeFile(
	projectYml,
	`modelPool:
  - model: glm-5.1
    provider: zai-coding-cn
    weight: 100
`,
);
{
	const { mergeSwarmConfig } = await import("../src/config.ts");
	const result = mergeSwarmConfig(dir, { freshGlobal: true });
	ok("globalConfig_bothLayers_perKeyOverride: modelPool from project", result.cfg.modelPool?.[0]?.model === "glm-5.1");
	ok("globalConfig_bothLayers_perKeyOverride: modelPool attributed to project", result.sources.modelPool?.layer === "project.swarm.yml");
	ok("globalConfig_bothLayers_perKeyOverride: rotation from global", result.cfg.rotation?.strategy === "weighted");
	ok("globalConfig_bothLayers_perKeyOverride: rotation attributed to global", result.sources.rotation?.layer === "global");
}

await rm(globalYml, { force: true });
await rm(projectYml, { force: true });

// === Test #5: modelPool whole-array replacement ===
await writeFile(
	globalYml,
	`modelPool:
  - model: gpt-5.4-mini
    provider: openai
    weight: 50
  - model: claude-opus-4
    provider: anthropic
    weight: 30
`,
);
await writeFile(
	projectYml,
	`modelPool:
  - model: glm-5.1
    provider: zai-coding-cn
    weight: 100
`,
);
{
	const { mergeSwarmConfig } = await import("../src/config.ts");
	const result = mergeSwarmConfig(dir, { freshGlobal: true });
	ok("globalConfig_modelPoolWholeArrayReplacement: pool has 1 slot (not 3)", result.cfg.modelPool?.length === 1);
	ok("globalConfig_modelPoolWholeArrayReplacement: pool is project array", result.cfg.modelPool?.[0]?.model === "glm-5.1");
}

await rm(globalYml, { force: true });
await rm(projectYml, { force: true });

// === Test #6: inheritGlobal: false skips global ===
await writeFile(
	globalYml,
	`modelPool:
  - model: gpt-5.4-mini
    provider: openai
    weight: 50
`,
);
await writeFile(
	projectYml,
	`inheritGlobal: false
modelPool:
  - model: glm-5.1
    provider: zai-coding-cn
    weight: 100
`,
);
{
	const { mergeSwarmConfig } = await import("../src/config.ts");
	const result = mergeSwarmConfig(dir, { freshGlobal: true });
	ok("globalConfig_inheritGlobalFalse_skipsGlobal: pool is project only", result.cfg.modelPool?.length === 1);
	ok("globalConfig_inheritGlobalFalse_skipsGlobal: globalInheritDisabled true", result.globalInheritDisabled === true);
	ok("globalConfig_inheritGlobalFalse_skipsGlobal: pool attributed to project", result.sources.modelPool?.layer === "project.swarm.yml");
}

await rm(globalYml, { force: true });
await rm(projectYml, { force: true });

// === Test #7: inheritGlobal in global is ignored ===
await writeFile(
	globalYml,
	`inheritGlobal: false
modelPool:
  - model: gpt-5.4-mini
    provider: openai
    weight: 50
`,
);
await writeFile(
	projectYml,
	`modelPool:
  - model: glm-5.1
    provider: zai-coding-cn
    weight: 100
`,
);
{
	const { mergeSwarmConfig } = await import("../src/config.ts");
	const result = mergeSwarmConfig(dir, { freshGlobal: true });
	ok("globalConfig_inheritGlobalInGlobal_ignored: global inheritGlobal ignored", result.globalInheritDisabled === false);
	ok("globalConfig_inheritGlobalInGlobal_ignored: project wins per-key", result.cfg.modelPool?.[0]?.model === "glm-5.1");
}

await rm(globalYml, { force: true });
await rm(projectYml, { force: true });

// === Test #8: corrupt global degrades and reports ===
await writeFile(globalYml, `modelPool: [{ model: "gpt-5.4-mini"\n  - invalid yaml\n`);
await writeFile(
	projectYml,
	`modelPool:
  - model: glm-5.1
    provider: zai-coding-cn
`,
);
{
	const { mergeSwarmConfig } = await import("../src/config.ts");
	const result = mergeSwarmConfig(dir, { freshGlobal: true });
	ok(
		"globalConfig_corruptGlobal_degradesAndReports: corrupt[] has global entry",
		result.corrupt.some((c) => c.layer === "global"),
	);
	ok("globalConfig_corruptGlobal_degradesAndReports: project pool still applied", result.cfg.modelPool?.[0]?.model === "glm-5.1");
	ok(
		"globalConfig_corruptGlobal_degradesAndReports: errCode captured",
		result.corrupt.find((c) => c.layer === "global")?.errCode !== undefined,
	);
}

await rm(globalYml, { force: true });
await rm(projectYml, { force: true });

// === Test #9: corrupt project degrades and reports ===
await writeFile(
	globalYml,
	`modelPool:
  - model: gpt-5.4-mini
    provider: openai
    weight: 50
`,
);
await writeFile(projectYml, `modelPool: [{ model: "glm-5.1"\n  - invalid yaml\n`);
{
	const { mergeSwarmConfig } = await import("../src/config.ts");
	const result = mergeSwarmConfig(dir, { freshGlobal: true });
	ok(
		"globalConfig_corruptProject_degradesAndReports: corrupt[] has project entry",
		result.corrupt.some((c) => c.layer === "project"),
	);
	ok("globalConfig_corruptProject_degradesAndReports: global pool still applied", result.cfg.modelPool?.[0]?.model === "gpt-5.4-mini");
}

await rm(globalYml, { force: true });
await rm(projectYml, { force: true });

// === Test #10: both corrupt ===
await writeFile(globalYml, `modelPool: [{ model: "gpt-5.4-mini"\n  - invalid yaml\n`);
await writeFile(projectYml, `modelPool: [{ model: "glm-5.1"\n  - invalid yaml\n`);
{
	const { mergeSwarmConfig } = await import("../src/config.ts");
	const result = mergeSwarmConfig(dir, { freshGlobal: true });
	const layers = result.corrupt.map((c) => c.layer).sort();
	ok("globalConfig_bothCorrupt: corrupt[] has both layers", layers.length === 2 && layers[0] === "global" && layers[1] === "project");
}

await rm(globalYml, { force: true });
await rm(projectYml, { force: true });

// === Test #11: stale_swarm_json_block fires always ===
await writeFile(settingsFile, JSON.stringify({ swarm: { modelPool: [{ model: "old-model", provider: "old-provider" }] } }));
await writeFile(
	projectYml,
	`modelPool:
  - model: glm-5.1
    provider: zai-coding-cn
`,
);
{
	const { validateSwarmSettings } = await import("../src/pool.ts");
	const validation = validateSwarmSettings(dir);
	const kinds = new Set(validation.warnings.map((w) => w.kind));
	ok("validate_staleSwarmJsonBlock_alwaysFires: warning present", kinds.has("stale_swarm_json_block"));
	ok("validate_staleSwarmJsonBlock_alwaysFires: ok is true", validation.ok === true);
}

await rm(settingsFile, { force: true });
await rm(projectYml, { force: true });

// === Test #12: stale_swarm_json_block self-extinguishes ===
// (no settings.json swarm block → warning does not fire)
{
	const { validateSwarmSettings } = await import("../src/pool.ts");
	const validation = validateSwarmSettings(dir);
	const kinds = new Set(validation.warnings.map((w) => w.kind));
	ok("validate_staleSwarmJsonBlock_selfExtinguishes: warning absent", !kinds.has("stale_swarm_json_block"));
}

// === Test #13: unknown top-level key, plain list no suggestions ===
await writeFile(
	projectYml,
	`modlePool:
  - model: glm-5.1
    provider: zai-coding-cn
`,
);
{
	const { validateSwarmSettings } = await import("../src/pool.ts");
	const validation = validateSwarmSettings(dir);
	const unknownWarning = validation.warnings.find((w) => w.kind === "unknown_top_level_key");
	ok("validate_unknownTopLevelKey_noSuggestionEngine: warning present", unknownWarning !== undefined);
	ok("validate_unknownTopLevelKey_noSuggestionEngine: message lists key", unknownWarning?.message?.includes("modlePool") === true);
	ok(
		"validate_unknownTopLevelKey_noSuggestionEngine: message names source file",
		unknownWarning?.message?.includes(".pi/swarm.yml") === true,
	);
	ok("validate_unknownTopLevelKey_noSuggestionEngine: no Levenshtein suggestion", !unknownWarning?.message?.includes("did you mean"));
}

await rm(projectYml, { force: true });

// === Test #14: per-error source attribution ===
await writeFile(
	projectYml,
	`modelPool:
  - model: ""
    provider: openai
`,
);
{
	const { validateSwarmSettings } = await import("../src/pool.ts");
	const validation = validateSwarmSettings(dir);
	const emptyModelError = validation.errors.find((e) => e.kind === "slot_empty_model");
	ok("validate_perErrorSourceAttribution: error has source field", emptyModelError?.source !== undefined);
	ok("validate_perErrorSourceAttribution: source is project", emptyModelError?.source === "project");
}

await rm(projectYml, { force: true });

// === Test #15: global EACCES distinct from corrupt ===
await writeFile(globalYml, `modelPool:\n  - model: gpt-5.4-mini\n    provider: openai\n`);
await chmod(globalYml, 0o000);
{
	const { validateSwarmSettings } = await import("../src/pool.ts");
	const validation = validateSwarmSettings(dir);
	const eaccesError = validation.errors.find((e) => e.kind === "global_swarm_yml_eacces");
	ok("validate_globalEaccesDistinctFromCorrupt: eacces kind present", eaccesError !== undefined);
	ok(
		"validate_globalEaccesDistinctFromCorrupt: not unreadable kind",
		!validation.errors.some((e) => e.kind === "global_swarm_yml_unreadable"),
	);
}
// Restore permissions for cleanup
await chmod(globalYml, 0o644);
await rm(globalYml, { force: true });

// === Test #16: swarm_yml_empty for project ===
await writeFile(projectYml, `# comments only\n`);
{
	const { validateSwarmSettings } = await import("../src/pool.ts");
	const validation = validateSwarmSettings(dir);
	const kinds = new Set(validation.warnings.map((w) => w.kind));
	ok("validate_swarmYmlEmpty_keptForProject: warning present", kinds.has("swarm_yml_empty"));
}
await rm(projectYml, { force: true });

// === Test #17: scaffold both absent writes project yml ===
{
	const { ensurePoolScaffold } = await import("../src/pool-scaffold.ts");
	await rm(globalYml, { force: true });
	const result = await ensurePoolScaffold(dir);
	ok("scaffold_bothAbsent_writesProjectYml: wrote", result.wrote === true);
	ok("scaffold_bothAbsent_writesProjectYml: project yml exists", existsSync(projectYml));
}
await rm(projectYml, { force: true });

// === Test #18: scaffold global has pool skips write ===
await writeFile(
	globalYml,
	`modelPool:
  - model: gpt-5.4-mini
    provider: openai
    weight: 50
`,
);
{
	const { ensurePoolScaffold } = await import("../src/pool-scaffold.ts");
	const result = await ensurePoolScaffold(dir);
	ok("scaffold_globalHasPool_skipsWrite: did not write", result.wrote === false);
	ok("scaffold_globalHasPool_skipsWrite: project yml not created", !existsSync(projectYml));
}
await rm(globalYml, { force: true });

// === Test #19: scaffold project has pool skips write ===
await writeFile(
	projectYml,
	`modelPool:
  - model: glm-5.1
    provider: zai-coding-cn
`,
);
{
	const { ensurePoolScaffold } = await import("../src/pool-scaffold.ts");
	const result = await ensurePoolScaffold(dir);
	ok("scaffold_projectHasPool_skipsWrite: did not write", result.wrote === false);
	ok("scaffold_projectHasPool_skipsWrite: global yml not created", !existsSync(globalYml));
}
await rm(projectYml, { force: true });

// === Test #20: scaffold corrupt global skips write ===
await writeFile(globalYml, `modelPool: [{ model: "gpt-5.4-mini"\n  - invalid yaml\n`);
{
	const { ensurePoolScaffold } = await import("../src/pool-scaffold.ts");
	const result = await ensurePoolScaffold(dir);
	ok("scaffold_corruptGlobal_skipsWrite: did not write", result.wrote === false);
	ok("scaffold_corruptGlobal_skipsWrite: project yml not created", !existsSync(projectYml));
}
await rm(globalYml, { force: true });

// === Test #21: scaffold no .pi/ skips write ===
{
	const noPiDir = await mkdtemp(join(tmpdir(), "global-config-nopi-"));
	const { ensurePoolScaffold } = await import("../src/pool-scaffold.ts");
	const result = await ensurePoolScaffold(noPiDir);
	ok("scaffold_noPiDir_skipsWrite: did not write", result.wrote === false);
	ok("scaffold_noPiDir_skipsWrite: no .pi/ created", !existsSync(join(noPiDir, ".pi")));
	await rm(noPiDir, { recursive: true, force: true });
}

// === Test #22: global scaffold absent writes global yml ===
{
	const { ensureGlobalPoolScaffold } = await import("../src/pool-scaffold.ts");
	await rm(globalYml, { force: true });
	const result = await ensureGlobalPoolScaffold();
	ok("globalScaffold_absent_writesGlobalYml: wrote", result.wrote === true);
	ok("globalScaffold_absent_writesGlobalYml: global yml exists", existsSync(globalYml));
}
await rm(globalYml, { force: true });

// === Test #23: global scaffold corrupt global skips write ===
await writeFile(globalYml, `modelPool: [{ model: "gpt-5.4-mini"\n  - invalid yaml\n`);
{
	const { ensureGlobalPoolScaffold } = await import("../src/pool-scaffold.ts");
	const result = await ensureGlobalPoolScaffold();
	ok("globalScaffold_corruptGlobal_skipsWrite: did not write", result.wrote === false);
}
await rm(globalYml, { force: true });

// === Test #24: global scaffold existing global skips write ===
await writeFile(globalYml, `modelPool:\n  - model: existing\n    provider: existing\n`);
{
	const { ensureGlobalPoolScaffold } = await import("../src/pool-scaffold.ts");
	const result = await ensureGlobalPoolScaffold();
	ok("globalScaffold_existingGlobal_skipsWrite: did not write", result.wrote === false);
}
await rm(globalYml, { force: true });

// === Test #25: scaffold global template parses to null ===
{
	const { POOL_SCAFFOLD_GLOBAL_YML_PLACEHOLDER } = await import("../src/constants.ts");
	const parsed = parseYaml(POOL_SCAFFOLD_GLOBAL_YML_PLACEHOLDER);
	ok("scaffold_globalTemplateParsesNull: template parses to null", parsed === null || parsed === undefined);
}

// === Test #26: memoization ===
await writeFile(
	globalYml,
	`modelPool:
  - model: gpt-5.4-mini
    provider: openai
    weight: 50
`,
);
{
	const { readGlobalSwarmYml } = await import("../src/config.ts");
	const first = readGlobalSwarmYml();
	// Modify file on disk — memoized call should still return the old value
	await writeFile(globalYml, `modelPool:\n  - model: changed\n    provider: changed\n`);
	const second = readGlobalSwarmYml();
	ok("globalConfig_memoization: second call returns memoized value", second === first);
	const fresh = readGlobalSwarmYml(true);
	ok("globalConfig_memoization: fresh=true bypasses memo", fresh !== first);
}
await rm(globalYml, { force: true });

// === Test #27: commands/pool.ts validate rendering — source field is a string, not {layer, file} ===
// Regression: fmtSrc previously expected {layer, file} but PoolValidationError.source is a
// layer-name string ("global"|"project"|"merged"|"default"), producing "[source: undefined (undefined)]"
// in real validate output. The fix: fmtSrc handles both shapes.
{
	const { handlePoolCommand } = await import("../src/commands/pool.ts");
	const projectDir = await mkdtemp(join(tmpdir(), "render-fix-"));
	await mkdir(join(projectDir, ".pi"), { recursive: true });
	// Write a stale settings.json (triggers stale_swarm_json_block warning) AND a yml with a bad slot
	// (triggers an error that flips ok to false). This exercises BOTH the source rendering on warnings
	// AND the warnings-in-FAILED-branch rendering.
	await writeFile(join(projectDir, ".pi", "settings.json"), JSON.stringify({ swarm: { modelPool: [{ model: "stale" }] } }));
	await writeFile(
		join(projectDir, ".pi", "swarm.yml"),
		`modelPool:
  - model: ""
    provider: ""
`,
	);
	const notifications = [];
	const ctx = {
		cwd: projectDir,
		hasUI: true,
		ui: { notify: (msg) => notifications.push(msg) },
		modelRegistry: { find: () => undefined },
	};
	const pi = { registerTool: () => {}, registerCommand: () => {}, on: () => {} };
	const { paths } = await import("../src/state.ts");
	await handlePoolCommand("pool", ["validate"], ctx, paths(projectDir), pi);
	const out = notifications.join("\n");
	ok(
		"render_sourceOnError: error line has [source: project] not [source: undefined (undefined)]",
		out.includes("[source: project]") && !out.includes("[source: undefined (undefined)]"),
		out.slice(0, 200),
	);
	ok(
		"render_warningsInFailedBranch: stale settings.json warning present even when ok:false",
		/settings\.json.*swarm block/.test(out) || out.includes("stale_swarm_json_block"),
		out.slice(0, 200),
	);

	// Combo regression (v4 CRITICAL #1): inheritGlobal: false + corrupt global → globalInheritDisabled
	// is true AND corrupt[] carries the global entry with errCode. Guards the fix where global is
	// still READ (corrupt visible) but never applied when inheritGlobal:false is set in project yml.
	const comboDir = await mkdtemp(join(tmpdir(), "combo-regress-"));
	await mkdir(join(comboDir, ".pi"), { recursive: true });
	const comboGlobalDir = join(testHome, ".pi", "agent");
	await mkdir(comboGlobalDir, { recursive: true });
	const comboGlobalYml = join(comboGlobalDir, "swarm.yml");
	// Write corrupt global yml (invalid YAML)
	await writeFile(comboGlobalYml, "modelPool:\n  - model: bad\n    weight: [invalid\n");
	await writeFile(
		join(comboDir, ".pi", "swarm.yml"),
		`inheritGlobal: false
modelPool:
  - model: gpt-5.4-mini
    provider: openai
    weight: 100
`,
	);
	const { mergeSwarmConfig: mergeCombo, _clearGlobalYmlMemoForTests: clearCombo } = await import("../src/config.ts");
	clearCombo();
	const comboResolved = mergeCombo(comboDir, { freshGlobal: true });
	ok(
		"comboRegression_inheritGlobalFalseWithCorruptGlobal: globalInheritDisabled is true",
		comboResolved.globalInheritDisabled === true,
		JSON.stringify({ globalInheritDisabled: comboResolved.globalInheritDisabled }),
	);
	ok(
		"comboRegression_inheritGlobalFalseWithCorruptGlobal: corrupt[] carries global entry",
		Array.isArray(comboResolved.corrupt) && comboResolved.corrupt.some((c) => c.layer === "global"),
		JSON.stringify(comboResolved.corrupt),
	);
	ok(
		"comboRegression_inheritGlobalFalseWithCorruptGlobal: corrupt global entry has errCode",
		Array.isArray(comboResolved.corrupt) && comboResolved.corrupt.some((c) => c.layer === "global" && typeof c.errCode === "string"),
		JSON.stringify(comboResolved.corrupt),
	);
	ok(
		"comboRegression_inheritGlobalFalseWithCorruptGlobal: project pool still applied",
		comboResolved.cfg.modelPool?.length === 1 && comboResolved.cfg.modelPool[0].model === "gpt-5.4-mini",
		JSON.stringify(comboResolved.cfg.modelPool?.map((s) => s.model)),
	);
	await rm(comboGlobalYml, { force: true });
	await rm(comboDir, { recursive: true, force: true });
	await rm(projectDir, { recursive: true, force: true });
}

// === Cleanup ===
await rm(dir, { recursive: true, force: true });
await rm(testHome, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
