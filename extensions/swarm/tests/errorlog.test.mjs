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

	// === G5: per-source budget cap (RED tests — fail before the fix) =====================
	// Helper: capture console.error calls during a block of work.
	const captureConsoleError = async (fn) => {
		const orig = console.error;
		const calls = [];
		console.error = (...args) => calls.push(args.join(" "));
		try {
			await fn();
		} finally {
			console.error = orig;
		}
		return calls;
	};

	// --- 8. per-source cap: noisy source saturates at PI_SWARM_ERRORLOG_PER_SOURCE_MAX ---
	{
		// Fresh scratch dir so prior writes don't pollute the count.
		const sub = join(scratch, "per-source-cap");
		await mkdir(join(sub, ".pi", "swarm", "traces"), { recursive: true });
		process.env.PI_SWARM_ERRORLOG_PER_SOURCE_MAX = "3";
		process.env.PI_SWARM_ERRORLOG_MAX_ENTRIES = "2000";
		errorlog.resetErrorLogBudgetForTests();
		if (typeof errorlog.resetErrorLogPerSourceForTests === "function") {
			errorlog.resetErrorLogPerSourceForTests();
		}
		const subErrorsFile = join(sub, ".pi", "swarm", "traces", "errors.jsonl");
		const readSub = async () =>
			(await readFile(subErrorsFile, "utf8"))
				.split("\n")
				.filter((l) => l.trim())
				.map((l) => JSON.parse(l));
		for (let i = 0; i < 5; i++) {
			await errorlog.logSwarmError(sub, "noisy", "cap.test", new Error(`boom-noisy-${i}`));
		}
		await errorlog.logSwarmError(sub, "quiet", "cap.test", new Error("boom-quiet-0"));
		const lines = await readSub();
		const noisyLines = lines.filter((r) => r.source === "noisy");
		const quietLines = lines.filter((r) => r.source === "quiet");
		ok(
			"per-source cap: noisy source retains exactly PI_SWARM_ERRORLOG_PER_SOURCE_MAX entries (first 3, drops new when saturated)",
			noisyLines.length === 3 && noisyLines[0]?.error?.includes("boom-noisy-0") && noisyLines[2]?.error?.includes("boom-noisy-2"),
			{ noisyCount: noisyLines.length, noisyErrors: noisyLines.map((r) => r.error) },
		);
		ok(
			"per-source cap: quiet source is NOT affected by noisy source's saturation",
			quietLines.length === 1 && quietLines[0]?.error?.includes("boom-quiet-0"),
			{ quietCount: quietLines.length, quietErrors: quietLines.map((r) => r.error) },
		);
		delete process.env.PI_SWARM_ERRORLOG_PER_SOURCE_MAX;
		errorlog.resetErrorLogBudgetForTests();
		if (typeof errorlog.resetErrorLogPerSourceForTests === "function") {
			errorlog.resetErrorLogPerSourceForTests();
		}
	}

	// --- 9. per-source breadcrumb: one console.error per exhaustion-cross, not per drop ---
	{
		const sub = join(scratch, "per-source-breadcrumb");
		await mkdir(join(sub, ".pi", "swarm", "traces"), { recursive: true });
		process.env.PI_SWARM_ERRORLOG_PER_SOURCE_MAX = "2";
		process.env.PI_SWARM_ERRORLOG_MAX_ENTRIES = "2000";
		errorlog.resetErrorLogBudgetForTests();
		if (typeof errorlog.resetErrorLogPerSourceForTests === "function") {
			errorlog.resetErrorLogPerSourceForTests();
		}
		const calls = await captureConsoleError(async () => {
			for (let i = 0; i < 4; i++) {
				await errorlog.logSwarmError(sub, "chatty", "crumb.test", new Error(`boom-chatty-${i}`));
			}
		});
		const perSourceCrumbs = calls.filter((c) => c.includes("per-source budget exhausted") && c.includes("chatty"));
		ok(
			"per-source breadcrumb: exactly 1 crumb for 4 appends with cap=2 (one per exhaustion-cross, not per drop)",
			perSourceCrumbs.length === 1,
			{ crumbCount: perSourceCrumbs.length, allCrumbs: calls },
		);
		delete process.env.PI_SWARM_ERRORLOG_PER_SOURCE_MAX;
		errorlog.resetErrorLogBudgetForTests();
		if (typeof errorlog.resetErrorLogPerSourceForTests === "function") {
			errorlog.resetErrorLogPerSourceForTests();
		}
	}

	// --- 10. global cap still wins: per-source cap cannot bypass global exhaustion ---------
	// Note: PI_SWARM_ERRORLOG_MAX_ENTRIES has a floor of MIN_ENTRIES=200, so we use 250 (above floor).
	// Per-source cap is set above global (300) so per-source never fires; the global cap is the
	// binding constraint. Write 250 entries from one source, then verify the 251st is dropped.
	{
		const sub = join(scratch, "global-still-wins");
		await mkdir(join(sub, ".pi", "swarm", "traces"), { recursive: true });
		process.env.PI_SWARM_ERRORLOG_MAX_ENTRIES = "250";
		process.env.PI_SWARM_ERRORLOG_PER_SOURCE_MAX = "300";
		errorlog.resetErrorLogBudgetForTests();
		if (typeof errorlog.resetErrorLogPerSourceForTests === "function") {
			errorlog.resetErrorLogPerSourceForTests();
		}
		// Write 250 entries from src-a to exhaust the global cap (per-source cap=300 never fires).
		for (let i = 0; i < 250; i++) {
			await errorlog.logSwarmError(sub, "src-a", "global.test", new Error(`a-${i}`));
		}
		// Now try to write the 251st — should be dropped by global cap.
		await errorlog.logSwarmError(sub, "src-a", "global.test", new Error("a-250-should-be-dropped"));
		const subErrorsFile = join(sub, ".pi", "swarm", "traces", "errors.jsonl");
		const lines = (await readFile(subErrorsFile, "utf8"))
			.split("\n")
			.filter((l) => l.trim())
			.map((l) => JSON.parse(l));
		ok(
			"global cap still wins: 251st entry is dropped when global=250 (per-source=300 cannot bypass)",
			lines.length === 250 && !lines.some((r) => r.error?.includes("a-250-should-be-dropped")),
			{ lineCount: lines.length, lastError: lines[lines.length - 1]?.error },
		);
		delete process.env.PI_SWARM_ERRORLOG_MAX_ENTRIES;
		delete process.env.PI_SWARM_ERRORLOG_PER_SOURCE_MAX;
		errorlog.resetErrorLogBudgetForTests();
		if (typeof errorlog.resetErrorLogPerSourceForTests === "function") {
			errorlog.resetErrorLogPerSourceForTests();
		}
	}

	// --- 11. per-source cap disabled (PI_SWARM_ERRORLOG_PER_SOURCE_MAX=0): no per-source gate ---
	{
		const sub = join(scratch, "per-source-disabled");
		await mkdir(join(sub, ".pi", "swarm", "traces"), { recursive: true });
		process.env.PI_SWARM_ERRORLOG_PER_SOURCE_MAX = "0";
		process.env.PI_SWARM_ERRORLOG_MAX_ENTRIES = "2000";
		errorlog.resetErrorLogBudgetForTests();
		if (typeof errorlog.resetErrorLogPerSourceForTests === "function") {
			errorlog.resetErrorLogPerSourceForTests();
		}
		for (let i = 0; i < 50; i++) {
			await errorlog.logSwarmError(sub, "loud", "disabled.test", new Error(`loud-${i}`));
		}
		const subErrorsFile = join(sub, ".pi", "swarm", "traces", "errors.jsonl");
		const lines = (await readFile(subErrorsFile, "utf8"))
			.split("\n")
			.filter((l) => l.trim())
			.map((l) => JSON.parse(l));
		ok("per-source cap disabled: all 50 entries from one source are appended (global cap is the only gate)", lines.length === 50, {
			lineCount: lines.length,
		});
		delete process.env.PI_SWARM_ERRORLOG_PER_SOURCE_MAX;
		errorlog.resetErrorLogBudgetForTests();
		if (typeof errorlog.resetErrorLogPerSourceForTests === "function") {
			errorlog.resetErrorLogPerSourceForTests();
		}
	}

	// --- 12. real errors still logged across sources: no source is silently dropped -------
	{
		const sub = join(scratch, "real-errors-still-logged");
		await mkdir(join(sub, ".pi", "swarm", "traces"), { recursive: true });
		process.env.PI_SWARM_ERRORLOG_PER_SOURCE_MAX = "2";
		process.env.PI_SWARM_ERRORLOG_MAX_ENTRIES = "2000";
		errorlog.resetErrorLogBudgetForTests();
		if (typeof errorlog.resetErrorLogPerSourceForTests === "function") {
			errorlog.resetErrorLogPerSourceForTests();
		}
		for (const src of ["src-a", "src-b", "src-c"]) {
			for (let i = 0; i < 3; i++) {
				await errorlog.logSwarmError(sub, src, "interleave.test", new Error(`${src}-${i}`));
			}
		}
		const subErrorsFile = join(sub, ".pi", "swarm", "traces", "errors.jsonl");
		const lines = (await readFile(subErrorsFile, "utf8"))
			.split("\n")
			.filter((l) => l.trim())
			.map((l) => JSON.parse(l));
		const bySource = { "src-a": 0, "src-b": 0, "src-c": 0 };
		for (const r of lines) bySource[r.source] = (bySource[r.source] || 0) + 1;
		ok(
			"real errors still logged: each of 3 sources retains its last 2 entries (no source silently dropped)",
			bySource["src-a"] === 2 && bySource["src-b"] === 2 && bySource["src-c"] === 2,
			{ bySource, totalLines: lines.length },
		);
		delete process.env.PI_SWARM_ERRORLOG_PER_SOURCE_MAX;
		errorlog.resetErrorLogBudgetForTests();
		if (typeof errorlog.resetErrorLogPerSourceForTests === "function") {
			errorlog.resetErrorLogPerSourceForTests();
		}
	}
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
