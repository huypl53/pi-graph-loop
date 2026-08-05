// Deterministic test for the agent-completion nudge in renderUi (mock pi + ctx; real state.ts/ui.ts).
// Run: node extensions/background-tasks/nudge.test.mjs
import { createJiti } from "jiti";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const jiti = createJiti(import.meta.url);
const ui = await jiti.import("./src/ui.ts");
const stateLib = await jiti.import("./src/state.ts");
const { renderUi } = ui;
const { paths, readState, writeState } = stateLib;

const settings = {
	enabled: true, maxConcurrent: 8, logMaxBytes: 5 * 1024 * 1024, waitMaxMs: 120000, waitPollMs: 100,
	stopGraceMs: 800, killOnShutdown: false, scopeBySession: true, ui: { enabled: true, refreshMs: 1000, maxRows: 8 },
};

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log("  ok   ", m); };
const bad = (m) => { fail++; console.error("  FAIL:", m); };

const cwd = await mkdtemp(join(tmpdir(), "bg-nudge-"));
const p = paths(cwd);

// Seed a terminal task owned by sessA that has NOT been nudged yet.
async function seedTask(taskId, { status = "done", session = "sessA", nudged } = {}) {
	const st = await readState(p, cwd);
	st.tasks[taskId] = {
		taskId, label: taskId, status, command: "echo x", shell: true, cwd,
		startedAt: new Date(Date.now() - 5000).toISOString(), endedAt: new Date().toISOString(),
		exitCode: status === "done" ? 0 : status === "failed" ? 2 : null,
		spawnedByPid: 1, spawnedBySession: session, kind: "shell",
		logOut: `.pi/background-tasks/logs/${taskId}.out.log`, logErr: `.pi/background-tasks/logs/${taskId}.err.log`,
		exitMarker: `.pi/background-tasks/tasks/${taskId}.exit`, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
		...(nudged ? { agentNudgedStatus: status, lastNotifiedStatus: status } : {}),
	};
	await writeState(p, st);
}

function mockCtx({ idle = true, session = "sessA", mode = "tui" } = {}) {
	return {
		mode, cwd,
		hasUI: true,
		isIdle: () => idle,
		sessionManager: { getSessionId: () => session },
		ui: { setStatus() {}, setWidget() {}, notify() {} },
	};
}
function mockPi() {
	const sent = [];
	return { sent, sendUserMessage: (content) => sent.push(content) };
}

try {
	// [N1] idle + terminal + own session => ONE nudge fired with task id + status + output hint.
	console.log("[N1] nudge fires once when idle");
	await seedTask("probe1", { status: "done", session: "sessA" });
	const pi1 = mockPi();
	await renderUi(pi1, mockCtx({ idle: true, session: "sessA" }), settings, cwd);
	if (pi1.sent.length === 1) ok("sendUserMessage called once");
	else bad(`expected 1 nudge, got ${pi1.sent.length}`);
	if (pi1.sent[0]?.includes("probe1") && pi1.sent[0].includes("done")) ok(`nudge body mentions probe1 + done`);
	else bad(`nudge body unexpected: ${pi1.sent[0]}`);
	if (pi1.sent[0]?.includes("background_output")) ok("nudge tells agent how to view output");
	else bad("nudge missing background_output hint");
	let st = await readState(p, cwd);
	if (st.tasks.probe1.agentNudgedStatus === "done") ok("agentNudgedStatus persisted = done");
	else bad(`agentNudgedStatus = ${st.tasks.probe1.agentNudgedStatus}`);

	// [N2] dedup: a second tick does NOT nudge again.
	console.log("\n[N2] dedup — second tick does not re-nudge");
	const pi2 = mockPi();
	await renderUi(pi2, mockCtx({ idle: true, session: "sessA" }), settings, cwd);
	if (pi2.sent.length === 0) ok("no re-nudge (deduped via persisted agentNudgedStatus)");
	else bad(`re-nudged ${pi2.sent.length} times`);

	// [N3] busy => deferred (not nudged, not marked) so a later idle tick retries.
	console.log("\n[N3] busy => deferred, agentNudgedStatus stays unset");
	await seedTask("probe2", { status: "failed", session: "sessA" });
	const pi3 = mockPi();
	await renderUi(pi3, mockCtx({ idle: false, session: "sessA" }), settings, cwd);
	if (pi3.sent.length === 0) ok("no nudge while busy");
	else bad(`nudged while busy: ${pi3.sent.length}`);
	st = await readState(p, cwd);
	if (st.tasks.probe2.agentNudgedStatus === undefined) ok("agentNudgedStatus NOT set (deferred)");
	else bad(`expected deferred (undefined), got ${st.tasks.probe2.agentNudgedStatus}`);
	// now idle tick should deliver it
	const pi3b = mockPi();
	await renderUi(pi3b, mockCtx({ idle: true, session: "sessA" }), settings, cwd);
	if (pi3b.sent.length === 1 && pi3b.sent[0].includes("failed")) ok("deferred task nudged on next idle tick");
	else bad(`deferred retry failed: ${JSON.stringify(pi3b.sent)}`);

	// [N4] session scope: a task owned by another session is NOT nudged here.
	console.log("\n[N4] session-scoped — other session's task not nudged");
	await seedTask("probe3", { status: "done", session: "sessOTHER" });
	const pi4 = mockPi();
	await renderUi(pi4, mockCtx({ idle: true, session: "sessA" }), settings, cwd);
	if (pi4.sent.length === 0) ok("other session's task not nudged in sessA");
	else bad(`should not nudge other session: ${JSON.stringify(pi4.sent)}`);

	// [N5] batch: multiple own terminal tasks => single combined nudge (one triggerTurn).
	console.log("\n[N5] batch — multiple completions => one combined nudge");
	await seedTask("batch1", { status: "done", session: "sessB" });
	await seedTask("batch2", { status: "failed", session: "sessB" });
	const pi5 = mockPi();
	await renderUi(pi5, mockCtx({ idle: true, session: "sessB" }), settings, cwd);
	if (pi5.sent.length === 1) ok("single combined nudge for a batch");
	else bad(`expected 1 combined nudge, got ${pi5.sent.length}`);
	if (pi5.sent[0]?.includes("2 background tasks finished")) ok("combined header present");
	else bad(`combined header missing: ${pi5.sent[0]}`);

	console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
} catch (err) {
	console.error("TEST ERROR:", err);
	fail++;
} finally {
	try { await rm(cwd, { recursive: true, force: true }); } catch {}
}
process.exit(fail === 0 ? 0 : 1);
