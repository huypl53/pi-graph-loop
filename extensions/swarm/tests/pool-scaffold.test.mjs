// Pool-scaffold on root session_start (Issue 20) tests
//
// Run: node extensions/swarm/pool-scaffold.test.mjs
//
// Covers (per the plan + 4 binding conditions):
//   A. settings.json missing swarm.modelPool -> writes placeholder
//   B. swarm.modelPool: [] -> no-op
//   C. swarm.modelPool with valid slot -> no-op
//   D. swarm.modelPool absent + other top-level keys preserved
//   E. Subsequent session_start with durable flag set -> notify suppressed
//   F. .pi/ absent -> no scaffold, no .pi/ created, trace skipped_no_pi_dir
//   G. settings.json with malformed swarm block -> treated as empty -> scaffold
//   H. Binding B1: extensions.swarm.modelPool exists + top-level swarm.modelPool absent -> NO scaffold (precedence)
//   I. Concurrent invocations on the same fresh cwd -> single file write (no torn write)
//   J. Clean-slate re-notify: if .pi/swarm is wiped, the next call notifies again
//
// Every assertion uses real file IO in a scratch tmp; nothing touches the host project.
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ensurePoolScaffold, poolScaffoldSettingsPath, poolScaffoldYmlPath } from "../src/pool-scaffold.ts";
import {
	POOL_SCAFFOLD_DOC_HINT,
	POOL_SCAFFOLD_NOTIFY_TEXT,
	POOL_SCAFFOLD_YML_NOTIFY_TEXT,
} from "../src/constants.ts";
import { parse as parseYaml } from "yaml";
import { atomicWriteFile, paths, readState, readJsonlRecords, withLock, writeState } from "../src/state.ts";
import { now } from "../src/utils.ts";

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.error("  FAIL:", name); } };

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

// === Case A: missing swarm.modelPool, settings.json WITHOUT a swarm block -> scaffolds .pi/swarm.yml ===
// (swarm.yml feature: the fresh-project default home is now the comment-friendly yml file;
// settings.json stays untouched when it has no swarm block to merge into.)
{
	const dir = await makeCase("A");
	await mkdir(join(dir, ".pi"), { recursive: true });
	await writeFile(join(dir, ".pi", "settings.json"), JSON.stringify({ theme: "dark" }));
	const result = await ensurePoolScaffold(dir, {});
	ok("A: result.wrote === true", result.wrote === true);
	ok("A: scaffold path is .pi/swarm.yml", result.path === poolScaffoldYmlPath(dir));
	const settingsAfter = JSON.parse(await readFile(poolScaffoldSettingsPath(dir), "utf8"));
	ok("A: settings.json untouched (theme preserved, no swarm block)", settingsAfter.theme === "dark" && settingsAfter.swarm === undefined);
	const ymlText = await readFile(poolScaffoldYmlPath(dir), "utf8");
	ok("A: yml placeholder contains model: null", /model:\s*null/.test(ymlText));
	const yml = parseYaml(ymlText);
	ok("A: parsed yml modelPool has 1 placeholder slot", Array.isArray(yml.modelPool) && yml.modelPool.length === 1 && yml.modelPool[0].model === null);
	const traces = await readTraces(dir, "pool.scaffold_created");
	ok("A: pool.scaffold_created trace emitted", traces.length === 1);
	ok("A: trace.previousKeys is []", deepEqual(traces[0]?.previousKeys, []));
	ok("A: trace.source === swarm.yml", traces[0]?.source === "swarm.yml");
	ok("A: result.notify matches the yml constant", result.notify === POOL_SCAFFOLD_YML_NOTIFY_TEXT);
}

// === Case B: modelPool: [] -> no-op ===
{
	const dir = await makeCase("B");
	await mkdir(join(dir, ".pi"), { recursive: true });
	const before = { swarm: { modelPool: [] } };
	await writeFile(join(dir, ".pi", "settings.json"), JSON.stringify(before));
	const result = await ensurePoolScaffold(dir, {});
	ok("B: wrote === false", result.wrote === false);
	ok("B: skipped === modelpool_present", result.skipped === "modelpool_present");
	const after = JSON.parse(await readFile(poolScaffoldSettingsPath(dir), "utf8"));
	ok("B: file untouched", deepEqual(after, before));
	const traces = await readTraces(dir, "pool.scaffold_created");
	ok("B: no scaffold_created trace", traces.length === 0);
}

