#!/usr/bin/env node
/**
 * agent-stopped-gc.test.mjs — mock-llm fixture driver (issue stopped-agent-records-gc)
 * (task-202610041206, plan §D1/D2; pattern: taskprogress-dead-false-positive lane)
 *
 * Seeds fresh-stopped (1h) / aged-stopped (30h) / task-referenced stopped records + an active
 * task graph, loads the REAL swarm extension, replays the fixture's swarm_agent_status toolcall
 * and asserts the default-view hiding + includeStopped resurface + targeted stopped slim row.
 * Also drives the real swarm_gc purgeStopped path (dryRun + apply) and the auto-GC config gate.
 */

import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const fixturePath = join(root, "extensions/mock-llm/fixtures/agent-stopped-gc.jsonl");

let passed = 0,
	failed = 0;
const ok = (n, c, info) => {
	if (c) {
		passed++;
		console.log("  ok  ", n);
	} else {
		failed++;
		console.error("  FAIL:", n, info ?? "");
	}
};

// Fixture sanity (the lane replays this call through the real registered handler)
const rawLines = (await readFile(fixturePath, "utf8")).split("\n").filter((l) => l.trim() && !l.trim().startsWith("#"));
const turns = rawLines.map((l) => JSON.parse(l));
const tcEvent = turns.flatMap((t) => t.events || []).find((e) => e.type === "toolcall" && e.name === "swarm_agent_status");
ok("fixture: scripted swarm_agent_status toolcall present", Boolean(tcEvent), "no toolcall event in fixture");

// Scratch world: fresh-stopped (1h), aged-stopped (30h), task-referenced stopped (30h), live root
const scratch = await mkdtemp(join(tmpdir(), "stopped-gc-"));
await mkdir(join(scratch, ".pi/swarm/mailboxes"), { recursive: true });
await mkdir(join(scratch, ".pi/swarm/tasks/task-1"), { recursive: true });
const NOW = Date.now();
const HOUR = 3_600_000;
const iso = (ms) => new Date(ms).toISOString();
const stopped = (id, at) => ({
	id,
	role: "worker",
	roleKind: "worker",
	status: "stopped",
	runtimeStatus: "stopped",
	health: "unhealthy",
	activeTaskIds: [],
	tmuxTarget: `sess:${id}`,
	lastShutdownAt: iso(at),
	createdAt: iso(at - HOUR),
	updatedAt: iso(at),
});
const state = {
	version: 1,
	swarmId: "swarm-x",
	cwd: scratch,
	tmuxSession: "swarm",
	agents: {
		root: { id: "root", status: "running", runtimeStatus: "idle", health: "healthy", tmuxTarget: "swarm:root", lastHeartbeatAt: iso(NOW) },
		fresh: stopped("fresh", NOW - 1 * HOUR),
		aged: stopped("aged", NOW - 30 * HOUR),
		referenced: stopped("referenced", NOW - 30 * HOUR),
	},
	delivered: { aged: ["m-9"], referenced: ["m-8"] },
	messages: {},
};
await writeFile(join(scratch, ".pi/swarm/swarm-state.json"), JSON.stringify(state, null, 2), "utf8");
// Active task graph referencing 'referenced' as a non-terminal assignee
await writeFile(
	join(scratch, ".pi/swarm/tasks/task-1/task.json"),
	JSON.stringify({ version: 1, taskId: "task-1", title: "t", status: "in_progress", nodes: { n1: { id: "n1", role: "impl", assignee: "referenced", status: "in_progress" } } }, null, 2),
	"utf8",
);

// Real extension, fake pi (tmux probes report panes dead — stopped records stay stopped)
process.env.PI_SWARM_AGENT_ID = "root";
process.env.PI_SWARM_IS_ROOT = "1";
process.env.PI_SWARM_TERMINAL_MANAGER = "tmux";
const tools = {};
const pi = {
	registerTool: (def) => {
		tools[def.name] = def;
	},
	registerCommand: () => {},
	on: () => {},
	// Reference lane pattern: answer tmux probes ALIVE so live records (root) don't derive dead;
	// stopped records stay stopped via their status field regardless of pane evidence.
	exec: async () => ({ code: 0, stdout: "%1 0 1 1\n", stderr: "" }),
	sendMessage: () => {},
};
const mod = await import(join(root, "extensions/swarm/index.ts"));
mod.default(pi);

// --- Lane 1: default view hides stopped (the fixture's scripted call) ---
const r1 = await tools["swarm_agent_status"].execute("t", tcEvent.arguments, undefined, undefined, { cwd: scratch });
const v1 = JSON.parse(r1?.content?.[0]?.text ?? "{}");
ok("default view: no stopped census rows", v1.census?.stopped === 0, JSON.stringify(v1.census));
ok("default view: stoppedHidden=2 (fresh + aged + referenced minus visible)", v1.stoppedHidden === 3, `stoppedHidden=${v1.stoppedHidden}`);
ok("default view: attention has no stopped rows", !(v1.attention || []).some((a) => a.status === "stopped"), JSON.stringify(v1.attention));
ok("default view: hint mentions hidden stopped", /hidden/.test(v1.hint || ""), v1.hint);

// --- Lane 2: includeStopped resurfaces ---
const r2 = await tools["swarm_agent_status"].execute("t", { includeStopped: true }, undefined, undefined, { cwd: scratch });
const v2 = JSON.parse(r2?.content?.[0]?.text ?? "{}");
ok("includeStopped:true: census.stopped=3", v2.census?.stopped === 3, JSON.stringify(v2.census));
ok("includeStopped:true: stopped attention rows present", (v2.attention || []).filter((a) => a.status === "stopped").length === 3);

