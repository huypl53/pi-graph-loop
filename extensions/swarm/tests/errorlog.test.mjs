#!/usr/bin/env node
/**
 * errorlog.test.mjs — AGENTS.md "no silent swallows" mandate (2026-09-08).
 *
 * Reproduces the bug class reported at extensions/swarm/src/trace.ts#170-172: best-effort
 * catches in extensions/swarm/ swallowed errors with `catch {}`, so a broken durable write
 * (EISDIR/EACCES/ENOSPC on traces/events.jsonl) was completely invisible.
 *
 * Contract under test:
 *   1. extensions/swarm/src/errorlog.ts exists and appends durable JSONL lines to
 *      .pi/swarm/traces/errors.jsonl (event=internal.error, source/op/error fields).
 *   2. The evidence hook (registerEvidenceHooks) routes an events.jsonl append failure into
 *      the error log instead of swallowing it (op=evidence.append_failed).
 *   3. writeBaselineCommit routes a git exec failure into the error log
 *      (op=baseline.git_exec_failed).
 *   4. logSwarmError is self-silent: an unwritable target never throws.
 *   5. PI_SWARM_ERRORLOG_MAX_ENTRIES=0 disables logging (loop-spill guard).
 *
 * Run: node extensions/swarm/tests/errorlog.test.mjs
 */
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const scratch = await mkdtemp(join(tmpdir(), `swarm-errorlog-${process.pid}-${Date.now()}`));
const originalCwd = process.cwd();
process.chdir(scratch); // module-level helpers without a Paths handle log via process.cwd()

let pass = 0,
	fail = 0;
const ok = (name, cond, detail) => {
	if (cond) {
		pass++;
		console.log("  ok  ", name);
	} else {
		fail++;
		console.error("  FAIL", name, detail !== undefined ? `(${JSON.stringify(detail).slice(0, 300)})` : "");
	}
};
const errorsFile = join(scratch, ".pi", "swarm", "traces", "errors.jsonl");
const readErrors = async () => {
	if (!existsSync(errorsFile)) return [];
	return (await readFile(errorsFile, "utf8"))
		.split("\n")
		.filter((l) => l.trim())
		.map((l) => JSON.parse(l));
};

// --- 1. errorlog module exists (RED before the fix: ERR_MODULE_NOT_FOUND) ------------------
let errorlog = null;
try {
	errorlog = await import(join(here, "..", "src", "errorlog.ts"));
} catch (err) {
	ok("errorlog module exists", false, String(err?.message || err));
}
if (errorlog) {
	ok("errorlog module exists", true);
	ok("exports logSwarmError", typeof errorlog.logSwarmError === "function");
	ok("exports logSwarmErrorTrace", typeof errorlog.logSwarmErrorTrace === "function");
	ok("exports expected marker", typeof errorlog.expected === "function");
}