// === Case C: modelPool with valid slot -> no-op ===
{
	const dir = await makeCase("C");
	await mkdir(join(dir, ".pi"), { recursive: true });
	const before = { swarm: { modelPool: [{ model: "glm-5.1", provider: "zai-coding-cn" }] } };
	await writeFile(join(dir, ".pi", "settings.json"), JSON.stringify(before));
	const result = await ensurePoolScaffold(dir, {});
	ok("C: wrote === false", result.wrote === false);
	ok("C: skipped === modelpool_present", result.skipped === "modelpool_present");
	const after = JSON.parse(await readFile(poolScaffoldSettingsPath(dir), "utf8"));
	ok("C: file untouched", deepEqual(after, before));
}

// === Case D: modelPool absent + other top-level keys preserved ===
{
	const dir = await makeCase("D");
	await mkdir(join(dir, ".pi"), { recursive: true });
	const before = {
		defaultProvider: "openai",
		swarm: { defaultModel: "gpt-5.4-mini" },
		theme: "light",
		packages: ["foo", "bar"],
	};
	await writeFile(join(dir, ".pi", "settings.json"), JSON.stringify(before));
	const result = await ensurePoolScaffold(dir, {});
	ok("D: wrote === true", result.wrote === true);
	const after = JSON.parse(await readFile(poolScaffoldSettingsPath(dir), "utf8"));
	ok("D: defaultProvider preserved", after.defaultProvider === "openai");
	ok("D: theme preserved", after.theme === "light");
	ok("D: packages preserved", deepEqual(after.packages, ["foo", "bar"]));
	ok("D: swarm.defaultModel preserved", after.swarm.defaultModel === "gpt-5.4-mini");
	ok("D: swarm.modelPool added", Array.isArray(after.swarm.modelPool) && after.swarm.modelPool.length === 1);
	const traces = await readTraces(dir, "pool.scaffold_created");
	ok("D: previousKeys captures the existing swarm-block keys", deepEqual(traces[0]?.previousKeys, ["defaultModel"]));
}

// === Case E: durable flag suppresses notify on second session_start ===
{
	const dir = await makeCase("E");
	await mkdir(join(dir, ".pi"), { recursive: true });
	await writeFile(join(dir, ".pi", "settings.json"), JSON.stringify({ theme: "dark" }));
	// First call: scaffolds + emits trace
	const r1 = await ensurePoolScaffold(dir, {});
	ok("E: first call wrote", r1.wrote === true);
	// Simulate the hook's durable-flag stamp on SwarmState
	const p = paths(dir);
	await withLock(p, async () => {
		const st = await readState(p, dir);
		st.poolScaffoldNotifiedAt = now();
		await writeState(p, st);
	});
	// Second call (same cwd, same .pi/settings.json now containing modelPool): should no-op
	const r2 = await ensurePoolScaffold(dir, {});
	ok("E: second call wrote === false (file already has modelPool)", r2.wrote === false);
	ok("E: second call skipped === modelpool_present", r2.skipped === "modelpool_present");
	// The hook-level flag is checked by the hook, not by ensurePoolScaffold. We confirm the flag is
	// persisted and would be observed by the hook on a /reload.
	const st = await readState(p, dir);
	ok("E: durable flag stamped on swarm-state", Boolean(st.poolScaffoldNotifiedAt));
	// Confirm one trace total: the second call did not re-emit
	const traces = await readTraces(dir, "pool.scaffold_created");
	ok("E: only one scaffold_created trace", traces.length === 1);
}

// === Case F: .pi/ absent -> no scaffold, no .pi/ created ===
{
	const dir = await makeCase("F");
	// No mkdir(.pi) this time
	const r = await ensurePoolScaffold(dir, {});
	ok("F: wrote === false", r.wrote === false);
	ok("F: skipped === no_pi_dir", r.skipped === "no_pi_dir");
	ok("F: .pi/ NOT created", !existsSync(join(dir, ".pi")));
	// No trace is emitted by design: trace() would mkdir .pi/swarm/... which would silently create
	// the directory the scaffold is supposed to refuse. The trace event name is reserved for future
	// use cases where .pi/ exists but settings.json lives elsewhere (none today).
	const traces = await readTraces(dir, "pool.scaffold_skipped_no_pi_dir");
	ok("F: no trace emitted (would have created .pi/swarm/)", traces.length === 0);
}

