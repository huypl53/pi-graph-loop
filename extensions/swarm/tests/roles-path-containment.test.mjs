#!/usr/bin/env node
// roles-path-containment.test.mjs — F1 red tests (task-redteam-fixnow)
//
// REPRODUCE-FIRST MANDATE: these tests are authored BEFORE the fix and observed RED
// for the right reason (resolveRolePlaybookPath / readCharterText do not enforce
// project-root realpath containment — a repo-committed .pi/swarm.yml can repoint
// playbooks/charter to attacker-controlled content OUTSIDE the project; redteam
// finding F1, PoC /tmp/rt-edgeb/p3-config/run.mjs cases A/a2/C).
//
// They go green when config.ts lands the containment mirror of resolveEvidencePath
// (state.ts:378-383): escaping paths produce validateRolesConfig errors with kinds
// roles_charter_outside_project / roles_playbook_outside_project, readCharterText
// refuses to load escaping content, and resolveRolePlaybook never returns an
// escaping path (spawn must never receive it as --skill).
//
// Run: node extensions/swarm/tests/roles-path-containment.test.mjs
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

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

console.log("=== F1 roles/charter project-root containment (red-first) ===");

// Isolated HOME so ~/.pi/agent/swarm.yml is test-only (mirror roles-config.test.mjs).
const testHome = await mkdtemp(join(tmpdir(), "roles-containment-home-"));
await mkdir(join(testHome, ".pi", "agent"), { recursive: true });
const dir = await mkdtemp(join(tmpdir(), "roles-containment-proj-"));
await mkdir(join(dir, ".pi"), { recursive: true });
const projectYml = join(dir, ".pi", "swarm.yml");
// OUTSIDE the project root: a sibling scratch dir the project yml must never reach.
const outsideDir = await mkdtemp(join(tmpdir(), "roles-containment-OUTSIDE-"));
const outsideSecret = join(outsideDir, "outside-SECRET.md");
await writeFile(outsideSecret, "# TOP SECRET\n\nAttacker-controlled charter content.\n");
const outsideSkillDir = join(outsideDir, "outside-skill");
await mkdir(outsideSkillDir, { recursive: true });
await writeFile(
	join(outsideSkillDir, "SKILL.md"),
	"---\nname: outside-skill\ndescription: OUTSIDE the project root.\n---\n\nEscalation body.\n",
);

process.env.HOME = testHome;

// Control fixtures that stay INSIDE the project (the exact shapes roles-config.test.mjs uses).
const customSkillDir = join(dir, "docs", "my-heavy-planner");
await mkdir(customSkillDir, { recursive: true });
await writeFile(
	join(customSkillDir, "SKILL.md"),
	"---\nname: my-heavy-planner\ndescription: Custom heavier planner playbook for testing.\n---\n\nCustom body.\n",
);
const customCharterFile = join(dir, "docs", "TEAM-RULES.md");
await writeFile(customCharterFile, "# Team charter\n\nQuality gates first.\n");

// ---------------------------------------------------------------------------
// 1. relative ../ traversal for charter -> error + refused content
// ---------------------------------------------------------------------------
console.log("\n[1] charter ../ traversal outside project -> roles_charter_outside_project");
{
	// Dynamically compute a ../ traversal from the project dir that REACHES the outside
	// secret file (so the pre-fix symptom is a real out-of-project LOAD, not a missing path).
	const rel = relative(dir, outsideSecret);
	await writeFile(
		projectYml,
		`roles:
  charter: ${rel}
`,
		"utf8",
	);
	const { validateRolesConfig, readCharterText } = await import("../src/config.ts");
	const errs = validateRolesConfig(dir, { freshGlobal: true });
	ok(
		"validateRolesConfig flags ../ charter with roles_charter_outside_project",
		Array.isArray(errs) && errs.some((e) => e.kind === "roles_charter_outside_project"),
		`errs=${JSON.stringify(errs)}`,
	);
	const text = readCharterText(dir, { freshGlobal: true });
	ok("readCharterText does NOT return out-of-project secret content", !String(text).includes("TOP SECRET"), `got=${String(text).slice(0, 80)}`);
}
// ---------------------------------------------------------------------------
// 2. absolute outside path for charter -> error + refused content
// ---------------------------------------------------------------------------
console.log("\n[2] charter absolute outside path -> roles_charter_outside_project");
{
	await writeFile(
		projectYml,
		`roles:
  charter: ${outsideSecret}
`,
		"utf8",
	);
	const { validateRolesConfig, readCharterText } = await import("../src/config.ts");
	const errs = validateRolesConfig(dir, { freshGlobal: true });
	ok(
		"validateRolesConfig flags absolute-outside charter",
		Array.isArray(errs) && errs.some((e) => e.kind === "roles_charter_outside_project"),
		`errs=${JSON.stringify(errs)}`,
	);
	const text = readCharterText(dir, { freshGlobal: true });
	ok("readCharterText refuses absolute-outside charter content", !String(text).includes("TOP SECRET"), `got=${String(text).slice(0, 80)}`);
}

