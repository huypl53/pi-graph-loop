#!/usr/bin/env node
// Plan 2026-10-14-reload-hook-pipeline-death (D7): swarm hook handler failures currently die
// inside pi's runner.emit() catch → emitError → TUI toast only. NOTHING lands in
// errors.jsonl — the "silent hook death" from the workflow-agents incident (session 01a135e8,
// /reload at 01:35:17Z, then 46 min of unprotected provider errors).
//
// RED-first (plan §4 R3/R4):
//   R3: a handler throwing a STALE-CTX error must append a durable `hook_dispatch_error` row
//       to errors.jsonl, compacted (one row per invalidation epoch, not per turn).
//   R4: a non-stale handler throw must be logged per occurrence (no compaction).
//
// Run: node extensions/swarm/tests/hook-stale-ctx-census.test.mjs
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let pass = 0,
	fail = 0;
const ok = (name, cond, info) => {
	if (cond) {
		pass++;
		console.log("  ok  ", name);
	} else {
		fail++;
		console.error("  FAIL", name, info ?? "");
	}
};

const dir = await mkdtemp(join(tmpdir(), "hook-census-"));
await mkdir(join(dir, ".pi"), { recursive: true });
process.chdir(dir);
process.env.PI_SWARM_AGENT_ID = "root";
process.env.PI_SWARM_IS_ROOT = "1";

const { paths } = await import("../src/state.ts");
const p = paths(dir);
const errorsFile = join(dir, ".pi", "swarm", "traces", "errors.jsonl");

const readErrors = async () => {
	try {
		const raw = await readFile(errorsFile, "utf8");
		return raw.trim() ? raw.trim().split("\n").map((l) => JSON.parse(l)) : [];
	} catch {
		return [];
	}
};

// Build a pi stub whose `on` WRAPS every handler the way runner.emit does — a handler throw
// is caught and routed to emitError only (this is exactly runner.js:813-834).
const makeEmittingPi = (emitErrorSink, ctx) => {
	const handlers = {};
	return {
		_swing: "test-stub",
		on: (ev, fn) => {
			(handlers[ev] ||= []).push(fn);
		},
		registerTool: () => {},
		registerCommand: () => {},
		sendMessage: () => {},
		exec: async () => ({ code: 0, stdout: "", stderr: "" }),
		// mimic pi's dispatch: catch → emitError(ext.path, event, message). NO durable census
		// exists today (runner.js:813-834 → TUI toast only) — that silence is the bug.
		_emit: async (ev, event) => {
			for (const fn of handlers[ev] || []) {
				try {
					await fn(event, ctx);
				} catch (err) {
					emitErrorSink(err, ev);
				}
			}
		},
	};
};

const { registerSwarmHooks } = await import("../src/hooks.ts");

const STALE_MSG =
	"This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession().";
// A captured ctx that throws stale on EVERY property access (agent-session.js:1003 semantics).
const staleCtx = new Proxy(
	{},
	{ get() { throw new Error(STALE_MSG); } },
);
// A ctx that throws an ordinary IO error (non-stale class).
const ioCtx = new Proxy(
	{},
	{ get() { throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" }); } },
);

// === R3: stale-ctx handler throw → durable, compacted census =========================
{
	const emitErrorSinkCalls = [];
	const pi = makeEmittingPi((err, ev) => emitErrorSinkCalls.push({ ev, msg: String(err?.message || err) }), staleCtx);
	registerSwarmHooks(pi);

	// Simulate 3 turn_end dispatches where the captured ctx is stale (post-replacement):
	// each dispatch hits the stale error; runner.emit would toast each one silently.
	for (let i = 0; i < 3; i++) {
		await pi._emit("turn_end", { message: { role: "assistant", stopReason: "error", errorMessage: "quota exhausted" } });
	}

	// The census: errors.jsonl must exist with hook_dispatch_error rows (RED: file absent).
	const rows = await readErrors();
	const census = rows.filter((r) => r.op === "hook_dispatch_error");
	ok("R3: stale-ctx handler throw lands a durable hook_dispatch_error row", census.length >= 1, JSON.stringify(rows.slice(0, 2)));

	// Compaction: 3 identical stale epochs → ONE row (per-epoch dedupe), not three.
	ok("R3c: stale-ctx rows are compacted to one per epoch", census.length === 1, `rows=${census.length}`);
}

// === R4: non-stale handler throw → logged per occurrence =============================
{
	const pi2 = makeEmittingPi(() => {}, ioCtx);
	registerSwarmHooks(pi2);
	for (let i = 0; i < 3; i++) {
		await pi2._emit("turn_end", { message: { role: "assistant", stopReason: "error", errorMessage: "quota exhausted" } });
	}
	const rows = await readErrors();
	const census = rows.filter((r) => r.op === "hook_dispatch_error" && r.compacted !== true);
	ok("R4: non-stale handler throws are logged per occurrence (no compaction)", census.length >= 3, `rows=${census.length}`);
}

delete process.env.PI_SWARM_AGENT_ID;
delete process.env.PI_SWARM_IS_ROOT;
console.log(`\n${fail === 0 ? "PASS" : "FAIL"}: ${pass} passed, ${fail} failed`);
await rm(dir, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