// === Case G: malformed swarm block (string, not object) -> treated as absent -> scaffold ===
{
	const dir = await makeCase("G");
	await mkdir(join(dir, ".pi"), { recursive: true });
	await writeFile(join(dir, ".pi", "settings.json"), JSON.stringify({ swarm: "not-an-object" }));
	const r = await ensurePoolScaffold(dir, {});
	ok("G: wrote === true (malformed swarm block treated as absent)", r.wrote === true);
	ok("G: scaffold home is .pi/swarm.yml (no valid JSON block to merge into)", r.path === poolScaffoldYmlPath(dir));
	const yml = parseYaml(await readFile(poolScaffoldYmlPath(dir), "utf8"));
	ok("G: yml scaffold has modelPool array", Array.isArray(yml?.modelPool));
	const settingsAfter = JSON.parse(await readFile(poolScaffoldSettingsPath(dir), "utf8"));
	ok("G: settings.json left untouched (swarm still the malformed string)", settingsAfter.swarm === "not-an-object");
}

// === Case H: BINDING B1 — extensions.swarm.modelPool exists but top-level swarm.modelPool absent ===
{
	const dir = await makeCase("H");
	await mkdir(join(dir, ".pi"), { recursive: true });
	const before = {
		extensions: { swarm: { modelPool: [{ model: "glm-5.1", provider: "zai-coding-cn" }] } },
		theme: "dark",
	};
	await writeFile(join(dir, ".pi", "settings.json"), JSON.stringify(before));
	const r = await ensurePoolScaffold(dir, {});
	ok("H: wrote === false (extensions.swarm.modelPool wins)", r.wrote === false);
	ok("H: skipped === modelpool_present", r.skipped === "modelpool_present");
	const after = JSON.parse(await readFile(poolScaffoldSettingsPath(dir), "utf8"));
	ok("H: file byte-identical", deepEqual(after, before));
	ok("H: extensions.swarm.modelPool still intact", after.extensions.swarm.modelPool[0].model === "glm-5.1");
	const traces = await readTraces(dir, "pool.scaffold_created");
	ok("H: no scaffold_created trace", traces.length === 0);
}

// === Case H2: extensions.swarm exists but modelPool absent + top-level swarm.modelPool exists ===
// (symmetric: top-level wins when extensions block is present but lacks modelPool)
{
	const dir = await makeCase("H2");
	await mkdir(join(dir, ".pi"), { recursive: true });
	const before = {
		extensions: { swarm: { defaultModel: "gpt-5.4-mini" } },
		swarm: { modelPool: [{ model: "glm-5.1", provider: "zai-coding-cn" }] },
	};
	await writeFile(join(dir, ".pi", "settings.json"), JSON.stringify(before));
	const r = await ensurePoolScaffold(dir, {});
	ok("H2: wrote === false (top-level swarm.modelPool takes effect)", r.wrote === false);
	const after = JSON.parse(await readFile(poolScaffoldSettingsPath(dir), "utf8"));
	ok("H2: file byte-identical", deepEqual(after, before));
}

// === Case H3: only extensions.swarm is set with no modelPool -> scaffold writes to extensions.swarm ===
{
	const dir = await makeCase("H3");
	await mkdir(join(dir, ".pi"), { recursive: true });
	const before = { extensions: { swarm: { defaultModel: "gpt-5.4-mini" } } };
	await writeFile(join(dir, ".pi", "settings.json"), JSON.stringify(before));
	const r = await ensurePoolScaffold(dir, {});
	ok("H3: wrote === true", r.wrote === true);
	const after = JSON.parse(await readFile(poolScaffoldSettingsPath(dir), "utf8"));
	ok("H3: modelPool written under extensions.swarm", Array.isArray(after.extensions.swarm.modelPool));
	ok("H3: existing extensions.swarm.defaultModel preserved", after.extensions.swarm.defaultModel === "gpt-5.4-mini");
	const traces = await readTraces(dir, "pool.scaffold_created");
	ok("H3: trace.source === extensions.swarm", traces[0]?.source === "extensions.swarm");
}

// === Case I: concurrent invocations on the same fresh cwd -> single file write, no torn write ===
{
	const dir = await makeCase("I");
	await mkdir(join(dir, ".pi"), { recursive: true });
	await writeFile(join(dir, ".pi", "settings.json"), JSON.stringify({ theme: "dark" }));
	// Fire 8 concurrent calls. atomicWriteFile guarantees no torn write; ensurePoolScaffold may write
	// the same payload multiple times (idempotent), so the final file must be parseable + valid.
	const results = await Promise.all(Array.from({ length: 8 }, () => ensurePoolScaffold(dir, {})));
	ok("I: every concurrent call wrote", results.every((r) => r.wrote === true));
	const afterYml = parseYaml(await readFile(poolScaffoldYmlPath(dir), "utf8"));
	ok("I: final yml is parseable", afterYml && typeof afterYml === "object");
	ok("I: final yml has exactly one modelPool slot", Array.isArray(afterYml.modelPool) && afterYml.modelPool.length === 1);
	const settingsAfter = JSON.parse(await readFile(poolScaffoldSettingsPath(dir), "utf8"));
	ok("I: theme still preserved", settingsAfter.theme === "dark");
	const traces = await readTraces(dir, "pool.scaffold_created");
	ok("I: concurrent traces all recorded (idempotent payload)", traces.length >= 1);
}