// ---------------------------------------------------------------------------
// 3. relative symlink playbook pointing outside -> error + resolveRolePlaybook null
// ---------------------------------------------------------------------------
console.log("\n[3] symlinked playbook outside project -> roles_playbook_outside_project + null resolve");
{
	const linkPath = join(dir, "link-outside");
	await rm(linkPath, { force: true });
	await symlink(outsideSkillDir, linkPath, "dir");
	await writeFile(
		projectYml,
		`roles:
  tester: link-outside
`,
		"utf8",
	);
	const { validateRolesConfig, resolveRolePlaybook } = await import("../src/config.ts");
	const errs = validateRolesConfig(dir, { freshGlobal: true });
	ok(
		"validateRolesConfig flags symlinked-outside playbook",
		Array.isArray(errs) && errs.some((e) => e.kind === "roles_playbook_outside_project"),
		`errs=${JSON.stringify(errs)}`,
	);
	const resolved = resolveRolePlaybook("tester", {}, dir);
	ok("resolveRolePlaybook returns null for the escaping playbook", resolved === null, `got=${resolved}`);
	await rm(linkPath, { force: true });
}

// ---------------------------------------------------------------------------
// 4. CONTROL: inside-project custom paths keep working (abs + relative)
// ---------------------------------------------------------------------------
console.log("\n[4] CONTROL inside-project custom paths (abs + relative) stay clean");
{
	await writeFile(
		projectYml,
		`roles:
  charter: ${customCharterFile}
  planner: ${customSkillDir}
  tester: ./docs/my-heavy-planner
`,
		"utf8",
	);
	const { validateRolesConfig, resolveRolePlaybook, readCharterText } = await import("../src/config.ts");
	const errs = validateRolesConfig(dir, { freshGlobal: true });
	ok("CONTROL: inside-project custom paths produce no errors", Array.isArray(errs) && errs.length === 0, `errs=${JSON.stringify(errs)}`);
	ok("CONTROL: resolveRolePlaybook returns inside path", resolveRolePlaybook("tester", {}, dir) === customSkillDir, `got=${resolveRolePlaybook("tester", {}, dir)}`);
	const text = readCharterText(dir, { freshGlobal: true });
	ok("CONTROL: readCharterText returns custom content", String(text).includes("Team charter"), `got=${String(text).slice(0, 60)}`);
}

// ---------------------------------------------------------------------------
// 5. CONTROL: missing-but-inside path keeps its roles_playbook_missing kind
// ---------------------------------------------------------------------------
console.log("\n[5] CONTROL missing-inside path -> roles_playbook_missing (not outside_project)");
{
	await writeFile(
		projectYml,
		`roles:
  tester: ./missing-dir/
`,
		"utf8",
	);
	const { validateRolesConfig } = await import("../src/config.ts");
	const errs = validateRolesConfig(dir, { freshGlobal: true });
	ok(
		"CONTROL: missing-inside playbook reports roles_playbook_missing",
		Array.isArray(errs) && errs.some((e) => e.kind === "roles_playbook_missing"),
		`errs=${JSON.stringify(errs)}`,
	);
	ok(
		"CONTROL: missing-inside playbook is NOT flagged outside_project (ENOENT-tolerant containment)",
		!(errs || []).some((e) => e.kind === "roles_playbook_outside_project"),
		`errs=${JSON.stringify(errs)}`,
	);
}

// ---------------------------------------------------------------------------
// 6. STATIC: error kinds + shape surface through the exported API
// ---------------------------------------------------------------------------
console.log("\n[6] STATIC exports + error shape");
{
	const mod = await import("../src/config.ts");
	ok("validateRolesConfig still exported", typeof mod.validateRolesConfig === "function");
	ok("readCharterText still exported", typeof mod.readCharterText === "function");
	ok("resolveRolePlaybook still exported", typeof mod.resolveRolePlaybook === "function");
	const errs = mod.validateRolesConfig(dir, { freshGlobal: true });
	if (Array.isArray(errs) && errs.length > 0) {
		const e = errs[0];
		ok("error shape carries field/message", typeof e.field === "string" && typeof e.message === "string", `got=${JSON.stringify(e)}`);
	}
}

await rm(projectYml, { force: true });
await rm(globalYmlPath(), { force: true });
await rm(dir, { recursive: true, force: true });
await rm(testHome, { recursive: true, force: true });
await rm(outsideDir, { recursive: true, force: true });

function globalYmlPath() {
	return join(testHome, ".pi", "agent", "swarm.yml");
}

console.log(`\nResults: ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
