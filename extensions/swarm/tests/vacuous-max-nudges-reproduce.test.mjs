#!/usr/bin/env node
/**
 * REPRODUCE TEST:
 * When goal.consecutiveNoResolveNudges >= effectiveMaxNudges (e.g. 2 >= 1 or 1 >= 1),
 * vacuous branch (pool empty escalation) should NOT continue to deliver escalations every 5 minutes.
 * It must honor maxNudges and suppress further escalations when capped.
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

const d = mkdtempSync(join(tmpdir(), "swarm-vacuous-cap-"));
mkdirSync(join(d, ".pi"), { recursive: true });
writeFileSync(join(d, ".pi", "settings.json"), JSON.stringify({ swarm: { defaultModel: "glm-5.1", defaultProvider: "zai-coding-cn" } }));
process.chdir(d);
const p = paths(d);
await ensureDirs(p);

const mockPi = {
	registerTool: () => {},
	registerCommand: () => {},
	on: () => {},
	setModel: async () => true,
	sendMessage: () => {},
	exec: async () => ({ code: 0, stdout: "", stderr: "" }),
};

const nowMs = Date.now();
await withLock(p, async () => {
	let st = await readState(p, d);
	ensureRoot(st, d, p);

	// Goal has maxNudges = 1, and consecutiveNoResolveNudges = 2 (already capped!)
	st.goal = {
		id: "goal-test-cap",
		text: "Test goal already capped",
		setAt: new Date(nowMs - 3600_000).toISOString(),
		origin: "user",
		maxNudges: 1,
		consecutiveNoResolveNudges: 2,
	};

	// All workers dead/stopped -> vacuous
	st.idleNudgeState = {
		lastWasVacuous: true,
		// Cooldown expired 10 minutes ago
		lastPoolEmptyEscalationAt: new Date(nowMs - 600_000).toISOString(),
	};

	await writeState(p, st);
	await evaluateIdleGoalNudgeLocked(mockPi, d, p, st, nowMs, false);
});

const ep = join(d, ".pi/swarm/traces/events.jsonl");
const events = existsSync(ep) ? readFileSync(ep, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
const esc = events.filter((e) => e.event === "goal.escalation.pool_empty");

// If bug is present: escalation fires despite consecutiveNoResolveNudges >= maxNudges!
// Expected after fix: escalationCount === 0 (capped)
ok(
	"empty pool escalation is suppressed when goal is already capped at maxNudges",
	esc.length === 0,
	`expected 0 escalations, got ${esc.length}`,
);

console.log(`\nResults: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