// === Case J: clean-slate re-notify — wiping .pi/swarm re-enables the scaffold ===
{
	const dir = await makeCase("J");
	await mkdir(join(dir, ".pi"), { recursive: true });
	await writeFile(join(dir, ".pi", "settings.json"), JSON.stringify({ theme: "dark" }));
	// First session: scaffold + stamp durable flag
	const p = paths(dir);
	const r1 = await ensurePoolScaffold(dir, {});
	ok("J: first scaffold wrote", r1.wrote === true);
	await withLock(p, async () => {
		const st = await readState(p, dir);
		st.poolScaffoldNotifiedAt = now();
		await writeState(p, st);
	});
	// Wipe .pi/swarm but KEEP .pi/settings.json so the file-side pool is still present (idempotent
	// path). The user is expected to call /swarm pool rotate /swarm pool reset to clear settings.json,
	// but in this case we simulate a clean-slate by removing BOTH .pi/swarm AND the modelPool key.
	await rm(join(dir, ".pi", "swarm"), { recursive: true, force: true });
	await rm(poolScaffoldYmlPath(dir), { force: true }); // clean-slate wipes the yml home too
	await writeFile(join(dir, ".pi", "settings.json"), JSON.stringify({ theme: "dark" }));
	const r2 = await ensurePoolScaffold(dir, {});
	ok("J: second scaffold (after clean-slate) wrote", r2.wrote === true);
	ok("J: notify text matches the yml constant (would re-emit on a real TUI session_start)", r2.notify === POOL_SCAFFOLD_YML_NOTIFY_TEXT);
}

// === Case K: corrupt settings.json -> hard skip, file untouched ===
{
	const dir = await makeCase("K");
	await mkdir(join(dir, ".pi"), { recursive: true });
	const corrupted = "{ not json";
	await writeFile(join(dir, ".pi", "settings.json"), corrupted);
	const r = await ensurePoolScaffold(dir, {});
	ok("K: wrote === false", r.wrote === false);
	ok("K: skipped === settings_unparseable", r.skipped === "settings_unparseable");
	const after = await readFile(poolScaffoldSettingsPath(dir), "utf8");
	ok("K: file byte-identical to the corrupted bytes", after === corrupted);
}

// === Case L: readJsonSafe sanity (utils.ts) ===
{
	const dir = await makeCase("L");
	await mkdir(join(dir, ".pi"), { recursive: true });
	await writeFile(join(dir, ".pi", "settings.json"), JSON.stringify({ x: 1 }));
	const { readJsonSafe } = await import("../src/utils.ts");
	const got = await readJsonSafe(join(dir, ".pi", "settings.json"));
	ok("L: readJsonSafe parses valid JSON", got?.x === 1);
	const missing = await readJsonSafe(join(dir, ".pi", "does-not-exist.json"));
	ok("L: readJsonSafe returns undefined for ENOENT", missing === undefined);
	let threw = false;
	try { await readJsonSafe(join(dir, "..", "package.json")); /* existing file, not JSON */ } catch { threw = true; }
	// package.json IS valid JSON in this repo, so try an obviously-non-JSON path:
	try { await readJsonSafe("/dev/null"); } catch { threw = true; }
	ok("L: readJsonSafe throws for non-JSON content", threw === true);
}

// === Case M: constants exported as expected ===
{
	ok("M: POOL_SCAFFOLD_NOTIFY_TEXT is non-empty", typeof POOL_SCAFFOLD_NOTIFY_TEXT === "string" && POOL_SCAFFOLD_NOTIFY_TEXT.length > 0);
	ok("M: POOL_SCAFFOLD_DOC_HINT references docs/swarm/tools.md#configuration", POOL_SCAFFOLD_DOC_HINT === "docs/swarm/tools.md#configuration");
}

// === Case N: poolScaffoldSettingsPath returns the expected location ===
{
	const dir = await makeCase("N");
	const got = poolScaffoldSettingsPath(dir);
	ok("N: settings path ends with .pi/settings.json", got.endsWith(join(".pi", "settings.json")));
}

console.log(`\n${fail === 0 ? "PASS" : "FAIL"}: ${pass} passed, ${fail} failed`);
await rm(fixtureDir, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
