// Deterministic test for session scoping + spawn attribution.
// Run: node extensions/background-tasks/session.test.mjs
import { createJiti } from "jiti";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const jiti = createJiti(import.meta.url);
const lib = await jiti.import("./src/lifecycle.ts");
const stateLib = await jiti.import("./src/state.ts");
const utilsLib = await jiti.import("./src/utils.ts");
const { spawnTask, reconcile } = lib;
const { paths, readState } = stateLib;
const { belongsToSession } = utilsLib;

const settings = {
	enabled: true,
	maxConcurrent: 8,
	logMaxBytes: 5 * 1024 * 1024,
	waitMaxMs: 120000,
	waitPollMs: 100,
	stopGraceMs: 800,
	killOnShutdown: false,
	scopeBySession: true,
	ui: { enabled: false, refreshMs: 1000, maxRows: 8 },
};

let pass = 0;
let fail = 0;
const ok = (m) => { pass++; console.log("  ok   ", m); };
const bad = (m) => { fail++; console.error("  FAIL:", m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const cwd = await mkdtemp(join(tmpdir(), "bg-sess-"));
console.log("test cwd:", cwd);
const p = paths(cwd);

try {
	// Spawn a task attributed to session "sessA" and confirm the stable id is persisted.
	console.log("\n[SC1] spawn attribution: sessionId lands on spawnedBySession");
	const tA = await spawnTask(cwd, settings, { command: "echo A", cwd, label: "probeA", sessionId: "sessA" }, () => {});
	if (tA.spawnedBySession === "sessA") ok(`spawnedBySession=${tA.spawnedBySession}`);
	else bad(`expected spawnedBySession=sessA, got ${tA.spawnedBySession}`);

	// belongsToSession: owner sees it, a different session does not (when scope on).
	console.log("\n[SC2] belongsToSession filtering");
	if (belongsToSession(tA, "sessA", true) === true) ok("owner sessA sees own task");
	else bad("owner sessA should see own task");
	if (belongsToSession(tA, "sessB", true) === false) ok("other sessB does NOT see sessA task");
	else bad("sessB should be filtered out");
	if (belongsToSession(tA, "sessA", false) === true) ok("scope off => everyone sees it");
	else bad("scope off should show task");

	// Anonymous / legacy task (no sessionId) stays visible everywhere (nothing vanishes on upgrade).
	console.log("\n[SC3] legacy/anonymous task visible to all");
	const tLeg = await spawnTask(cwd, settings, { command: "echo legacy", cwd, label: "legacy" }, () => {});
	if (tLeg.spawnedBySession === undefined) ok("legacy task has no spawnedBySession");
	else bad(`expected undefined, got ${tLeg.spawnedBySession}`);
	if (belongsToSession(tLeg, "sessB", true) === true && belongsToSession(tLeg, "sessX", true) === true) ok("legacy task visible to every session");
	else bad("legacy task should be visible everywhere");

	// currentSessionId unknown (no ctx) => belongsToSession falls back to visible (safe default).
	console.log("\n[SC4] unknown current session => safe fallback (visible)");
	if (belongsToSession(tA, undefined, true) === true) ok("unknown current session => task visible");
	else bad("unknown current session should fall back to visible");

	// Both tasks persisted in the single shared registry; scoping is a READ-time filter, not storage.
	console.log("\n[SC5] registry holds all sessions' tasks; scoping is read-time");
	await reconcile(cwd, settings);
	await sleep(150);
	const st = await readState(p, cwd);
	const ids = Object.keys(st.tasks);
	if (ids.length >= 2) ok(`registry holds ${ids.length} tasks across sessions`);
	else bad(`expected >=2 tasks, got ${ids.length}`);

	console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
} catch (err) {
	console.error("TEST ERROR:", err);
	fail++;
} finally {
	try { await rm(cwd, { recursive: true, force: true }); } catch {}
}
process.exit(fail === 0 ? 0 : 1);
