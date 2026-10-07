#!/usr/bin/env node
// roles-config.test.mjs — Phase 0 red tests for the top-level `roles:` config key
//
// REPRODUCE-FIRST MANDATE: these tests are authored BEFORE the implementation and
// observed RED for the right reason (top-level `roles:` key silently ignored today,
// no per-key precedence, no preflight path validation). They go green when the
// implementation lands in config.ts.
//
// Run: node extensions/swarm/tests/roles-config.test.mjs
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";

let pass = 0,
	fail = 0;
const ok = (name, cond, info) => {
	if (cond) {
		pass++;
		console.log(`  ok   ${name}`);
	} else {
		fail++;
		console.error(`  FAIL ${name}${info ? ` — ${info}` : ""}`);
	}
};

console.log("=== roles: config (Phase 0 red) ===");

// Isolated HOME so ~/.pi/agent/swarm.yml is test-only (mirror global-config.test.mjs).
const testHome = await mkdtemp(join(tmpdir(), "roles-config-home-"));
await mkdir(join(testHome, ".pi", "agent"), { recursive: true });
const dir = await mkdtemp(join(tmpdir(), "roles-config-test-"));
await mkdir(join(dir, ".pi"), { recursive: true });
const projectYml = join(dir, ".pi", "swarm.yml");
const globalYml = join(testHome, ".pi", "agent", "swarm.yml");

process.env.HOME = testHome;

// Custom fixtures that DO exist: a skill dir and a charter file.
const customSkillDir = join(dir, "docs", "my-heavy-planner");
await mkdir(customSkillDir, { recursive: true });
await writeFile(
	join(customSkillDir, "SKILL.md"),
	"---\nname: my-heavy-planner\ndescription: Custom heavier planner playbook for testing.\n---\n\nCustom body.\n",
);
const customCharterFile = join(dir, "docs", "TEAM-RULES.md");
await writeFile(customCharterFile, "# Team charter\n\nQuality gates first.\n");

// ---------------------------------------------------------------------------
// 1. roles: key parses into the merged cfg (project layer)
// ---------------------------------------------------------------------------
await writeFile(
	projectYml,
	`roles:
  charter: ${customCharterFile}
  planner: ${customSkillDir}
`,
);
{
	const { mergeSwarmConfig } = await import("../src/config.ts");
	const result = mergeSwarmConfig(dir, { freshGlobal: true });
	ok("project roles: key appears in merged cfg", Boolean(result.cfg?.roles), `cfg keys: ${JSON.stringify(Object.keys(result.cfg || {}))}`);
	ok(
		"roles key attributed to project layer",
		result.sources?.roles?.layer === "project.swarm.yml",
		`sources: ${JSON.stringify(result.sources?.roles)}`,
	);
	const rolesCfg = result.cfg?.roles;
	ok("roles.charter carries the custom path", rolesCfg?.charter === customCharterFile, `got ${rolesCfg?.charter}`);
	ok("roles.planner carries the custom path", rolesCfg?.planner === customSkillDir, `got ${rolesCfg?.planner}`);
}

// ---------------------------------------------------------------------------
// 2. per-key precedence: project wins over global; unset keys fall through
// ---------------------------------------------------------------------------
await rm(projectYml, { force: true });
await writeFile(
	globalYml,
	`roles:
  planner: ${customSkillDir}
  charter: ${customCharterFile}
`,
);
await writeFile(
	projectYml,
	`roles:
  tester: ${customSkillDir}
`,
);
{
	const { readRolesConfig } = await import("../src/config.ts");
	const result = readRolesConfig(dir, { freshGlobal: true });
	ok("global roles key is read as base layer", Boolean(result?.roles), "resolved.roles absent");
	// per-key merge: project declares tester; global provides planner + charter
	ok(
		"per-key merge: global roles.planner preserved (project does not declare it)",
		Boolean(result?.roles?.planner?.path),
		`rolesCfg=${JSON.stringify(result?.roles)}`,
	);
	ok(
		"per-key merge: project roles.tester wins",
		result?.roles?.tester?.path === customSkillDir,
		`got ${result?.roles?.tester?.path}`,
	);
	// a whole-OBJECT replacement would have dropped planner; make sure we are honest
	ok(
		"per-key merge: roles merges per-key (not whole-object replacement)",
		Boolean(result?.roles?.planner) && Boolean(result?.roles?.tester),
		`rolesCfg=${JSON.stringify(result?.roles)}`,
	);
}

