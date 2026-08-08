// Deterministic test that the DEFAULT below-editor widget surfaces LIVE tasks only.
// Verifies the user-facing fix: killed/exited tasks no longer clutter the default UI; they're hidden
// (not deleted). Terminal-only state clears the widget; the footer still summarises counts.
// Run: node extensions/background-tasks/ui-live.test.mjs
import { createJiti } from "jiti";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const jiti = createJiti(import.meta.url);
const ui = await jiti.import("./src/ui.ts");
const stateLib = await jiti.import("./src/state.ts");
const { renderUi, summaryLine } = ui;
const { paths, readState, writeState } = stateLib;

const settings = {
	enabled: true, maxConcurrent: 8, logMaxBytes: 5 * 1024 * 1024, waitMaxMs: 120000, waitPollMs: 100,
	stopGraceMs: 800, killOnShutdown: false, scopeBySession: true, ui: { enabled: true, refreshMs: 1000, maxRows: 8 },
};

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log("  ok   ", m); };
const bad = (m) => { fail++; console.error("  FAIL:", m); };

const cwd = await mkdtemp(join(tmpdir(), "bg-uilive-"));
const p = paths(cwd);

async function seed(taskId, { status = "done", session = "sessA", exitCode = null, nudged = true } = {}) {
	const st = await readState(p, cwd);
	st.tasks[taskId] = {
		taskId, label: taskId, status, command: `cmd-${taskId}`, shell: true, cwd,
		startedAt: new Date(Date.now() - 5000).toISOString(),
		endedAt: status === "running" ? undefined : new Date().toISOString(),
		exitCode, spawnedByPid: 1, spawnedBySession: session, kind: "shell",
		logOut: `.pi/background-tasks/logs/${taskId}.out.log`,
		logErr: `.pi/background-tasks/logs/${taskId}.err.log`,
		exitMarker: `.pi/background-tasks/tasks/${taskId}.exit`,
		createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
		// Pre-mark nudged so renderUi's nudge path doesn't fire sendUserMessage (out of scope here).
		...(nudged ? { agentNudgedStatus: status, lastNotifiedStatus: status } : {}),
	};
	await writeState(p, st);
}

// Capture setWidget calls; a factory fn => widget shown, undefined => cleared.
function mockCtx({ session = "sessA" } = {}) {
	const calls = [];
	return {
		calls,
		_c: {
			mode: "tui", cwd, hasUI: true, isIdle: () => false,
			sessionManager: { getSessionId: () => session },
			ui: {
				setStatus() {},
				notify() {},
				setWidget: (name, factory) => { calls.push({ name, factory }); },
			},
		},
	};
}
function mockPi() { return { sent: [], sendUserMessage: (c) => sent.push(c) }; }
const theme = { fg: (_c, s) => s };

try {
	// [W1] mix of live + terminal => widget renders ONLY the live task (1 task row).
	console.log("[W1] widget shows live tasks only (terminal hidden)");
	await seed("run1", { status: "running", exitCode: null });
	await seed("done1", { status: "done", exitCode: 0 });
	await seed("kill1", { status: "killed", exitCode: null });
	await seed("fail1", { status: "failed", exitCode: 2 });
	const m1 = mockCtx();
	await renderUi(mockPi(), m1._c, settings, cwd);
	const last = m1.calls[m1.calls.length - 1];
	if (typeof last.factory === "function") ok("widget rendered (factory passed, not undefined)");
	else bad(`expected widget factory, got ${typeof last.factory}`);
	if (typeof last.factory === "function") {
		const comp = last.factory({}, theme);
		// Each shown task => one Text child; live count here = 1 (run1). No "+more" row (1 <= maxRows).
		const taskRows = comp.children.length;
		if (taskRows === 1) ok(`exactly 1 widget row rendered (the live task); got ${taskRows}`);
		else bad(`expected 1 live row, got ${taskRows} (terminal tasks leaked into default UI)`);
	}

	// [W2] terminal-only state => widget CLEARED (setWidget undefined). The old bug: killed tasks lingered.
	console.log("\n[W2] terminal-only state clears the widget (no lingering killed tasks)");
	await seed("done2", { status: "done", exitCode: 0 });
	await seed("kill2", { status: "killed", exitCode: null });
	// remove the running task
	{
		const st = await readState(p, cwd);
		delete st.tasks.run1;
		await writeState(p, st);
	}
	const m2 = mockCtx();
	await renderUi(mockPi(), m2._c, settings, cwd);
	const last2 = m2.calls[m2.calls.length - 1];
	if (last2.factory === undefined) ok("widget cleared when no live tasks (no killed-task clutter)");
	else bad(`expected setWidget(undefined), got ${typeof last2.factory}`);

	// [W3] footer summary still reports finished counts (awareness preserved, just not in the list).
	console.log("\n[W3] footer summary still surfaces finished counts");
	{
		const st = await readState(p, cwd);
		const s = summaryLine(st);
		if (s.includes("done") && !s.includes("running")) ok(`footer summarises finished only: "${s}"`);
		else bad(`footer summary unexpected: "${s}"`);
	}

	// [W4] a fresh live task re-shows the widget (hidden state is not sticky).
	console.log("\n[W4] new live task re-shows the widget");
	await seed("run2", { status: "running", exitCode: null });
	const m4 = mockCtx();
	await renderUi(mockPi(), m4._c, settings, cwd);
	const last4 = m4.calls[m4.calls.length - 1];
	if (typeof last4.factory === "function") ok("widget re-rendered for a new live task");
	else bad(`expected widget re-shown, got ${typeof last4.factory}`);

	console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
} catch (err) {
	console.error("TEST ERROR:", err);
	fail++;
} finally {
	try { await rm(cwd, { recursive: true, force: true }); } catch {}
}
process.exit(fail === 0 ? 0 : 1);
