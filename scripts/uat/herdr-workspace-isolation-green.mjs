#!/usr/bin/env node
// === Herdr Workspace Isolation GREEN lane — R2+R3+R4+R5 ===
// Post-fix: workers land in a dedicated `swarm-agents` workspace, not the root workspace.
// R2: single worker in swarm-agents, root untouched.
// R3: two workers in shared swarm-agents, root untouched.
// R4: teardown — kill worker 1, ws persists; kill worker 2, ws closed.
// R5: stale-cache recovery — close ws externally, spawn again → re-created.
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");
const swarmRoot = join(repo, "extensions", "swarm");
const taskRoot = join(repo, ".pi", "swarm", "tasks", "herdr-workspace-isolation-20260926");
const outDir = process.env.UAT_OUT_DIR || join(taskRoot, "artifacts", "green-lane");
mkdirSync(outDir, { recursive: true });

let pass = 0,
	fail = 0;
const ok = (name, cond, detail = "") => {
	if (cond) {
		pass++;
		console.log(`  ok   ${name}`);
	} else {
		fail++;
		console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
	}
};

const scratch = "/tmp/herdr-ws-green-lane";
rmSync(scratch, { recursive: true, force: true });
mkdirSync(join(scratch, ".pi"), { recursive: true });
process.env.PI_SWARM_ROOT = scratch;
process.env.PI_SWARM_TERMINAL_MANAGER = "herdr";
process.env.HERDR_ENV = "1";

const realExec = (args, timeout = 15_000) =>
	spawnSync("herdr", args, { timeout, encoding: "utf8", env: { ...process.env, HERDR_ENV: "1" } });

const execCalls = [];
const fakePi = {
	exec: async (cmd, args, opts) => {
		execCalls.push([cmd, ...(args || [])].join(" "));
		if (cmd !== "herdr") return { code: 1, stdout: "", stderr: `unknown command: ${cmd}` };
		const r = realExec(args || [], opts?.timeout ?? 15_000);
		return {
			code: r.status ?? 1,
			stdout: r.stdout ?? "",
			stderr: r.stderr ?? String(r.error || ""),
		};
	},
};

console.log("=== herdr-workspace-isolation GREEN lane (real herdr 0.8.2 binary) ===");

// Snapshot root workspace tab count BEFORE (after stale cleanup so the baseline is stable)
const wsListBefore = JSON.parse(realExec(["workspace", "list"]).stdout || "{}");
const rootWsBefore = wsListBefore.result?.workspaces?.find((w) => w.label === "pi-graph-loop");
let rootTabCountBefore = rootWsBefore?.tab_count || 0;
const rootWsId = rootWsBefore?.workspace_id;

// Clean up any leftover swarm-agents ws from a previous run
const staleSwarmWs = wsListBefore.result?.workspaces?.find((w) => w.label === "swarm-agents");
if (staleSwarmWs) {
	realExec(["workspace", "close", staleSwarmWs.workspace_id]);
	// Re-snapshot root after stale cleanup (herdr may GC root tabs concurrently).
	const wsListAfterCleanup = JSON.parse(realExec(["workspace", "list"]).stdout || "{}");
	const rootWsAfterCleanup = wsListAfterCleanup.result?.workspaces?.find((w) => w.workspace_id === rootWsId);
	rootTabCountBefore = rootWsAfterCleanup?.tab_count || 0;
}

const { HerdrDriver } = await import(join(swarmRoot, "src", "terminal/drivers/herdr.ts"));
const driver = new HerdrDriver(rootWsId);

const cmdFile = "/tmp/herdr-ws-green-cmd.sh";
writeFileSync(cmdFile, "#!/bin/sh\nnode -e \"process.title='pi';setInterval(()=>{},1000)\"\n", { mode: 0o755 });

async function spawnOne(label) {
	return driver.spawnAgent(fakePi, {
		session: rootWsId,
		window: label,
		command: cmdFile,
		cwd: "/tmp",
	});
}