if (errorlog) {
	// --- 2. logSwarmError writes a durable internal.error line -----------------------------
	await errorlog.logSwarmError(scratch, "test", "unit.probe", new Error("boom-1"), { extraKey: 42 });
	let lines = await readErrors();
	ok("internal.error line written", lines.length === 1, { lines: lines.length });
	ok("record has event=internal.error", lines[0]?.event === "internal.error");
	ok("record has source/op", lines[0]?.source === "test" && lines[0]?.op === "unit.probe", lines[0]);
	ok("record has error text", String(lines[0]?.error || "").includes("boom-1"), lines[0]);
	ok("record has ts", typeof lines[0]?.ts === "string" && lines[0].ts.length > 0);
	ok("record carries extra fields", lines[0]?.extraKey === 42, lines[0]);

	// --- 3. self-silent: unwritable target never throws ------------------------------------
	const blocked = join(scratch, "blocked-file");
	await writeFile(blocked, "i am a file\n");
	let threw = null;
	try {
		await errorlog.logSwarmError(join(blocked, "not-a-dir"), "test", "unit.blocked", new Error("boom-2"));
	} catch (err) {
		threw = err;
	}
	ok("unwritable target does not throw", threw === null, threw && String(threw));

	// --- 4. evidence hook routes append failure into the error log (the reported bug) ------
	const traceMod = await import(join(here, "..", "src", "trace.ts"));
	const handlers = new Map();
	const fakePi = { on: (name, fn) => handlers.set(name, fn) };
	await traceMod.registerEvidenceHooks(fakePi);
	const handler = handlers.get("tool_execution_end");
	ok("tool_execution_end handler registered", typeof handler === "function");

	// Make the events.jsonl append fail deterministically: events.jsonl is a DIRECTORY, so
	// appendFile gets EISDIR while the sibling errors.jsonl append still succeeds.
	const tracesDir = join(scratch, ".pi", "swarm", "traces");
	await mkdir(join(tracesDir, "events.jsonl"), { recursive: true });
	let hookThrew = null;
	try {
		await handler({ toolName: "Bash", isError: false }, { cwd: scratch });
	} catch (err) {
		hookThrew = err;
	}
	ok("evidence hook never throws (tool execution not blocked)", hookThrew === null, hookThrew && String(hookThrew));
	const afterHook = await readErrors();
	const evidenceFailure = afterHook.find((r) => r.op === "evidence.append_failed");
	ok("evidence append failure is visible in errors.jsonl (was silently swallowed)", Boolean(evidenceFailure), {
		ops: afterHook.map((r) => r.op),
	});
	ok("evidence failure names the tool", String(evidenceFailure?.tool || "").includes("Bash"), evidenceFailure);

	// --- 5. writeBaselineCommit routes git exec failure into the error log -----------------
	const baselineBefore = (await readErrors()).length;
	const fakePiExecThrow = {
		exec: async () => {
			throw new Error("git-not-running");
		},
	};
	const tp = { root: join(scratch, "task-x") };
	// Real call sites thread ctx.cwd (see tools/tasks.ts) so the failure lands in the PROJECT
	// error log, not under the task dir.
	const res = await traceMod.writeBaselineCommit(fakePiExecThrow, tp, scratch);
	ok("writeBaselineCommit still returns available:false", res?.available === false, res);
	const afterBaseline = await readErrors();
	const baselineFailure = afterBaseline.find((r) => r.op === "baseline.git_exec_failed");
	ok(
		"baseline git failure is visible in errors.jsonl (was silently swallowed)",
		Boolean(baselineFailure) && afterBaseline.length > baselineBefore,
		{ ops: afterBaseline.map((r) => r.op) },
	);

	// --- 6. budget guard: PI_SWARM_ERRORLOG_MAX_ENTRIES=0 disables logging ------------------
	process.env.PI_SWARM_ERRORLOG_MAX_ENTRIES = "0";
	errorlog.resetErrorLogBudgetForTests();
	const beforeBudget = (await readErrors()).length;
	await errorlog.logSwarmError(scratch, "test", "unit.budget", new Error("boom-3"));
	const afterBudget = (await readErrors()).length;
	ok("budget=0 disables further logging", afterBudget === beforeBudget, { beforeBudget, afterBudget });
	delete process.env.PI_SWARM_ERRORLOG_MAX_ENTRIES;
	errorlog.resetErrorLogBudgetForTests();
}

// --- 7. no NEW silent swallows in the fixed hot spots (static assertion) -------------------
// The trace.ts evidence hook must not have a bare `catch {` without error logging anymore.
{
	const traceSrc = await readFile(join(here, "..", "src", "trace.ts"), "utf8");
	const evidenceHookBody = traceSrc.slice(traceSrc.indexOf("registerEvidenceHooks"));
	ok(
		"evidence hook catch routes to errorlog (logSwarmError/evidence.append_failed)",
		evidenceHookBody.includes("logSwarmError") && evidenceHookBody.includes("evidence.append_failed"),
	);
}

console.log(`\nERRORLOG ${fail === 0 ? "PASS" : "FAIL"} (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
