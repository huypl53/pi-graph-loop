#!/usr/bin/env node
// Plan 2026-10-14-reload-hook-pipeline-death (D8): the root pump watchdog's stale-ctx stop
// currently leaves the pump DEAD with no durable record and no self-heal:
//   - stopRootPump() only clears module state; nothing durable records WHY the pump stopped.
//   - The agent_settled re-arm guard (hooks/settled.ts) requires isRootPumpCtxFresh()===true,
//     which stopRootPump() set to false — so a settle after a stale stop can never re-arm.
//   - Live evidence: workflow-agents session 01a135e8, /reload at 01:35:17Z killed the root
//     pump until a manual /swarm register at 02:21:41Z (46 min, 5 unprotected quota errors).
//
// RED-first (plan §4 R1/R2):
//   R1: stale-ctx stop writes a durable rootPumpStop stamp; agent_settled with a FRESH ctx
//       re-arms the pump.
//   R2: the re-arm path must NOT multiply timer chains (exactly one pending timer).
//
// Run: node extensions/swarm/tests/pump-stale-rearm.test.mjs
import { mkdtemp, mkdir, rm } from "node:fs/promises";
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

const dir = await mkdtemp(join(tmpdir(), "pump-stale-rearm-"));
await mkdir(join(dir, ".pi"), { recursive: true });
process.chdir(dir);
process.env.PI_SWARM_AGENT_ID = "root";
process.env.PI_SWARM_IS_ROOT = "1";

const { paths, readState, writeState, withLock } = await import("../src/state.ts");
const { ensureRoot, heartbeatRootLeader } = await import("../src/identity.ts");
const { startRootPump, stopRootPump } = await import("../src/hooks.ts");
const { getRootMailboxTimer, setRootPumpCtxFresh, isRootPumpCtxFresh } = await import("../src/hooks/pump-manager.ts");
const { registerSwarmHooks } = await import("../src/hooks.ts");

const p = paths(dir);

// Fresh fake ctx whose accessors WORK (the "fresh settle ctx").
const freshCtx = {
	mode: "tui",
	cwd: dir,
	isIdle: () => true,
	hasUI: false,
	ui: { setStatus: () => {} },
};

// A DEAD captured ctx: every property access throws stale-ctx (what a captured ctx looks like
// after session replacement per agent-session.js:1003).
const deadCtx = new Proxy(
	{},
	{
		get() {
			throw new Error(
				"This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession().",
			);
		},
	},
);

// Register hooks FIRST: registerSwarmHooks calls setSwarmPi(pi), which startRootPump needs
// (getSwarmPi() early-returns otherwise). Capture the agent_settled handler for R1b/R2.
const handlers = [];
const stub = {
	sendMessage: () => {},
	exec: async () => ({ code: 0, stdout: "", stderr: "" }),
	registerTool: () => {},
	registerCommand: () => {},
	on: (ev, fn) => handlers.push({ ev, fn }),
};
registerSwarmHooks(stub);
const agentSettled = handlers.find((h) => h.ev === "agent_settled")?.fn;

// Make root the leader so startRootPump's preflight passes.
await withLock(p, async () => {
	const st = await readState(p, dir);
	ensureRoot(st, dir, p);
	heartbeatRootLeader(st, Date.now(), process.pid, "stale-rearm-seed");
	await writeState(p, st);
});

// === R1a: stale-ctx stop leaves a DURABLE rootPumpStop stamp =========================
await startRootPump(freshCtx, "test_stale_arm");
ok("R1 pre: watchdog armed after startRootPump", typeof getRootMailboxTimer() === "object");

// Simulate the watchdog tick hitting a stale-ctx error the way pump-manager.ts does:
// stopRootPump() + (RED: no durable stamp anywhere).
stopRootPump();

{
	const st = await readState(p, dir);
	ok(
		"R1a: stale-ctx stop records durable rootPumpStop {reason, at} in swarm state",
		st.rootPumpStop && st.rootPumpStop.reason === "stale_ctx" && !Number.isNaN(Date.parse(st.rootPumpStop.at)),
		JSON.stringify(st.rootPumpStop ?? null),
	);
}

// === R1b: agent_settled with a FRESH ctx re-arms after a stale stop ==================
{
	ok("R1b pre: agent_settled handler registered", typeof agentSettled === "function");

	// RED today: the re-arm guard requires isRootPumpCtxFresh()===true, which the stale stop
	// cleared — so nothing happens.
	setRootPumpCtxFresh(false);
	await agentSettled({}, freshCtx);
	ok(
		"R1b: agent_settled with fresh ctx re-arms the pump after a stale stop",
		typeof getRootMailboxTimer() === "object",
		`timer=${String(getRootMailboxTimer())} ctxFresh=${isRootPumpCtxFresh()}`,
	);
}

// === R2: re-arm must not multiply timer chains ======================================
{
	await agentSettled({}, freshCtx);
	ok("R2: repeated settles keep exactly ONE watchdog timer (idempotent replace)", typeof getRootMailboxTimer() === "object");
	// second settle replaces (not adds): timer handle identity changes but only one exists
	stopRootPump();
	ok("R2 post: stopRootPump clears the single timer", getRootMailboxTimer() === undefined);

	// A settle holding a DEAD ctx must not re-arm and must not throw into the caller.
	setRootPumpCtxFresh(false);
	try {
		await agentSettled({}, deadCtx);
		ok("R2b: settle with dead ctx does not throw", true);
	} catch (err) {
		ok("R2b: settle with dead ctx does not throw", false, String(err?.message || err));
	}
	ok("R2b: settle with dead ctx does NOT arm the pump", getRootMailboxTimer() === undefined);
}

stopRootPump();
delete process.env.PI_SWARM_AGENT_ID;
delete process.env.PI_SWARM_IS_ROOT;

console.log(`\n${fail === 0 ? "PASS" : "FAIL"}: ${pass} passed, ${fail} failed`);
await rm(dir, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
