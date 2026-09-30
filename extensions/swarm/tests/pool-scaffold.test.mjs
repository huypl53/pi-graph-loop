// Pool-scaffold on root session_start (v4.2: YAML-only)
//
// Run: node extensions/swarm/tests/pool-scaffold.test.mjs
//
// Covers (per the v4.2 plan + spec):
//   A. No global yml, no project yml -> writes comments-only template to .pi/swarm.yml
//   B. Project yml declares modelPool -> no-op
//   C. Global yml declares modelPool -> no-op (global covers it)
//   D. .pi/ absent -> no scaffold, no .pi/ created
//   E. Corrupt project yml -> no scaffold (validate path reports corrupt)
//   F. Corrupt global yml -> no scaffold (never overwrites corrupt global)
//   G. ensureGlobalPoolScaffold writes global template when absent
//   H. ensureGlobalPoolScaffold skips when global exists
//   I. ensureGlobalPoolScaffold skips when global is corrupt
//
// Every assertion uses real file IO in a scratch tmp; nothing touches the host project.
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ensurePoolScaffold, ensureGlobalPoolScaffold, poolScaffoldYmlPath } from "../src/pool-scaffold.ts";
import { _clearGlobalYmlMemoForTests } from "../src/config.ts";
import { POOL_SCAFFOLD_YML_NOTIFY_TEXT, POOL_SCAFFOLD_GLOBAL_YML_NOTIFY_TEXT } from "../src/constants.ts";
import { parse as parseYaml } from "yaml";
import { atomicWriteFile, paths, readState, readJsonlRecords, withLock, writeState } from "../src/state.ts";
import { now } from "../src/utils.ts";

let pass = 0,
	fail = 0;
const ok = (name, cond) => {
	if (cond) pass++;
	else {
		fail++;
		console.error("  FAIL:", name);
	}
};

const deepEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function traceHas(dir, eventName) {
	const eventsFile = join(dir, ".pi", "swarm", "traces", "events.jsonl");
	if (!existsSync(eventsFile)) return false;
	const records = await readJsonlRecords(eventsFile);
	return records.some((r) => r.event === eventName);
}

async function readTraces(dir, eventName) {
	const eventsFile = join(dir, ".pi", "swarm", "traces", "events.jsonl");
	if (!existsSync(eventsFile)) return [];
	const records = await readJsonlRecords(eventsFile);
	return records.filter((r) => r.event === eventName);
}

const fixtureDir = await mkdtemp(join(tmpdir(), "pool-scaffold-fixtures-"));

async function makeCase(name) {
	const dir = join(fixtureDir, name);
	await mkdir(dir, { recursive: true });
	return dir;
}

// === Case A: no global yml, no project yml -> scaffolds .pi/swarm.yml ===
{
	const dir = await makeCase("A");
	await mkdir(join(dir, ".pi"), { recursive: true });
	const result = await ensurePoolScaffold(dir, {});
	ok("A: result.wrote === true", result.wrote === true);
	ok("A: scaffold path is .pi/swarm.yml", result.path === poolScaffoldYmlPath(dir));
	const ymlText = await readFile(poolScaffoldYmlPath(dir), "utf8");
	ok("A: yml template has no active model: null", !/^\s*-?\s*model:\s*null\s*$/m.test(ymlText));
	ok(
		"A: yml template documents the full config surface",
		/#\s*-\s*model:/.test(ymlText) &&
			/#\s*rotation:/.test(ymlText) &&
			/#\s*defaultModel:/.test(ymlText) &&
			/#\s*terminalManager:/.test(ymlText),
	);
	const yml = parseYaml(ymlText);
	ok(
		"A: comments-only template parses to empty (nothing active)",
		yml === null || yml === undefined || Object.keys(yml ?? {}).length === 0,
	);
	const traces = await readTraces(dir, "pool.scaffold_created");
	ok("A: pool.scaffold_created trace emitted", traces.length === 1);
	ok("A: trace.source === swarm.yml", traces[0]?.source === "swarm.yml");
	ok("A: result.notify matches the yml constant", result.notify === POOL_SCAFFOLD_YML_NOTIFY_TEXT);
}

// === Case B: project yml declares modelPool -> no-op ===
{
	const dir = await makeCase("B");
	await mkdir(join(dir, ".pi"), { recursive: true });
	await writeFile(
		join(dir, ".pi", "swarm.yml"),
		`modelPool:
  - model: glm-5.1
    provider: zai-coding-cn
`,
	);
	const result = await ensurePoolScaffold(dir, {});
	ok("B: result.wrote === false", result.wrote === false);
	ok("B: skipped === modelpool_present", result.skipped === "modelpool_present");
}

// === Case C: global yml declares modelPool -> no-op ===
{
	const dir = await makeCase("C");
	await mkdir(join(dir, ".pi"), { recursive: true });
	// Write global yml to a temp HOME
	const testHome = await mkdtemp(join(tmpdir(), "pool-scaffold-home-"));
	const origHome = process.env.HOME;
	process.env.HOME = testHome;
	await mkdir(join(testHome, ".pi", "agent"), { recursive: true });
	await writeFile(
		join(testHome, ".pi", "agent", "swarm.yml"),
		`modelPool:
  - model: gpt-5.4-mini
    provider: openai
`,
	);
	try {
		_clearGlobalYmlMemoForTests();
		const result = await ensurePoolScaffold(dir, {});
		ok("C: result.wrote === false (global covers it)", result.wrote === false);
		ok("C: skipped === modelpool_present", result.skipped === "modelpool_present");
		ok("C: project yml NOT created", !existsSync(join(dir, ".pi", "swarm.yml")));
	} finally {
		process.env.HOME = origHome;
		_clearGlobalYmlMemoForTests();
		await rm(testHome, { recursive: true, force: true });
	}
}

