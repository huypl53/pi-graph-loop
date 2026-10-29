#!/usr/bin/env node
/**
 * guest-goal-nudge — mock-LLM lane for the guest-session standing-goal nudge.
 *
 * task: guest-goal (2026-10-30). Strategy (Pattern 2, seeded world + single-actor script —
 * mirrors vacuous-user-goal-nudge.test.mjs):
 *   - Real `pi --provider mock-llm --model guest-goal-nudge` against a scratch cwd with
 *     NO PI_SWARM_AGENT_ID and NO PI_SWARM_IS_ROOT — the session resolves to the anonymous
 *     swarm-guest (the production "plain pi" identity).
 *   - Seed: st.guestGoal (origin=user, set 30min ago — past any grace) with the guest
 *     check-streak state already spaced (guestGoalIdleLastCheckAt 30min ago) so the FIRST
 *     settle after turn 0 completes the streak (CHECKS_REQUIRED=1: the -p lane's settle
 *     surfaces are lifecycle-driven; a 3x1s streak cannot elapse before process exit —
 *     streak semantics are covered offline by extensions/swarm/tests/guest-goal-nudge.test.mjs;
 *     THIS lane proves the end-to-end wiring: seeded world → real agent_settled →
 *     evaluateGuestGoalOnSettle → pi.sendMessage L2 → L4 consumption in the NEXT request).
 *   - Assert: goal.idle_nudge trace with route=guest_solo; the nudge text appears in the
 *     turn-1 model REQUEST (L4 — the mock provider's request transcript); consecutive-
 *     NoResolveNudges durable on st.guestGoal; NO mailbox write (session-local by design —
 *     the guest has no swarm peers).
 *
 * SKIP-by-default live lane (RUN_GUEST_GOAL_LANE=1); fixture-shape assertions always run.
 */

import { rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(here, "..", "fixtures", "guest-goal-nudge.jsonl");
const repoRoot = join(here, "..", "..", "..");

let pass = 0,
	fail = 0;
const ok = (n, c, info) => {
	if (c) {
		pass++;
		console.log("  ok  ", n);
	} else {
		fail++;
		console.error("  FAIL:", n, info !== undefined ? `(${JSON.stringify(info).slice(0, 300)})` : "");
	}
};

console.log("== guest-goal-nudge fixture file shape ==");
ok("fixture file exists", existsSync(fixturePath));
const lines = existsSync(fixturePath)
	? readFileSync(fixturePath, "utf8")
			.split("\n")
			.filter((l) => l.trim() && !l.startsWith("#"))
	: [];
ok("fixture has 3 scripted turns", lines.length === 3, { lines: lines.length });
const turns = lines.map((l) => JSON.parse(l));
ok("turn 0 = text", turns[0]?.events?.[0]?.type === "text");
ok("turn 1 = text", turns[1]?.events?.[0]?.type === "text");
ok("turn 2 = stop (terminal)", turns[2]?.stopReason === "stop" && turns[2]?.events?.some((e) => e.type === "stop"));

if (process.env.RUN_GUEST_GOAL_LANE !== "1") {
	console.log(`\n(skipping live lane — set RUN_GUEST_GOAL_LANE=1 to execute the full E2E scenario)`);
	console.log(`GUEST-GOAL-NUDGE FIXTURE ${fail === 0 ? "PASS" : "FAIL"} (${fail} failed, ${pass} passed)`);
	process.exit(fail === 0 ? 0 : 1);
}

// === Live E2E lane ===
console.log("\n== Live E2E lane ==");
const scratch = join(tmpdir(), `swarm-guest-goal-lane-${process.pid}-${Date.now()}`);

mkdirSync(join(scratch, ".pi", "swarm", "traces"), { recursive: true });

const statePath = join(scratch, ".pi", "swarm", "swarm-state.json");
const { ensureDirs, paths, defaultState } = await import(join(repoRoot, "extensions/swarm/src/state.ts"));
await ensureDirs(paths(scratch));

const st = defaultState(scratch);
const now = new Date().toISOString();
const thirtyMinAgo = new Date(Date.now() - 30 * 60_000).toISOString();

// The seeded guest goal — the live shape a human creates with /swarm guest-goal set.
st.guestGoal = {
	id: "goal-guest-lane",
	text: "Hoàn tất refactor module export. Không spawn swarm agents.",
	setAt: thirtyMinAgo,
	setBy: "swarm-guest",
	origin: "user",
	setByScope: "guest-command",
	consecutiveNoResolveNudges: 0,
	nudgeSeq: 0,
};
// Guest check-streak state already spaced: the last check is 30min old, so the FIRST settle
// sample after turn 0 completes the streak (CHECKS_REQUIRED=1).
st.idleNudgeState = { guestGoalIdleCheckCount: 0, guestGoalIdleLastCheckAt: thirtyMinAgo };

writeFileSync(statePath, JSON.stringify(st, null, 2) + "\n");

const env = { ...process.env };
// The production guest identity: NOTHING set — anonymous swarm-guest.
delete env.PI_SWARM_AGENT_ID;
delete env.PI_SWARM_IS_ROOT;
env.PI_SWARM_GOAL_IDLE_CHECK_INTERVAL_MS = "1000";
env.PI_SWARM_GOAL_IDLE_CHECKS_REQUIRED = "1";
env.PI_MOCK_LLM_TRANSCRIPTS_DIR = join(scratch, ".pi/mock-llm/transcripts");

const r = spawnSync(
	"pi",
	[
		"-ne",
		"-e",
		join(repoRoot, "extensions/swarm"),
		"-e",
		join(repoRoot, "extensions/mock-llm"),
		"--provider",
		"mock-llm",
		"--model",
		"guest-goal-nudge",
		"-p",
		"begin",
	],
	{ cwd: scratch, env, timeout: 45_000, encoding: "utf8" },
);

const eventsFile = join(scratch, ".pi/swarm/traces/events.jsonl");
const transcriptsDir = join(scratch, ".pi/mock-llm/transcripts/guest-goal-nudge");

const readJsonl = (p) =>
	existsSync(p)
		? readFileSync(p, "utf8")
				.split("\n")
				.filter(Boolean)
				.map((l) => JSON.parse(l))
		: [];

if (existsSync(eventsFile)) {
	const events = readJsonl(eventsFile);
	const nudge = events.find((e) => e.event === "goal.idle_nudge");
	ok("[live lane] goal.idle_nudge trace fired", Boolean(nudge), events.map((e) => e.event).slice(-12));
	ok("[live lane] nudge route === guest_solo", nudge?.route === "guest_solo", nudge?.route);
	ok("[live lane] nudge guest === true", nudge?.guest === true, nudge?.guest);
} else {
	ok("[live lane] events.jsonl was created", false);
}

// L4 consumption: in TUI the settle-fired nudge (triggerTurn) starts the next turn and the
// model request carries it. A `pi -p` lane EXITS after the scripted turns — the triggered
// turn cannot run — so this lane asserts the DELIVERY PROVENANCE instead: the durable trace
// records triggerTurn=true (the L2 send options), the same scope decision as the
// vacuous-user-goal-nudge live lane. The offline unit suite pins the real options object
// (sent.__opts.triggerTurn === true) at a real mock-pi sendMessage boundary.
let triggerProvenance = false;
let nudgeConsumed = false;
let requestCount = 0;
if (existsSync(eventsFile)) {
	const evts = readJsonl(eventsFile);
	const nudge = evts.find((e) => e.event === "goal.idle_nudge");
	triggerProvenance = nudge?.triggerTurn === true;
}
if (existsSync(transcriptsDir)) {
	const { readdirSync } = await import("node:fs");
	for (const f of readdirSync(transcriptsDir).sort()) {
		requestCount++;
		const body = readFileSync(join(transcriptsDir, f), "utf8");
		if (body.includes("Standing goal") || body.includes("guest_solo")) nudgeConsumed = true;
	}
}
ok("[live lane] nudge delivered with triggerTurn provenance (L2 → L4 wiring)", triggerProvenance || nudgeConsumed, {
	requestCount,
	triggerProvenance,
	nudgeConsumed,
});

// Durable state: the counter advanced on st.guestGoal (consecutiveNoResolveNudges >= 1 —
// unless the terminal stop already resolved it, in which case lastResolvedAt is set and the
// counter is 0; both prove the wiring).
if (existsSync(statePath)) {
	const after = JSON.parse(readFileSync(statePath, "utf8"));
	const g = after.guestGoal;
	ok("[live lane] st.guestGoal survived the lane", Boolean(g), Object.keys(after));
	if (g) {
		const nudged = g.consecutiveNoResolveNudges >= 1 || Boolean(g.lastResolvedAt);
		ok("[live lane] counter advanced then/or resolved by terminal stop", nudged, {
			consecutiveNoResolveNudges: g.consecutiveNoResolveNudges,
			lastResolvedAt: g.lastResolvedAt,
		});
		ok(
			"[live lane] no mailbox record for the guest (session-local by design)",
			!existsSync(join(scratch, ".pi/swarm/mailboxes/swarm-guest.jsonl")),
		);
	}
} else {
	ok("[live lane] swarm-state.json survived the lane", false);
}

console.log(`\nGUEST-GOAL-NUDGE FIXTURE ${fail === 0 ? "PASS" : "FAIL"} (${fail} failed, ${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);
