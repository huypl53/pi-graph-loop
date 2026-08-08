// Deterministic test for the parent-death watchdog (task lifetime == spawning pi process lifetime).
// A forked helper acts as a short-lived "pi": it spawns a task then exits. We then assert:
//   - survive:false (default) → the watchdog kills the task once the helper exits.
//   - survive:true            → no watchdog, so the daemon KEEPS RUNNING after the helper exits.
//   - reload-survival is covered structurally: the watchdog keys on the pi PROCESS pid, so as long
//     as that process stays alive (a /reload) the parent never changes and the task is left alone.
// Run: node extensions/background-tasks/watchdog.test.mjs
import { mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
// (was fork() — fork mandates an IPC channel we don't need; spawn(node, [helper]) is enough)
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const lib = await jiti.import("./src/lifecycle.ts");
const stateLib = await jiti.import("./src/state.ts");
const { killTask } = lib;
const { paths } = stateLib;

const settings = {
	enabled: true, maxConcurrent: 8, logMaxBytes: 5 * 1024 * 1024, waitMaxMs: 120000, waitPollMs: 100,
	stopGraceMs: 800, killOnShutdown: false, scopeBySession: false, ui: { enabled: false, refreshMs: 1000, maxRows: 8 },
};
const helper = join(dirname(fileURLToPath(import.meta.url)), "watchdog-spawn-helper.mjs");

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log("  ok   ", m); };
const bad = (m) => { fail++; console.error("  FAIL:", m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Count live processes whose full command line matches a pattern (orphan / survival check).
const countProcs = (pat) => {
	try {
		const out = execSync(`pgrep -fl ${JSON.stringify(pat)} 2>/dev/null || true`, { encoding: "utf8" });
		return out.split("\n").filter((l) => l.trim()).length;
	} catch {
		return 0;
	}
};

// Spawn the helper (a short-lived "pi") and resolve the taskId it prints to stdout.
function spawnViaShortLivedPi(env) {
	return new Promise((resolve, reject) => {
		let out = "";
		const child = spawn(process.execPath, [helper], {
			env: { ...process.env, ...env },
			stdio: ["ignore", "pipe", "pipe"],
		});
		child.stdout.on("data", (d) => (out += d.toString()));
		child.on("error", reject);
		child.on("exit", (_code) => resolve(out.trim()));
	});
}

const cwd = await mkdtemp(join(tmpdir(), "bg-wd-"));
const p = paths(cwd);

try {
	// [WD1] survive:false (default) → task is KILLED once its spawning pi (helper) exits.
	console.log("[WD1] default task dies when its spawning pi exits (watchdog)");
	const dieCmd = "sleep 1337";
	const before1 = countProcs(dieCmd);
	const tid1 = await spawnViaShortLivedPi({
		BG_TEST_CWD: cwd, BG_TEST_SETTINGS: JSON.stringify(settings),
		BG_TEST_CMD: dieCmd, BG_TEST_LABEL: "wd-die", BG_TEST_SURVIVE: "0",
	});
	if (tid1) ok(`spawned ${tid1} via short-lived pi`);
	else bad("no taskId returned from helper");
	// Poll until the process is gone (watchdog polls every 3s + a 2s kill grace).
	let gone = false;
	for (let i = 0; i < 12; i++) {
		await sleep(1000);
		if (countProcs(dieCmd) <= before1) { gone = true; break; }
	}
	if (gone) ok("default task was killed by the watchdog once its pi exited");
	else bad(`default task still running after ~12s (orphan!) — count=${countProcs(dieCmd)}`);

	// [WD2] survive:true → daemon KEEPS RUNNING after its spawning pi exits.
	console.log("\n[WD2] survive:true daemon outlives its spawning pi");
	const liveCmd = "sleep 1338";
	const before2 = countProcs(liveCmd);
	const tid2 = await spawnViaShortLivedPi({
		BG_TEST_CWD: cwd, BG_TEST_SETTINGS: JSON.stringify(settings),
		BG_TEST_CMD: liveCmd, BG_TEST_LABEL: "wd-live", BG_TEST_SURVIVE: "1",
	});
	if (tid2) ok(`spawned ${tid2} (survive) via short-lived pi`);
	else bad("no taskId returned from helper");
	await sleep(5000); // well past one watchdog poll interval — a buggy watchdog would have killed it
	const stillAlive = countProcs(liveCmd) - before2;
	if (stillAlive >= 1) ok(`survive:true daemon still running after its pi died (${stillAlive})`);
	else bad("survive:true daemon was wrongly killed");
	// Clean up the daemon via explicit stop (also proves explicit stop works on survive tasks).
	try {
		await killTask(cwd, tid2, "SIGTERM", settings.stopGraceMs);
		ok("explicitly stopped the survive daemon (cleanup)");
	} catch (err) {
		execSync(`pkill -f ${JSON.stringify(liveCmd)} 2>/dev/null || true`);
		bad(`killTask failed: ${err}`);
	}

	// [WD3] survive flag is persisted on the record (so it survives /reload of the spawning pi).
	console.log("\n[WD3] survive flag persisted on the task record");
	const st = await stateLib.readState(p, cwd);
	// (records may have been finalized/reaped by reconcile in other tests; re-seed a quick check)
	{
		const { spawnTask } = lib;
		const t = await spawnTask(cwd, settings, { command: "sleep 10", cwd, label: "wd-persist", survive: true }, () => {});
		const fresh = await stateLib.readState(p, cwd);
		if (fresh.tasks[t.taskId]?.survive === true) ok("survive:true persisted to state.json");
		else bad(`survive not persisted: ${JSON.stringify(fresh.tasks[t.taskId]?.survive)}`);
		await killTask(cwd, t.taskId, "SIGKILL", 100);
	}

	console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
} catch (err) {
	console.error("TEST ERROR:", err);
	fail++;
} finally {
	try { await rm(cwd, { recursive: true, force: true }); } catch {}
	// belt-and-suspenders: never leave the probe sleeps behind
	execSync("pkill -f 'sleep 1337' 2>/dev/null || true");
	execSync("pkill -f 'sleep 1338' 2>/dev/null || true");
}
process.exit(fail === 0 ? 0 : 1);
