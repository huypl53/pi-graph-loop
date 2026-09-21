#!/usr/bin/env node
/**
 * REPRODUCE TEST for poolDiag classification and filtering of historical/stopped agents.
 *
 * Scenario:
 * A swarm has had many agents in the past, now all stopped > 10m ago (heartbeatAge > 10m, lastShutdownAt > 10m ago).
 * When evaluateIdleGoalNudgeLocked triggers (vacuous=true, no live workers):
 * - It emits a goal.escalation.pool_empty trace and delivers a message to root.
 * - poolDiag should NOT report these long-dead historical agents as if they are active dead panes to resurrect.
 * - hints should NOT advise to `swarm_restart_agent` on 20+ historical agents that finished days ago.
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const { paths, readState, withLock, writeState, ensureDirs } = await import(join(here, "..", "src", "state.ts"));
const { evaluateIdleGoalNudgeLocked } = await import(join(here, "..", "src", "nudges", "goal-epoch.ts"));
const { ensureRoot } = await import(join(here, "..", "src", "identity.ts"));

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

const d = mkdtempSync(join(tmpdir(), "swarm-pool-diag-repro-"));
mkdirSync(join(d, ".pi"), { recursive: true });
writeFileSync(join(d, ".pi", "settings.json"), JSON.stringify({ swarm: { defaultModel: "glm-5.1", defaultProvider: "zai-coding-cn" } }));
process.chdir(d);
const p = paths(d);
await ensureDirs(p);

const deliverCalls = [];
const mockPi = {
	registerTool: () => {},
	registerCommand: () => {},
	on: () => {},
	setModel: async () => true,
	sendMessage: () => {},
	exec: async (cmd, args) => ({ code: 0, stdout: "", stderr: "" }),
};

const nowMs = Date.now();
await withLock(p, async () => {
	let st = await readState(p, d);
	ensureRoot(st, d, p);

	st.goal = {
		id: "goal-test-vacuous",
		text: "Test goal",
		setAt: new Date(nowMs - 3600_000).toISOString(),
		origin: "user",
	};

	// Add an agent stopped 2 days ago (historical)
	st.agents["old-worker"] = {
		id: "old-worker",
		role: "worker",
		roleKind: "worker",
		status: "stopped",
		runtimeStatus: "stopped",
		health: "unhealthy",
		tmuxAlive: false,
		lastShutdownAt: new Date(nowMs - 2 * 86400_000).toISOString(),
		lastHeartbeatAt: new Date(nowMs - 2 * 86400_000).toISOString(),
		createdAt: new Date(nowMs - 3 * 86400_000).toISOString(),
	};

	await writeState(p, st);
	await evaluateIdleGoalNudgeLocked(mockPi, d, p, st, nowMs, false);
});

const ep = join(d, ".pi/swarm/traces/events.jsonl");
const events = readFileSync(ep, "utf8").trim().split("\n").map(JSON.parse);
const esc = events.find((e) => e.event === "goal.escalation.pool_empty");

ok("goal.escalation.pool_empty was emitted", Boolean(esc));
if (esc) {
	console.log("poolDiag in event:", esc.poolDiag);
	// Before fix: poolDiag includes old-worker, stoppedAgents includes old-worker
	// Expected after fix: old-worker (stopped > 10m ago) is excluded from actionable poolDiag
	ok(
		"poolDiag excludes long-stopped historical agents",
		esc.poolDiag.length === 0,
		`expected 0 agents in poolDiag, got ${esc.poolDiag.length}`,
	);
}

console.log(`\nResults: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