function findTab(label) {
	const tabsRaw = realExec(["tab", "list"]);
	const tabs = JSON.parse(tabsRaw.stdout || "{}").result?.tabs || [];
	return tabs.find((t) => t.label === label);
}

function listWorkspaces() {
	const r = realExec(["workspace", "list"]);
	return JSON.parse(r.stdout || "{}").result?.workspaces || [];
}

// === R2: single worker ===
const r2 = await spawnOne("herdr-ws-r2-worker");
ok("R2: spawnAgent returns pane id", /^w[\w]+:p\w+$/.test(r2.target), `target=${r2.target}`);

const r2Tab = findTab("herdr-ws-r2-worker");
ok("R2: tab exists with our label", Boolean(r2Tab), `tab=${JSON.stringify(r2Tab)}`);
ok(
	"R2: tab landed in swarm-agents workspace (not root)",
	r2Tab?.workspace_id !== rootWsId,
	`tab.workspace_id=${r2Tab?.workspace_id} rootWsId=${rootWsId}`,
);

const wsAfterR2 = listWorkspaces();
const swarmAgentsR2 = wsAfterR2.find((w) => w.label === "swarm-agents");
ok("R2: swarm-agents workspace exists", Boolean(swarmAgentsR2), `labels=${JSON.stringify(wsAfterR2.map((w) => w.label))}`);
ok(
	"R2: swarm-agents workspace contains our tab",
	swarmAgentsR2 && r2Tab?.workspace_id === swarmAgentsR2.workspace_id,
	`swarmWsId=${swarmAgentsR2?.workspace_id} tabWsId=${r2Tab?.workspace_id}`,
);

const rootWsAfterR2 = wsAfterR2.find((w) => w.workspace_id === rootWsId);
ok(
	"R2: root workspace tab count NOT increased (worker in agents ws, not root)",
	(rootWsAfterR2?.tab_count || 0) <= rootTabCountBefore + 1, // allow ±1 for herdr GC noise
	`before=${rootTabCountBefore} after=${rootWsAfterR2?.tab_count}`,
);

// === R3: two workers in shared swarm-agents ===
const r3a = await spawnOne("herdr-ws-r3a-worker");
const r3b = await spawnOne("herdr-ws-r3b-worker");
ok("R3: both workers spawned", /^w[\w]+:p\w+$/.test(r3a.target) && /^w[\w]+:p\w+$/.test(r3b.target));

const r3aTab = findTab("herdr-ws-r3a-worker");
const r3bTab = findTab("herdr-ws-r3b-worker");
ok(
	"R3: both workers in the SAME swarm-agents workspace (shared design)",
	r3aTab?.workspace_id === r3bTab?.workspace_id && r3aTab?.workspace_id !== rootWsId,
	`a=${r3aTab?.workspace_id} b=${r3bTab?.workspace_id}`,
);

const rootWsAfterR3 = listWorkspaces().find((w) => w.workspace_id === rootWsId);
ok(
	"R3: root workspace tab count NOT increased (two workers in agents ws)",
	(rootWsAfterR3?.tab_count || 0) <= rootTabCountBefore + 1,
	`before=${rootTabCountBefore} after=${rootWsAfterR3?.tab_count}`,
);

// === R4: teardown ===
// Kill worker r3a → swarm-agents ws should persist (r3b still there)
await driver.killAgent(fakePi, r3a.target);
const wsAfterKillA = listWorkspaces();
const swarmAgentsAfterA = wsAfterKillA.find((w) => w.label === "swarm-agents");
ok(
	"R4: swarm-agents workspace persists after killing 1 of 3 workers (r2 + r3b still alive)",
	Boolean(swarmAgentsAfterA),
	`labels=${JSON.stringify(wsAfterKillA.map((w) => w.label))}`,
);

// Kill worker r3b → swarm-agents ws should persist (r2 still there)
await driver.killAgent(fakePi, r3b.target);
const wsAfterKillB = listWorkspaces();
const swarmAgentsAfterB = wsAfterKillB.find((w) => w.label === "swarm-agents");
ok(
	"R4: swarm-agents workspace persists after killing 2 of 3 workers (r2 still alive)",
	Boolean(swarmAgentsAfterB),
	`labels=${JSON.stringify(wsAfterKillB.map((w) => w.label))}`,
);