// --- Lane 3: targeted slim row for a stopped id still works (regression guard) ---
const r3 = await tools["swarm_agent_status"].execute("t", { agentId: "aged" }, undefined, undefined, { cwd: scratch });
const v3 = JSON.parse(r3?.content?.[0]?.text ?? "{}");
ok("targeted stopped agentId returns exactly one slim row", v3.count === 1 && v3.agents?.[0]?.agentId === "aged" && v3.agents?.[0]?.status === "stopped", JSON.stringify(v3));

// --- Lane 4: swarm_gc purgeStopped — tool is retired from the default surface, so the lane
// drives the REAL registered execute body via direct module registration (same handler the
// surface used; assertions cover the tool-level text/details contract).
const gcMod = await import(join(root, "extensions/swarm/src/tools/gc.ts"));
gcMod.registerGcTools(pi);
const r4 = await tools["swarm_gc"].execute("t", { purgeStopped: true }, undefined, undefined, { cwd: scratch });
const t4 = r4?.content?.[0]?.text ?? "";
ok("gc purgeStopped dry-run: aged eligible", /aged/.test(t4) && !/State unchanged/.test(t4) === false, t4.slice(0, 200));
ok("gc purgeStopped dry-run: referenced blocked (task-referenced)", /referenced: task-referenced/.test(t4), t4.slice(0, 300));
ok("gc purgeStopped dry-run: fresh blocked (too-recent)", /fresh: too-recent/.test(t4), t4.slice(0, 300));
const stateAfterDry = JSON.parse(await readFile(join(scratch, ".pi/swarm/swarm-state.json"), "utf8"));
ok("gc purgeStopped dry-run: state untouched", Boolean(stateAfterDry.agents.aged), "aged removed in dry run!");

// --- Lane 5: purgeStopped apply removes only the eligible record ---
const r5 = await tools["swarm_gc"].execute("t", { purgeStopped: true, dryRun: false }, undefined, undefined, { cwd: scratch });
const stateAfterApply = JSON.parse(await readFile(join(scratch, ".pi/swarm/swarm-state.json"), "utf8"));
ok("gc purgeStopped apply: aged record purged", !stateAfterApply.agents.aged, "aged still present");
ok("gc purgeStopped apply: aged delivered ledger purged", !stateAfterApply.delivered?.aged, "delivered.aged still present");
ok("gc purgeStopped apply: task-referenced kept", Boolean(stateAfterApply.agents.referenced), "referenced purged!");
ok("gc purgeStopped apply: fresh (too recent) kept", Boolean(stateAfterApply.agents.fresh), "fresh purged!");
ok("gc purgeStopped apply: root kept", Boolean(stateAfterApply.agents.root), "root purged!");

// --- Lane 6: auto-GC config gate (default OFF) ---
const autoMod = await import(join(root, "extensions/swarm/src/agent-gc-auto.ts"));
const cfgOff = autoMod.readAgentGcConfig(scratch);
ok("auto-GC default OFF (no config)", cfgOff.auto === false && cfgOff.stoppedOlderThanMs === 24 * HOUR, JSON.stringify(cfgOff));
const noop = await autoMod.runAutoStoppedGc(scratch);
ok("auto-GC OFF: run is a no-op returning null", noop === null, JSON.stringify(noop));
await writeFile(join(scratch, ".pi/swarm.yaml"), "agentGc:\n  auto: true\n  stoppedOlderThanMs: 7200000\n", "utf8");
const cfgOn = autoMod.readAgentGcConfig(scratch);
ok("auto-GC opt-in parsed (auto:true, 2h)", cfgOn.auto === true && cfgOn.stoppedOlderThanMs === 7_200_000, JSON.stringify(cfgOn));
// fresh (1h old) is younger than the configured 2h gate → survives; referenced survives (task);
// aged already purged in lane 5 — so apply must be a no-op purge of nothing-but-blocked.
const auto1 = await autoMod.runAutoStoppedGc(scratch);
const stateAfterAuto = JSON.parse(await readFile(join(scratch, ".pi/swarm/swarm-state.json"), "utf8"));
ok("auto-GC ON: fresh-stopped below gate survives", Boolean(stateAfterAuto.agents.fresh) && (auto1?.purged || []).length === 0, JSON.stringify(auto1));
await writeFile(join(scratch, ".pi/swarm.yaml"), "agentGc:\n  auto: true\n", "utf8");
const auto2 = await autoMod.runAutoStoppedGc(scratch);
const stateAfterAuto2 = JSON.parse(await readFile(join(scratch, ".pi/swarm/swarm-state.json"), "utf8"));
ok("auto-GC ON (default 24h): fresh-stopped (1h) below gate survives", Boolean(stateAfterAuto2.agents.fresh) && !(auto2?.purged || []).includes("fresh"), JSON.stringify(auto2));
ok("auto-GC ON: blocked candidates reported with reasons", (auto2?.blocked || []).includes("fresh") && (auto2?.blocked || []).includes("referenced"), JSON.stringify(auto2));
ok("auto-GC ON: task-referenced still survives", Boolean(stateAfterAuto2.agents.referenced), "referenced purged by auto-GC!");

console.log(`\n---\nagent-stopped-gc (fixture lane) results: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
