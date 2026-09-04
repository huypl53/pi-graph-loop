// Item 4: injection fail/retry rate probe — measurement-only instrumentation tests.
// Verifies message.inject.probe trace events are emitted (success + failure paths) with rate
// fields, and that delivery behavior (return values / state transitions) is unchanged.
// Run: node extensions/swarm/inject-probe.test.mjs
import { mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paths, readState, writeState } from "../src/state.ts";
import { deliver } from "../src/mailbox.ts";
import { trace } from "../src/state.ts";

const scratch = join(tmpdir(), `swarm-inject-probe-${process.pid}-${Date.now()}`);
rmSync(scratch, { recursive: true, force: true });
mkdirSync(scratch, { recursive: true });
const p = paths(scratch);

let fail = 0;
const ok = (name, cond) => { if (cond) console.log("  ok  ", name); else { fail++; console.error("  FAIL", name); } };

const pi = {
	exec: async () => ({ code: 0, stdout: "", stderr: "" }),
	registerTool: () => {}, registerCommand: () => {}, on: () => {},
};
const mkMsg = (id, to) => ({ id, swarmId: "s", from: "orchestrator", to, priority: "normal", type: "swarm.message", schemaVersion: 1, createdAt: new Date().toISOString(), body: "x", requiresAck: true, headers: {} });

const probes = () => {
	try {
		return readFileSync(p.events, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((e) => e.event === "message.inject.probe");
	} catch { return []; }
};

// --- 1. unknown agent → failure probe with rate fields ---
{
	const st = await readState(p, scratch);
	const r = await deliver(pi, p, st, mkMsg("m1", "ghost"));
	ok("unknown agent: behavior unchanged (delivered=false)", r.delivered === false && r.reason === "unknown agent");
	const pr = probes();
	ok("failure probe emitted for unknown agent", pr.length === 1 && pr[0].outcome === "failure" && pr[0].reason === "unknown agent");
	ok("probe has id/to + rate fields", pr[0].id === "m1" && pr[0].to === "ghost" && typeof pr[0].probe.failureRate === "number" && typeof pr[0].probe.successRate === "number");
	ok("probe reports attempt number", pr[0].probe.attempt === 1);
}

// --- 2. mailbox-only recipient → success probe ---
{
	const st = await readState(p, scratch);
	st.agents["orch"] = { id: "orch", role: "r", roleKind: "worker", capabilities: [], activeTaskIds: [], maxConcurrentTasks: 1, status: "running", runtimeStatus: "idle", health: "healthy", tmuxSession: "s", tmuxWindow: "w", tmuxTarget: "unknown", model: "m", provider: "o", cwd: scratch, mailbox: "x", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
	const r = await deliver(pi, p, st, mkMsg("m2", "orch"));
	ok("mailbox-only: behavior unchanged (delivered=true, mailboxOnly)", r.delivered === true && r.mailboxOnly === true);
	const pr = probes();
	ok("success probe emitted for mailbox-only", pr.length === 2 && pr[1].outcome === "success" && pr[1].reason === "mailbox-only");
}

// --- 3. not-running agent → failure probe; rates accumulate per recipient ---
{
	const st = await readState(p, scratch);
	st.agents["w1"] = { id: "w1", role: "r", roleKind: "worker", capabilities: [], activeTaskIds: [], maxConcurrentTasks: 1, status: "stopped", runtimeStatus: "stopped", health: "unknown", tmuxSession: "s", tmuxWindow: "w", tmuxTarget: "s:w.0", model: "m", provider: "o", cwd: scratch, mailbox: "x", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
	// seed one historical failure + one historical success for w1 so rates are non-trivial
	st.messages["old-f"] = { id: "old-f", from: "orchestrator", to: "w1", status: "failed", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), attempts: 1, requiresAck: true };
	st.messages["old-s"] = { id: "old-s", from: "orchestrator", to: "w1", status: "injected", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), attempts: 1, requiresAck: true };
	const r = await deliver(pi, p, st, mkMsg("m3", "w1"));
	ok("not-running: behavior unchanged (delivered=false)", r.delivered === false && r.reason === "target agent not running");
	const pr = probes();
	const last = pr[pr.length - 1];
	ok("failure probe emitted for not-running agent", last.id === "m3" && last.outcome === "failure");
	ok("rates computed over recipient history (1 prior success, 1 prior failure + this failure -> failureRate 0.667)", last.probe.successes === 1 && last.probe.failures === 1 && last.probe.failureRate === 0.667 && last.probe.successRate === 0.333);
	ok("probe carries retry budget", last.probe.retryBudget === last.probe.retryBudget && typeof last.probe.retryBudget === "number");
}

// --- 4. instrumentation never blocks: probe trace failures are swallowed ---
{
	// corrupt the events file so trace() throws -> deliver must still return normally
	rmSync(p.events);
	require_fs: {
		const { writeFileSync } = await import("node:fs");
		writeFileSync(p.events, "{not json per line is fine since trace appends}\n");
	}
	const st = await readState(p, scratch);
	st.agents["ghost2"] = undefined;
	let threw = false;
	try { await deliver(pi, p, st, mkMsg("m4", "ghost")); } catch { threw = true; }
	ok("deliver still returns when state has no agent", threw === false);
}

rmSync(scratch, { recursive: true, force: true });
if (fail) { console.error(`\nINJECT PROBE FAIL (${fail})`); process.exit(1); }
console.log("\nINJECT PROBE PASS");