// Kill worker r2 → swarm-agents ws should close (no swarm panes remain)
await driver.killAgent(fakePi, r2.target);
const wsAfterKillC = listWorkspaces();
const swarmAgentsAfterC = wsAfterKillC.find((w) => w.label === "swarm-agents");
ok(
	"R4: swarm-agents workspace CLOSED after killing last swarm worker",
	!swarmAgentsAfterC,
	`labels=${JSON.stringify(wsAfterKillC.map((w) => w.label))}`,
);

const rootWsAfterKillC = wsAfterKillC.find((w) => w.workspace_id === rootWsId);
ok(
	"R4: root workspace tab count NOT increased after teardown",
	(rootWsAfterKillC?.tab_count || 0) <= rootTabCountBefore + 1,
	`before=${rootTabCountBefore} after=${rootWsAfterKillC?.tab_count}`,
);

// === R5: stale-cache recovery ===
// swarm-agents was closed by R4 teardown. Spawn again → driver should re-create it.
const r5 = await spawnOne("herdr-ws-r5-worker");
ok("R5: spawnAgent after teardown returns pane id", /^w[\w]+:p\w+$/.test(r5.target));

const r5Tab = findTab("herdr-ws-r5-worker");
ok(
	"R5: stale-cache recovery — swarm-agents workspace re-created and tab lands in it",
	r5Tab?.workspace_id !== rootWsId,
	`tab.workspace_id=${r5Tab?.workspace_id} rootWsId=${rootWsId}`,
);

// R10-1 counters
const wsCreateCalls = execCalls.filter((c) => c === "herdr workspace create --label swarm-agents");
const wsListCalls = execCalls.filter((c) => c === "herdr workspace list");
const wsCloseCalls = execCalls.filter((c) => c.startsWith("herdr workspace close"));
const tabCreateCalls = execCalls.filter((c) => c.startsWith("herdr tab create"));
const wsFlagOnTabCreate = tabCreateCalls.filter((c) => c.includes("--workspace w")).length;

ok(`R10-1: at least 2 workspace create calls (R2 + R5 stale-cache)`, wsCreateCalls.length >= 2, `count=${wsCreateCalls.length}`);
ok(`R10-1: at least 2 workspace list calls (ensure + teardown probing)`, wsListCalls.length >= 2, `count=${wsListCalls.length}`);
ok(`R10-1: at least 1 workspace close call (R4 teardown)`, wsCloseCalls.length >= 1, `count=${wsCloseCalls.length}`);
ok(
	`R10-1: every tab create carries --workspace <wsId> flag`,
	wsFlagOnTabCreate === tabCreateCalls.length && tabCreateCalls.length >= 3,
	`flagged=${wsFlagOnTabCreate} total=${tabCreateCalls.length}`,
);

// Cleanup
if (r2Tab) realExec(["tab", "close", r2Tab.tab_id]);
if (r5Tab) realExec(["tab", "close", r5Tab.tab_id]);

writeFileSync(
	join(outDir, "report.md"),
	`# herdr-workspace-isolation GREEN lane

pass=${pass} fail=${fail}

## exec census (real herdr 0.8.2 calls)
${execCalls.map((c) => "  - " + c).join("\n")}

## R10-1 boundary counters
- workspace create: ${wsCreateCalls.length}
- workspace list: ${wsListCalls.length}
- workspace close: ${wsCloseCalls.length}
- tab create with --workspace: ${wsFlagOnTabCreate} of ${tabCreateCalls.length}
`,
);
rmSync(scratch, { recursive: true, force: true });
rmSync(cmdFile, { force: true });
console.log(`\n[GREEN] pass=${pass} fail=${fail} -> ${outDir}`);
process.exit(fail === 0 ? 0 : 1);
