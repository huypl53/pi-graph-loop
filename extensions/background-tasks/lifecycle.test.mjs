// Deterministic integration test for the background-tasks lifecycle (imports the REAL .ts via jiti).
// Run: node extensions/background-tasks/lifecycle.test.mjs
// Validates: spawn + exit marker (case 1), non-zero exit, timeout group-kill (case 2, no orphans),
// background_stop group-kill (no orphans), cross-task reconcile idempotency.
import { createJiti } from "jiti";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

const jiti = createJiti(import.meta.url);
const lib = await jiti.import("./src/lifecycle.ts");
const stateLib = await jiti.import("./src/state.ts");
const { spawnTask, killTask, reconcile, isAlive } = lib;
const { paths, readState } = stateLib;

const settings = {
	enabled: true,
	maxConcurrent: 8,
	logMaxBytes: 5 * 1024 * 1024,
	waitMaxMs: 120000,
	waitPollMs: 100,
	stopGraceMs: 800,
	killOnShutdown: false,
	ui: { enabled: false, refreshMs: 1000, maxRows: 8 },
};

let pass = 0;
let fail = 0;
const ok = (m) => { pass++; console.log("  ok   ", m); };
const bad = (m) => { fail++; console.error("  FAIL:", m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// count leftover processes matching a pattern (orphan check)
const countProcs = (pat) => {
	try {
		const out = execSync(`pgrep -fl ${JSON.stringify(pat)} 2>/dev/null || true`, { encoding: "utf8" });
		return out.split("\n").filter((l) => l.trim()).length;
	} catch {
		return 0;
	}
};

const cwd = await mkdtemp(join(tmpdir(), "bg-test-"));
console.log("test cwd:", cwd);
const p = paths(cwd);

async function waitTerminal(taskId, timeoutMs = 5000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		await reconcile(cwd, settings);
		const st = await readState(p, cwd);
		const t = st.tasks[taskId];
		if (t && ["done", "failed", "killed", "unknown"].includes(t.status)) return t;
		await sleep(80);
	}
	await reconcile(cwd, settings);
	return (await readState(p, cwd)).tasks[taskId];
}

try {
	// --- TC1: quick natural exit -> marker authoritative, status done, exit 0 ---
	console.log("\n[TC1] natural exit (echo)");
	const t1 = await spawnTask(cwd, settings, { command: "echo hello-bg", cwd, label: "quick" }, () => {});
	ok(`spawned ${t1.taskId} pid=${t1.pid}`);
	const r1 = await waitTerminal(t1.taskId);
	if (r1.status === "done" && r1.exitCode === 0) ok(`done exit 0 (status=${r1.status})`);
	else bad(`expected done/0, got ${r1.status}/${r1.exitCode}`);
	const markerRaw = await readFile(join(cwd, r1.exitMarker), "utf8").catch(() => "");
	if (markerRaw.includes('"exitCode":0')) ok("exit marker written (case 1 authoritative)");
	else bad("no exit marker: " + markerRaw);
	const outLog = await readFile(join(cwd, r1.logOut), "utf8").catch(() => "");
	if (outLog.includes("hello-bg")) ok("stdout captured hello-bg");
	else bad("stdout missing hello-bg: " + outLog);

	// --- TC2: non-zero exit -> failed, exit 3 ---
	console.log("\n[TC2] non-zero exit (exit 3)");
	const t2 = await spawnTask(cwd, settings, { command: "sh -c 'echo bye; exit 3'", cwd, label: "fail3" }, () => {});
	const r2 = await waitTerminal(t2.taskId);
	if (r2.status === "failed" && r2.exitCode === 3) ok(`failed exit 3 (status=${r2.status})`);
	else bad(`expected failed/3, got ${r2.status}/${r2.exitCode}`);

	// --- TC3: timeout group-kill -> killed, NO orphan sleep ---
	console.log("\n[TC3] timeout group-kill (sleep 30, timeout 1200ms)");
	const before = countProcs("sleep 30");
	const t3 = await spawnTask(cwd, settings, { command: "sleep 30", cwd, label: "slow", timeoutMs: 1200 }, () => {});
	ok(`spawned ${t3.taskId} pid=${t3.pid}; watchdog will group-kill at 1.2s`);
	const r3 = await waitTerminal(t3.taskId, 4000);
	if (r3.status === "killed") ok(`killed by watchdog (status=${r3.status})`);
	else bad(`expected killed, got ${r3.status} (exitCode=${r3.exitCode})`);
	await sleep(600); // let any stragglers settle
	const orphan = countProcs("sleep 30") - before;
	if (orphan === 0) ok("NO orphaned 'sleep 30' descendants (group-kill verified)");
	else bad(`${orphan} orphaned 'sleep 30' process(es) remain`);

	// --- TC4: background_stop group-kill -> killed, NO orphan ---
	console.log("\n[TC4] background_stop (sleep 40)");
	const before4 = countProcs("sleep 40");
	const t4 = await spawnTask(cwd, settings, { command: "sleep 40", cwd, label: "stopme" }, () => {});
	await sleep(300);
	const stopped = await killTask(cwd, t4.taskId, "SIGTERM", settings.stopGraceMs);
	if (stopped.status === "killed") ok(`stopped -> killed (status=${stopped.status})`);
	else bad(`expected killed, got ${stopped.status}`);
	const r4 = await waitTerminal(t4.taskId, 3000);
	if (r4.status === "killed") ok(`finalize confirmed killed`);
	else bad(`finalize status ${r4.status}`);
	await sleep(600);
	const orphan4 = countProcs("sleep 40") - before4;
	if (orphan4 === 0) ok("NO orphaned 'sleep 40' descendants");
	else bad(`${orphan4} orphaned 'sleep 40' process(es) remain`);

	// --- TC5: concurrency + idempotent reconcile does not regress terminal tasks ---
	console.log("\n[TC5] reconcile idempotency");
	await reconcile(cwd, settings);
	await reconcile(cwd, settings);
	const st5 = await readState(p, cwd);
	const t1b = st5.tasks[t1.taskId];
	if (t1b.status === "done") ok("reconcile did not regress done task");
	else bad(`regressed: ${t1b.status}`);
	if (Object.keys(st5.tasks).length >= 4) ok(`state holds ${Object.keys(st5.tasks).length} tasks`);
	else bad(`expected >=4 tasks, got ${Object.keys(st5.tasks).length}`);

	// --- TC6: liveness helper ---
	console.log("\n[TC6] isAlive");
	if (isAlive(process.pid)) ok("isAlive(self)=true");
	if (!isAlive(999999)) ok("isAlive(bogus)=false");

	console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
} catch (err) {
	console.error("TEST ERROR:", err);
	fail++;
} finally {
	try {
		await rm(cwd, { recursive: true, force: true });
	} catch {}
}

process.exit(fail === 0 ? 0 : 1);