// === Case D: .pi/ absent -> no scaffold ===
{
	const dir = await makeCase("D");
	// No .pi/ directory
	const result = await ensurePoolScaffold(dir, {});
	ok("D: result.wrote === false", result.wrote === false);
	ok("D: skipped === no_pi_dir", result.skipped === "no_pi_dir");
	ok("D: no .pi/ created", !existsSync(join(dir, ".pi")));
}

// === Case E: corrupt project yml -> no scaffold ===
{
	const dir = await makeCase("E");
	await mkdir(join(dir, ".pi"), { recursive: true });
	await writeFile(join(dir, ".pi", "swarm.yml"), `modelPool: [{ model: "glm-5.1"\n  - invalid yaml\n`);
	const result = await ensurePoolScaffold(dir, {});
	ok("E: result.wrote === false", result.wrote === false);
	ok("E: skipped === corrupt", result.skipped === "corrupt");
}

// === Case F: corrupt global yml -> no scaffold (never overwrites corrupt global) ===
{
	const dir = await makeCase("F");
	await mkdir(join(dir, ".pi"), { recursive: true });
	const testHome = await mkdtemp(join(tmpdir(), "pool-scaffold-home-"));
	const origHome = process.env.HOME;
	process.env.HOME = testHome;
	await mkdir(join(testHome, ".pi", "agent"), { recursive: true });
	await writeFile(join(testHome, ".pi", "agent", "swarm.yml"), `modelPool: [{ model: "gpt-5.4-mini"\n  - invalid yaml\n`);
	try {
		_clearGlobalYmlMemoForTests();
		const result = await ensurePoolScaffold(dir, {});
		ok("F: result.wrote === false", result.wrote === false);
		ok("F: skipped === corrupt", result.skipped === "corrupt");
		ok("F: project yml NOT created", !existsSync(join(dir, ".pi", "swarm.yml")));
	} finally {
		process.env.HOME = origHome;
		_clearGlobalYmlMemoForTests();
		await rm(testHome, { recursive: true, force: true });
	}
}

// === Case G: ensureGlobalPoolScaffold writes global template when absent ===
{
	const testHome = await mkdtemp(join(tmpdir(), "pool-scaffold-home-"));
	const origHome = process.env.HOME;
	process.env.HOME = testHome;
	await mkdir(join(testHome, ".pi", "agent"), { recursive: true });
	try {
		_clearGlobalYmlMemoForTests();
		const result = await ensureGlobalPoolScaffold();
		ok("G: result.wrote === true", result.wrote === true);
		ok("G: global yml exists", existsSync(join(testHome, ".pi", "agent", "swarm.yml")));
		ok("G: result.notify matches the global constant", result.notify === POOL_SCAFFOLD_GLOBAL_YML_NOTIFY_TEXT);
		const text = await readFile(join(testHome, ".pi", "agent", "swarm.yml"), "utf8");
		ok("G: global template documents terminalManager", /#\s*terminalManager:/.test(text));
		const parsed = parseYaml(text);
		ok("G: global template parses to null (comments-only)", parsed === null || parsed === undefined);
	} finally {
		process.env.HOME = origHome;
		_clearGlobalYmlMemoForTests();
		await rm(testHome, { recursive: true, force: true });
	}
}

// === Case H: ensureGlobalPoolScaffold skips when global exists ===
{
	const testHome = await mkdtemp(join(tmpdir(), "pool-scaffold-home-"));
	const origHome = process.env.HOME;
	process.env.HOME = testHome;
	await mkdir(join(testHome, ".pi", "agent"), { recursive: true });
	await writeFile(
		join(testHome, ".pi", "agent", "swarm.yml"),
		`modelPool:
  - model: existing
    provider: existing
`,
	);
	try {
		_clearGlobalYmlMemoForTests();
		const result = await ensureGlobalPoolScaffold();
		ok("H: result.wrote === false", result.wrote === false);
		ok("H: skipped === modelpool_present", result.skipped === "modelpool_present");
	} finally {
		process.env.HOME = origHome;
		_clearGlobalYmlMemoForTests();
		await rm(testHome, { recursive: true, force: true });
	}
}

// === Case I: ensureGlobalPoolScaffold skips when global is corrupt ===
{
	const testHome = await mkdtemp(join(tmpdir(), "pool-scaffold-home-"));
	const origHome = process.env.HOME;
	process.env.HOME = testHome;
	await mkdir(join(testHome, ".pi", "agent"), { recursive: true });
	await writeFile(join(testHome, ".pi", "agent", "swarm.yml"), `modelPool: [{ model: "gpt-5.4-mini"\n  - invalid yaml\n`);
	try {
		_clearGlobalYmlMemoForTests();
		const result = await ensureGlobalPoolScaffold();
		ok("I: result.wrote === false", result.wrote === false);
		ok("I: skipped === corrupt", result.skipped === "corrupt");
	} finally {
		process.env.HOME = origHome;
		_clearGlobalYmlMemoForTests();
		await rm(testHome, { recursive: true, force: true });
	}
}

// cleanup
await rm(fixtureDir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
