// Deterministic test for background_watch: register/list/cancel + the tick evaluator in renderUi
// (mock pi + ctx; real state.ts/watchers.ts/ui.ts/lifecycle.ts). Includes a real tcp listener for
// the port trigger. Run: node extensions/background-tasks/watcher.test.mjs
import { createJiti } from "jiti";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as net from "node:net";

const jiti = createJiti(import.meta.url);
const ui = await jiti.import("./src/ui.ts");
const stateLib = await jiti.import("./src/state.ts");
const watchersLib = await jiti.import("./src/watchers.ts");
const lifecycleLib = await jiti.import("./src/lifecycle.ts");
const { renderUi } = ui;
const { paths, readState, writeState } = stateLib;
const { registerWatcher, listWatchers, cancelWatcher } = watchersLib;
const { pruneTerminal } = lifecycleLib;

const settings = {
	enabled: true, maxConcurrent: 8, logMaxBytes: 5 * 1024 * 1024, waitMaxMs: 120000, waitPollMs: 100,
	stopGraceMs: 800, killOnShutdown: false, scopeBySession: true,
	ui: { enabled: true, refreshMs: 1000, maxRows: 8 },
	watch: { enabled: true, maxPerSession: 32, refireMs: 200, portTimeoutMs: 250, patternMaxLen: 240, rangeReadBytes: 512 * 1024 },
};

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log("  ok   ", m); };
const bad = (m) => { fail++; console.error("  FAIL:", m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const cwd = await mkdtemp(join(tmpdir(), "bg-watch-"));
const p = paths(cwd);
const logDir = join(cwd, ".pi/background-tasks/logs");

async function seedTask(taskId, { status = "running", session = "sessA" } = {}) {
	const st = await readState(p, cwd);
	st.tasks[taskId] = {
		taskId, label: taskId, status, command: "echo x", shell: true, cwd,
		startedAt: new Date(Date.now() - 5000).toISOString(),
		exitCode: status === "done" ? 0 : status === "failed" ? 2 : undefined,
		spawnedByPid: 1, spawnedBySession: session, kind: "shell",
		logOut: `.pi/background-tasks/logs/${taskId}.out.log`, logErr: `.pi/background-tasks/logs/${taskId}.err.log`,
		exitMarker: `.pi/background-tasks/tasks/${taskId}.exit`, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
	};
	await writeState(p, st);
}
async function appendOut(taskId, text) {
	await mkdir(logDir, { recursive: true });
	await writeFile(join(logDir, `${taskId}.out.log`), text, { flag: "a" });
}
function mockCtx({ idle = true, session = "sessA", mode = "tui" } = {}) {
	return {
		mode, cwd, hasUI: true, isIdle: () => idle,
		sessionManager: { getSessionId: () => session },
		ui: { setStatus() {}, setWidget() {}, notify() {} },
	};
}
function mockPi() {
	const sent = [];
	return { sent, sendUserMessage: (content) => sent.push(content) };
}

function startServer() {
	return new Promise((resolve) => {
		const srv = net.createServer();
		srv.listen(0, "127.0.0.1", () => resolve(srv));
	});
}

try {
	// [W1] validation: no trigger / multiple triggers / bad pattern / bad port
	console.log("[W1] registration validation");
	await seedTask("w1");
	let thrown = false;
	try { await registerWatcher(cwd, settings, { taskId: "w1", session: "sessA" }); } catch { thrown = true; }
	thrown ? ok("rejects: no trigger at all") : bad("accepted a trigger-less watch");
	thrown = false;
	try { await registerWatcher(cwd, settings, { taskId: "w1", pattern: "Ready", port: 3000, session: "sessA" }); } catch { thrown = true; }
	thrown ? ok("rejects: two triggers") : bad("accepted two triggers");
	thrown = false;
	try { await registerWatcher(cwd, settings, { taskId: "w1", pattern: "(unclosed", session: "sessA" }); } catch { thrown = true; }
	thrown ? ok("rejects: invalid regex") : bad("accepted invalid regex");
	thrown = false;
	try { await registerWatcher(cwd, settings, { taskId: "w1", port: 99999, session: "sessA" }); } catch { thrown = true; }
	thrown ? ok("rejects: port out of range") : bad("accepted port 99999");

	// [W2] pattern readiness: existing output fires on the first scan
	console.log("\n[W2] pattern watcher fires immediately on existing (readiness) output");
	await seedTask("w2");
	await appendOut("w2", "booting...\n  ➜  Local:   Ready on http://localhost:5173/\n");
	const w2 = await registerWatcher(cwd, settings, { taskId: "w2", pattern: "Ready on", session: "sessA" });
	if (w2.trigger === "pattern" && w2.status === "armed") ok("registered armed pattern watcher");
	else bad(`bad registration: ${JSON.stringify(w2)}`);
	const pi2 = mockPi();
	await renderUi(pi2, mockCtx({ idle: true, session: "sessA" }), settings, cwd);
	if (pi2.sent.length === 1 && pi2.sent[0].includes("w2") && pi2.sent[0].includes("MATCHED")) ok("nudge sent on first scan with reason + id");
	else bad(`expected 1 matched nudge, got: ${JSON.stringify(pi2.sent)}`);
	if (pi2.sent[0].includes("Ready on")) ok("nudge body includes the matched snippet");
	else bad("nudge missing snippet");
	// once:true => delivered => watcher deleted from state
	const list2 = await listWatchers(cwd, { session: "sessA", scopeBySession: true });
	if (list2.length === 0) ok("once:true watcher deleted after delivery");
	else bad(`once watcher should be gone, got ${list2.length}`);

	// [W3] new-output-only: registering on an empty log does not fire until NEW matching output
	console.log("\n[W3] only NEW matching output fires (post-registration output)");
	await seedTask("w3");
	const w3 = await registerWatcher(cwd, settings, { taskId: "w3", pattern: "DONE", session: "sessA" });
	const pi3a = mockPi();
	await renderUi(pi3a, mockCtx({ idle: true, session: "sessA" }), settings, cwd);
	if (pi3a.sent.length === 0) ok("no fire before matching output exists");
	else bad(`fired prematurely: ${JSON.stringify(pi3a.sent)}`);
	await appendOut("w3", "compiling...\nBUILD DONE\n");
	const pi3b = mockPi();
	await renderUi(pi3b, mockCtx({ idle: true, session: "sessA" }), settings, cwd);
	if (pi3b.sent.length === 1 && pi3b.sent[0].includes("DONE")) ok("fired on new matching output");
	else bad(`expected fire on new output, got: ${JSON.stringify(pi3b.sent)}`);

	// [W4] continuous (once:false) refires on NEW matches, rate-limited
	console.log("\n[W4] continuous refires on new matches, rate-limited by refireMs");
	await seedTask("w4");
	const w4 = await registerWatcher(cwd, settings, { taskId: "w4", pattern: "tick", once: false, session: "sessA" });
	await appendOut("w4", "tick-1\n");
	const pi4a = mockPi();
	await renderUi(pi4a, mockCtx({ idle: true, session: "sessA" }), settings, cwd);
	if (pi4a.sent.length === 1) ok("continuous: first match fires");
	else bad(`expected first fire, got ${pi4a.sent.length}`);
	// immediately add more matching output and re-tick: rate-limited (refireMs=200ms)
	await appendOut("w4", "tick-2\n");
	const pi4b = mockPi();
	await renderUi(pi4b, mockCtx({ idle: true, session: "sessA" }), settings, cwd);
	if (pi4b.sent.length === 0) ok("continuous: refire suppressed within refireMs");
	else bad(`expected rate-limit, got ${pi4b.sent.length}`);
	// after refireMs elapses + new matching output => refires
	await sleep(260);
	await appendOut("w4", "tick-3\n");
	const pi4c = mockPi();
	await renderUi(pi4c, mockCtx({ idle: true, session: "sessA" }), settings, cwd);
	if (pi4c.sent.length === 1) ok("continuous: refires after refireMs with new match");
	else bad(`expected refire, got ${pi4c.sent.length}`);
	const w4now = (await listWatchers(cwd, { session: "sessA" })).find((w) => w.watchId === w4.watchId);
	if (w4now && w4now.status === "armed") ok("continuous watcher stays armed");
	else bad(`continuous should remain armed, status=${w4now?.status}`);
	await cancelWatcher(cwd, { watchId: w4.watchId });

	// [W5] idle trigger: fires after idleMs with no new output
	console.log("\n[W5] idle trigger fires after idleMs of silence");
	await seedTask("w5");
	const w5 = await registerWatcher(cwd, settings, { taskId: "w5", idleMs: 150, session: "sessA" });
	// a tick right after registration: lastOutputAt ~= now => not yet idle
	const pi5a = mockPi();
	await renderUi(pi5a, mockCtx({ idle: true, session: "sessA" }), settings, cwd);
	if (pi5a.sent.length === 0) ok("idle: no fire immediately after registration");
	else bad(`idle fired too early: ${pi5a.sent.length}`);
	await sleep(180); // exceed idleMs with no output
	const pi5b = mockPi();
	await renderUi(pi5b, mockCtx({ idle: true, session: "sessA" }), settings, cwd);
	if (pi5b.sent.length === 1 && pi5b.sent[0].includes("no new output")) ok("idle: fired after silence threshold");
	else bad(`idle should fire after threshold, got: ${JSON.stringify(pi5b.sent)}`);

	// [W6] port trigger: fires when a real listener accepts on 127.0.0.1
	console.log("\n[W6] port trigger fires when the port is accepting");
	await seedTask("w6");
	const srv = await startServer();
	const port = (srv.address()).port;
	const w6 = await registerWatcher(cwd, settings, { taskId: "w6", port, session: "sessA" });
	const pi6 = mockPi();
	await renderUi(pi6, mockCtx({ idle: true, session: "sessA" }), settings, cwd);
	if (pi6.sent.length === 1 && pi6.sent[0].includes(`port ${port} is open`)) ok("port: fired when listener accepted");
	else bad(`port should fire, got: ${JSON.stringify(pi6.sent)}`);
	srv.close();
	await cancelWatcher(cwd, { watchId: w6.watchId });

	// [W7] session scope: another session's watcher is not evaluated/nudged here
	console.log("\n[W7] session-scoped — other session's watcher not nudged");
	await seedTask("w7", { session: "sessOTHER" });
	await registerWatcher(cwd, settings, { taskId: "w7", pattern: "Ready", session: "sessOTHER" }).catch(() => {});
	await appendOut("w7", "Ready\n");
	const pi7 = mockPi();
	await renderUi(pi7, mockCtx({ idle: true, session: "sessA" }), settings, cwd);
	if (pi7.sent.length === 0) ok("other session's watcher not nudged in sessA");
	else bad(`should not nudge other session: ${JSON.stringify(pi7.sent)}`);
	// but it IS nudged in its own session
	const pi7b = mockPi();
	await renderUi(pi7b, mockCtx({ idle: true, session: "sessOTHER" }), settings, cwd);
	if (pi7b.sent.length === 1) ok("watcher nudged in its own session");
	else bad(`own session should nudge, got ${pi7b.sent.length}`);

	// [W8] unwatch by taskId cancels all monitors for that task
	console.log("\n[W8] unwatch by taskId cancels all monitors for a task");
	await seedTask("w8");
	await registerWatcher(cwd, settings, { taskId: "w8", pattern: "a", once: false, session: "sessA" });
	await registerWatcher(cwd, settings, { taskId: "w8", pattern: "b", once: false, session: "sessA" });
	const before = (await listWatchers(cwd, { session: "sessA" })).filter((w) => w.taskId === "w8").length;
	if (before === 2) ok("two monitors registered for w8");
	else bad(`expected 2, got ${before}`);
	const { cancelled } = await cancelWatcher(cwd, { taskId: "w8", session: "sessA" });
	if (cancelled === 2) ok("unwatch by taskId cancelled both");
	else bad(`expected 2 cancelled, got ${cancelled}`);

	// [W9] prune drops watchers for pruned tasks
	console.log("\n[W9] prune removes watchers of pruned tasks");
	await seedTask("w9", { status: "done" });
	await registerWatcher(cwd, settings, { taskId: "w9", pattern: "x", once: false, session: "sessA" });
	const res = await pruneTerminal(cwd, { sid: "sessA", scopeBySession: true });
	if (res.removed === 1) ok("prune removed 1 terminal task");
	else bad(`prune removed ${res.removed}`);
	const after = (await listWatchers(cwd, { session: "sessA" })).filter((w) => w.taskId === "w9").length;
	if (after === 0) ok("prune also dropped the watcher for the pruned task");
	else bad(`watcher survived prune: ${after}`);

	// [W10] busy => deferred: pending nudge held until an idle tick
	console.log("\n[W10] busy => deferred, delivered on next idle tick");
	await seedTask("w10");
	await appendOut("w10", "Ready\n");
	await registerWatcher(cwd, settings, { taskId: "w10", pattern: "Ready", session: "sessA" });
	const pi10busy = mockPi();
	await renderUi(pi10busy, mockCtx({ idle: false, session: "sessA" }), settings, cwd);
	if (pi10busy.sent.length === 0) ok("busy: no nudge sent");
	else bad(`should not nudge while busy: ${pi10busy.sent.length}`);
	const pi10idle = mockPi();
	await renderUi(pi10idle, mockCtx({ idle: true, session: "sessA" }), settings, cwd);
	if (pi10idle.sent.length === 1) ok("deferred nudge delivered on next idle tick");
	else bad(`deferred delivery failed: ${pi10idle.sent.length}`);

	console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
} catch (err) {
	console.error("TEST ERROR:", err);
	fail++;
} finally {
	try { await rm(cwd, { recursive: true, force: true }); } catch {}
}
process.exit(fail === 0 ? 0 : 1);