// ---------------------------------------------------------------------------
// 3. readRolesConfig: typed resolve + "default" sentinel
// ---------------------------------------------------------------------------
{
	const { readRolesConfig } = await import("../src/config.ts");
	ok("readRolesConfig is exported from config.ts", typeof readRolesConfig === "function");
	if (typeof readRolesConfig === "function") {
		// current files: project {tester: custom}, global {planner: custom, charter: custom}
		const resolved = readRolesConfig(dir, { freshGlobal: true });
		ok("readRolesConfig resolves a roles object", Boolean(resolved?.roles), "resolved.roles absent");
		ok("readRolesConfig resolves a charter (custom or default)", Boolean(resolved?.charter), "charter absent");
		// sentinel test
		await writeFile(
			projectYml,
			`roles:
  tester: default
`,
		);
		const resolved2 = readRolesConfig(dir, { freshGlobal: true });
		ok(
			'readRolesConfig: "default" sentinel resolves to a playable bundled path',
			typeof resolved2?.roles?.tester?.path === "string" &&
				resolved2.roles.tester.path.length > 0 &&
				existsSync(resolved2.roles.tester.path),
			`got ${resolved2?.roles?.tester}`,
		);
	}
}

// ---------------------------------------------------------------------------
// 4. validateRolesConfig: invalid paths produce errors (not silent fallback)
// ---------------------------------------------------------------------------
{
	const { validateRolesConfig } = await import("../src/config.ts");
	ok("validateRolesConfig is exported from config.ts", typeof validateRolesConfig === "function");
	if (typeof validateRolesConfig === "function") {
		// nonexistent charter path -> error
		await writeFile(
			projectYml,
			`roles:
  charter: ./does-not-exist.md
`,
		);
		const errs = validateRolesConfig(dir, { freshGlobal: true });
		ok(
			"nonexistent roles.charter path produces a validation error",
			Array.isArray(errs) && errs.some((e) => /charter/i.test(e?.field || "") || /charter/i.test(e?.message || "")),
			`errs=${JSON.stringify(errs)}`,
		);

		// dir missing SKILL.md -> error
		const brokenDir = join(dir, "broken-skill-dir");
		await mkdir(brokenDir, { recursive: true });
		await writeFile(join(brokenDir, "notaskill.txt"), "nope");
		await writeFile(
			projectYml,
			`roles:
  tester: ${brokenDir}
`,
		);
		const errs2 = validateRolesConfig(dir, { freshGlobal: true });
		ok(
			"skill dir without SKILL.md produces a validation error",
			Array.isArray(errs2) && errs2.length > 0 && errs2.some((e) => /tester|SKILL/i.test(e?.message || "") || /tester/i.test(e?.field || "")),
			`errs=${JSON.stringify(errs2)}`,
		);

		// valid custom path resolves with no errors
		await writeFile(
			projectYml,
			`roles:
  tester: ${customSkillDir}
`,
		);
		const errs3 = validateRolesConfig(dir, { freshGlobal: true });
		ok(
			"valid custom path produces no errors",
			Array.isArray(errs3) && errs3.length === 0,
			`errs=${JSON.stringify(errs3)}`,
		);

		// nonexistent role dir -> error listing key
		await writeFile(
			projectYml,
			`roles:
  reviewer: ./also-missing/
`,
		);
		const errs4 = validateRolesConfig(dir, { freshGlobal: true });
		ok(
			"nonexistent role playbook dir produces a validation error",
			Array.isArray(errs4) && errs4.length > 0,
			`errs=${JSON.stringify(errs4)}`,
		);
	}
}

// ---------------------------------------------------------------------------
// 5. resolveRolePlaybook honors custom config + fixer selection
// ---------------------------------------------------------------------------
{
	const { resolveRolePlaybook, readCharterText } = await import("../src/config.ts");
	await writeFile(
		projectYml,
		`roles:
  tester: ${customSkillDir}
`,
	);

	if (typeof resolveRolePlaybook !== "function") {
		ok("resolveRolePlaybook is exported from config.ts", false, "export missing (RED)");
	} else {
		const p = resolveRolePlaybook("tester", {}, dir);
		ok("resolveRolePlaybook honors custom roles.tester path", p === customSkillDir, `got ${p}`);
	}
	await writeFile(
		projectYml,
		`roles:
  planner: ${customSkillDir}
`,
	);

	if (typeof resolveRolePlaybook === "function") {
		const pf = resolveRolePlaybook("implementer", { nodeId: "fix" }, dir);
		ok("resolveRolePlaybook({nodeId:'fix'}) resolves fixer", typeof pf === "string" && pf.includes("fixer"), `got ${pf}`);
	}
	if (typeof readCharterText === "function") {
		await writeFile(
			projectYml,
			`roles:
  charter: ${customCharterFile}
`,
		);
		{
			const text = readCharterText(dir);
			ok("readCharterText returns custom charter content", typeof text === "string" && text.includes("Team charter"), `got ${(text||"").slice(0, 60)}`);
		}
	} else {
		ok("readCharterText is exported from config.ts", false, "export missing");
	}
	await rm(projectYml, { force: true });
	await rm(globalYml, { force: true });
}

console.log(`\nResults: ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
