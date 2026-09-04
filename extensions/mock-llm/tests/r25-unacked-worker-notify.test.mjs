#!/usr/bin/env node
/**
 * R25 — scratch-cell lane for the mock-LLM fixture scenario.
 *
 * Plan §3 acceptance: end-to-end scenario via the mock-LLM fixture. Strategy:
 *   - Use real `pi --provider mock-llm --model r25-unacked-worker-notify` against a scratch
 *     cwd, with PI_SWARM_AGENT_ID=r25-worker.
 *   - Seed the swarm state with: r25-worker agent + an orchestrator pseudo-agent + 2 live
 *     requiresAck messages addressed to r25-worker (unacked, intercepted status).
 *   - Let the lane run to terminal (3 turns). After agent_settled fires, the orchestrator
 *     mailbox must contain the ack-debt notify (subject "settled owing N unacked ack(s)").
 *
 * Pattern 2 (seeded world + single-actor script) per the mock-llm-scenarios skill: the
 * engine does the real work, the scripted turns just give the lane a clean terminal.
 *
 * This is a SKIP-by-default companion test. Set RUN_R25_LANE=1 to actually exec pi and
 * validate; otherwise the file just verifies the fixture exists and is well-formed.
 */

import { rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(here, "..", "fixtures", "r25-unacked-worker-notify.jsonl");
const repoRoot = join(here, "..", "..", "..");

let pass = 0, fail = 0;
const ok = (n, c, info) => {
	if (c) { pass++; console.log("  ok  ", n); }
	else { fail++; console.error("  FAIL", n, info !== undefined ? `(${JSON.stringify(info).slice(0, 200)})` : ""); }
};

console.log("== R25 fixture file shape ==");
ok("fixture file exists", existsSync(fixturePath));
const lines = existsSync(fixturePath) ? readFileSync(fixturePath, "utf8").split("\n").filter((l) => l.trim() && !l.startsWith("#")) : [];
ok("fixture has 3 scripted turns", lines.length === 3, { lines: lines.length });
const turns = lines.map((l) => JSON.parse(l));
ok("turn 0 = text", turns[0]?.events?.[0]?.type === "text");
ok("turn 1 = text", turns[1]?.events?.[0]?.type === "text");
ok("turn 2 = stop (terminal)", turns[2]?.stopReason === "stop" && turns[2]?.events?.some((e) => e.type === "stop"));

if (process.env.RUN_R25_LANE !== "1") {
	console.log(`\n(skipping live lane — set RUN_R25_LANE=1 to execute the full E2E scenario)`);
	console.log(`R25 FIXTURE ${fail === 0 ? "PASS" : "FAIL"} (${fail} failed, ${pass} passed)`);
	process.exit(fail === 0 ? 0 : 1);
}

// === Live E2E lane (opt-in via RUN_R25_LANE=1) ===
console.log("\n== Live E2E lane ==");
const scratch = join(tmpdir(), `swarm-r25-lane-${process.pid}-${Date.now()}`);
rmSync(scratch, { recursive: true, force: true });

// Seed state
const statePath = join(scratch, ".pi", "swarm", "swarm-state.json");
const mailboxDir = join(scratch, ".pi", "swarm", "mailboxes");
const orchMailPath = join(mailboxDir, "orchestrator.jsonl");

const { ensureDirs, paths, defaultState } = await import(join(repoRoot, "extensions/swarm/src/state.ts"));
await ensureDirs(paths(scratch));

const st = defaultState("swarm-r25-lane", scratch);
const now = new Date().toISOString();
st.agents["orchestrator"] = {
	id: "orchestrator", role: "orchestrator", roleKind: "orchestrator", roleKindExplicit: true,
	tmuxTarget: "r25lane:orch.1", tmuxSession: "r25lane", tmuxWindow: "orch",
	mailbox: ".pi/swarm/mailboxes/orchestrator.jsonl", capabilities: ["orchestrate"],
	status: "running", runtimeStatus: "idle", health: "healthy",
	createdAt: now, updatedAt: now, lastHeartbeatAt: now, activeTaskIds: [],
};
st.agents["r25-worker"] = {
	id: "r25-worker", role: "test worker", roleKind: "implementer", roleKindExplicit: false,
	tmuxTarget: "r25lane:r25.1", tmuxSession: "r25lane", tmuxWindow: "r25",
	mailbox: ".pi/swarm/mailboxes/r25-worker.jsonl", capabilities: ["implement"],
	status: "running", runtimeStatus: "idle", health: "healthy",
	createdAt: now, updatedAt: now, lastHeartbeatAt: now, activeTaskIds: [],
};
st.messages = st.messages || {};
for (const id of ["msg-r25-lane-1", "msg-r25-lane-2"]) {
	st.messages[id] = {
		id, swarmId: st.swarmId, from: "orchestrator", to: "r25-worker",
		subject: `Task ${id} requiresAck`, priority: "normal", type: "swarm.message", schemaVersion: 1,
		createdAt: now, body: `seeded ${id}`, requiresAck: true, requiresResponse: false,
		status: "intercepted", attempts: 1, queuedAt: now, updatedAt: now,
		headers: { cwd: scratch, senderModel: "test", senderProvider: "test" },
	};
}
writeFileSync(statePath, JSON.stringify(st, null, 2) + "\n");

// Run the lane — mirror reviewer-lane-probe.mjs recipe: scratch cwd, -ne, absolute -e paths,
// env hygiene (strip PI_SWARM_IS_ORCHESTRATOR; set PI_SWARM_AGENT_ID=r25-worker). Without this
// the engine reads the repo's real swarm state (worker absent), double-loads swarm_audit
// (exit 1), and the parent's orchestrator identity env collides.
const env = { ...process.env };
delete env.PI_SWARM_IS_ORCHESTRATOR;
env.PI_SWARM_AGENT_ID = "r25-worker";
env.PI_MOCK_LLM_TRANSCRIPTS_DIR = join(scratch, ".pi/mock-llm/transcripts");

const r = spawnSync("pi", [
	"-ne",
	"-e", join(repoRoot, "extensions/swarm"),
	"-e", join(repoRoot, "extensions/mock-llm"),
	"--provider", "mock-llm",
	"--model", "r25-unacked-worker-notify",
	"-p", "idle",
], { cwd: scratch, env, timeout: 30_000, encoding: "utf8" });

const orchMail = existsSync(orchMailPath) ? readFileSync(orchMailPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
const notify = orchMail.find((m) => m.to === "orchestrator" && /unacked ack/.test(m.subject || ""));
ok("[live lane] orchestrator mailbox contains the R25 ack-debt notify", !!notify, {
	totalOrchMessages: orchMail.length,
	subjects: orchMail.map((m) => m.subject),
});

rmSync(scratch, { recursive: true, force: true });
console.log(`\nR25 FIXTURE ${fail === 0 ? "PASS" : "FAIL"} (${fail} failed, ${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);
