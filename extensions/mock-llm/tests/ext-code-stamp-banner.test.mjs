#!/usr/bin/env node
/**
 * ext-code-stamp-banner — scratch-cell lane for the mock-LLM fixture scenario.
 *
 * Plan §3 acceptance: end-to-end scenario via the mock-LLM fixture. Strategy:
 *   - Use real `pi --provider mock-llm --model ext-code-stamp-banner` against a scratch
 *     cwd, with PI_SWARM_AGENT_ID=root.
 *   - Seed the swarm state with: root pseudo-agent + a stale durable stamp
 *     (hash = "0".repeat(64), stampedAt = 3h ago) so the root session_start
 *     fires the ext.stamp.changed notify.
 *   - Let the lane run to terminal (3 turns). After agent_settled fires, the
 *     durable stamp should be refreshed to the current process generation.
 *
 * Pattern 2 (seeded world + single-actor script) per the mock-llm-scenarios skill: the
 * engine does the real work, the scripted turns just give the lane a clean terminal.
 *
 * This is a SKIP-by-default companion test. Set RUN_EXT_STAMP_LANE=1 to actually exec
 * pi and validate; otherwise the file just verifies the fixture exists and is
 * well-formed.
 */

import { rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(here, "..", "fixtures", "ext-code-stamp-banner.jsonl");
const repoRoot = join(here, "..", "..", "..");

let pass = 0,
	fail = 0;
const ok = (n, c, info) => {
	if (c) {
		pass++;
		console.log("  ok  ", n);
	} else {
		fail++;
		console.error("  FAIL", n, info !== undefined ? `(${JSON.stringify(info).slice(0, 200)})` : "");
	}
};

console.log("== ext-code-stamp-banner fixture file shape ==");
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

if (process.env.RUN_EXT_STAMP_LANE !== "1") {
	console.log(`\n(skipping live lane — set RUN_EXT_STAMP_LANE=1 to execute the full E2E scenario)`);
	console.log(`EXT-STAMP FIXTURE ${fail === 0 ? "PASS" : "FAIL"} (${fail} failed, ${pass} passed)`);
	process.exit(fail === 0 ? 0 : 1);
}

// === Live E2E lane (opt-in via RUN_EXT_STAMP_LANE=1) ===
console.log("\n== Live E2E lane ==");
const scratch = join(tmpdir(), `swarm-ext-stamp-lane-${process.pid}-${Date.now()}`);
rmSync(scratch, { recursive: true, force: true });

// Seed state with a stale durable stamp (hash = "0".repeat(64), stampedAt = 3h ago)
const statePath = join(scratch, ".pi", "swarm", "swarm-state.json");

const { ensureDirs, paths, defaultState } = await import(join(repoRoot, "extensions/swarm/src/state.ts"));
await ensureDirs(paths(scratch));

const st = defaultState("swarm-ext-stamp-lane", scratch);
const now = new Date().toISOString();
const threeHoursAgo = new Date(Date.now() - 3 * 3600 * 1000).toISOString();
st.agents["root"] = {
	id: "root",
	role: "root",
	roleKind: "root",
	roleKindExplicit: true,
	tmuxTarget: "unknown",
	tmuxSession: "ext-stamp-lane",
	tmuxWindow: "root",
	mailbox: ".pi/swarm/mailboxes/root.jsonl",
	capabilities: ["orchestrate"],
	status: "running",
	runtimeStatus: "idle",
	health: "healthy",
	createdAt: now,
	updatedAt: now,
	lastHeartbeatAt: now,
	activeTaskIds: [],
};
// Seed the stale durable stamp — the root session_start will detect the mismatch
// and fire the ext.stamp.changed notify.
st.rootLeader = {
	pid: 99999,
	sessionStartedAt: threeHoursAgo,
	claimedAt: threeHoursAgo,
	lastHeartbeatAt: threeHoursAgo,
	agentRecordId: "root",
	extCodeStamp: {
		hash: "0".repeat(64),
		files: 42,
		stampedAt: threeHoursAgo,
	},
};
writeFileSync(statePath, JSON.stringify(st, null, 2) + "\n");

// Run the lane — mirror reviewer-lane-probe.mjs recipe: scratch cwd, -ne, absolute -e paths,
// env hygiene (set PI_SWARM_AGENT_ID=root, PI_SWARM_IS_ROOT=1).
const env = { ...process.env };
env.PI_SWARM_AGENT_ID = "root";
env.PI_SWARM_IS_ROOT = "1";
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
		"ext-code-stamp-banner",
		"-p",
		"idle",
	],
	{ cwd: scratch, env, timeout: 30_000, encoding: "utf8" },
);

// After the lane, the durable stamp should be refreshed to the current process generation
// (the heartbeat in session_start writes the new stamp).
const stAfter = JSON.parse(readFileSync(statePath, "utf8"));
const refreshedStamp = stAfter.rootLeader?.extCodeStamp;
ok("[live lane] durable stamp refreshed to current process generation", refreshedStamp?.hash !== "0".repeat(64), {
	hash: refreshedStamp?.hash?.slice(0, 8),
	files: refreshedStamp?.files,
});
ok("[live lane] refreshed stamp has plausible file count (≥20)", (refreshedStamp?.files ?? 0) >= 20, refreshedStamp?.files);

rmSync(scratch, { recursive: true, force: true });
console.log(`\nEXT-STAMP FIXTURE ${fail === 0 ? "PASS" : "FAIL"} (${fail} failed, ${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);
