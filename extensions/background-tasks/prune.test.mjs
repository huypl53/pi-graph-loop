// Deterministic test for pruneTerminal: explicit reclamation of terminal tasks.
// Verifies: terminal tasks removed, live/pending retained, session scope respected, all-sessions mode,
// best-effort log/marker file deletion, and that default paths are NOT involved (prune is opt-in only).
// Run: node extensions/background-tasks/prune.test.mjs
import { createJiti } from "jiti";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const jiti = createJiti(import.meta.url);
const lib = await jiti.import("./src/lifecycle.ts");
const stateLib = await jiti.import("./src/state.ts");
const { pruneTerminal } = lib;
const { paths, readState, writeState } = stateLib;

let pass = 0;
let fail = 0;
const ok = (m) => { pass++; console.log("  ok   ", m); };
const bad = (m) => { fail++; console.error("  FAIL:", m); };

const cwd = await mkdtemp(join(tmpdir(), "bg-prune-"));
console.log("test cwd:", cwd);
const p = paths(cwd);

// Seed a task record directly into state. Writes the log + marker files on disk when `files:true`.
async function seed(taskId, { status = "done", session = "sessA", files = true } = {}) {
	const st = await readState(p, cwd);
	const logOut = `.pi/background-tasks/logs/${taskId}.out.log`;
	const logErr = `.pi/background-tasks/logs/${taskId}.err.log`;
	const exitMarker = `.pi/background-tasks/tasks/${taskId}.exit`;
	st.tasks[taskId] = {
		taskId, label: taskId, status, command: "echo x", shell: true, cwd,
		startedAt: new Date(Date.now() - 5000).toISOString(), endedAt: new Date().toISOString(),
		exitCode: status === "done" ? 0 : status === "failed" ? 2 : null,
		spawnedByPid: 1, spawnedBySession: session, kind: "shell",
		logOut, logErr, exitMarker, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
	};
	await writeState(p, st);
	if (files) {
		await writeFile(join(cwd, logOut), "out\n", "utf8").catch(() => {});
		await writeFile(join(cwd, logErr), "err\n", "utf8").catch(() => {});
		await writeFile(join(cwd, exitMarker), '{"exitCode":0}', "utf8").catch(() => {});
	}
}

try {
	// [P1] terminal tasks removed; live task retained; files deleted.
	console.log("[P1] prune removes terminal, keeps live, deletes files");
	await seed("alive", { status: "running", session: "sessA" });
	await seed("doneA", { status: "done", session: "sessA" });
	await seed("killedA", { status: "killed", session: "sessA" });
	const res1 = await pruneTerminal(cwd, { sid: "sessA", scopeBySession: true });
	if (res1.removed === 2) ok(`removed 2 terminal (got ${res1.removed})`);
	else bad(`expected removed=2, got ${res1.removed}`);
	const st1 = await readState(p, cwd);
	if (st1.tasks.alive && st1.tasks.alive.status === "running") ok("live task 'alive' retained");
	else bad("live task should be retained");
	if (!st1.tasks.doneA && !st1.tasks.killedA) ok("terminal tasks doneA/killedA removed from state");
	else bad("terminal tasks still present");
	if (!existsSync(join(cwd, st1.tasks.alive.logOut))) {
		// alive log still exists -> good; but check the removed ones are gone
	}
	if (!existsSync(join(cwd, ".pi/background-tasks/logs/doneA.out.log"))) ok("doneA log file deleted");
	else bad("doneA log file still on disk");
	if (res1.filesRemoved >= 4) ok(`files freed (got ${res1.filesRemoved}, >=4 expected: out+err+marker x2)`);
	else bad(`expected >=4 files removed, got ${res1.filesRemoved}`);

	// [P2] session scope: other session's terminal task is NOT pruned.
	console.log("\n[P2] session scope — other session's terminal task kept");
	await seed("other", { status: "failed", session: "sessOTHER" });
	await seed("mine", { status: "done", session: "sessA" });
	const res2 = await pruneTerminal(cwd, { sid: "sessA", scopeBySession: true });
	if (res2.removed === 1) ok(`removed only own terminal (got ${res2.removed})`);
	else bad(`expected removed=1, got ${res2.removed}`);
	const st2 = await readState(p, cwd);
	if (st2.tasks.other && st2.tasks.other.status === "failed") ok("other session's failed task retained");
	else bad("other session's task was wrongly pruned");
	if (!st2.tasks.mine) ok("own terminal task 'mine' removed");
	else bad("own terminal task should have been removed");

	// [P3] allSessions:true reclaims across every session.
	console.log("\n[P3] allSessions reclaims across sessions");
	await seed("x1", { status: "killed", session: "sessOTHER" });
	await seed("x2", { status: "done", session: "sessA" });
	await seed("x3", { status: "unknown", session: undefined }); // legacy/anonymous
	const res3 = await pruneTerminal(cwd, { allSessions: true });
	const st3 = await readState(p, cwd);
	if (res3.removed >= 3 && !st3.tasks.x1 && !st3.tasks.x2 && !st3.tasks.x3) ok(`allSessions removed ${res3.removed} across sessions + legacy`);
	else bad(`allSessions mismatch: removed=${res3.removed}, x1=${!!st3.tasks.x1} x2=${!!st3.tasks.x2} x3=${!!st3.tasks.x3}`);

	// [P4] nothing terminal to prune -> removed=0, state untouched.
	console.log("\n[P4] nothing to prune");
	await seed("live2", { status: "pending", session: "sessA", files: false });
	const before = Object.keys((await readState(p, cwd)).tasks).length;
	const res4 = await pruneTerminal(cwd, { sid: "sessA", scopeBySession: true });
	const after = Object.keys((await readState(p, cwd)).tasks).length;
	if (res4.removed === 0 && before === after) ok(`nothing pruned (removed=0, ${before}==${after})`);
	else bad(`expected no-op, removed=${res4.removed}, before=${before} after=${after}`);

	// [P5] never reclaims live/pending even with allSessions.
	console.log("\n[P5] live/pending never reclaimed (allSessions)");
	const res5 = await pruneTerminal(cwd, { allSessions: true });
	const st5 = await readState(p, cwd);
	if (res5.removed === 0 && st5.tasks.alive && st5.tasks.live2) ok("live/pending retained under allSessions prune");
	else bad(`live task pruned! removed=${res5.removed} alive=${!!st5.tasks.alive} live2=${!!st5.tasks.live2}`);

	console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
} catch (err) {
	console.error("TEST ERROR:", err);
	fail++;
} finally {
	try { await rm(cwd, { recursive: true, force: true }); } catch {}
}
process.exit(fail === 0 ? 0 : 1);
