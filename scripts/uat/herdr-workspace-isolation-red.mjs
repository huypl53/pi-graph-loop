#!/usr/bin/env node
// === Herdr Workspace Isolation RED lane (pre-fix) — R1 ===
// Drives the REAL HerdrDriver against the REAL herdr 0.8.2 binary at the pi.exec seam.
// Observed RED before the herdr.ts fix lands; stored under
// artifacts/red-lane-pre-fix/ via UAT_OUT_DIR.
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");
const swarmRoot = join(repo, "extensions", "swarm");
const taskRoot = join(repo, ".pi", "swarm", "tasks", "herdr-workspace-isolation-20260926");
const outDir = process.env.UAT_OUT_DIR || join(taskRoot, "artifacts", "red-lane");
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

const scratch = "/tmp/herdr-ws-red-lane";
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

console.log("=== herdr-workspace-isolation RED lane (real herdr 0.8.2 binary at pi.exec boundary) ===");

// Snapshot root workspace tab count BEFORE
const wsListBefore = JSON.parse(realExec(["workspace", "list"]).stdout || "{}");
const rootWsBefore = wsListBefore.result?.workspaces?.find((w) => w.label === "pi-graph-loop");
const rootTabCountBefore = rootWsBefore?.tab_count || 0;
const rootWsId = rootWsBefore?.workspace_id;

const { HerdrDriver } = await import(join(swarmRoot, "src", "terminal/drivers/herdr.ts"));
const driver = new HerdrDriver(rootWsId); // simulate root driver with root workspace id

// R1: spawnAgent — pre-fix lands in root workspace
const cmdFile = "/tmp/herdr-ws-red-cmd.sh";
writeFileSync(cmdFile, "#!/bin/sh\nnode -e \"process.title='pi';setInterval(()=>{},1000)\"\n", { mode: 0o755 });

const spawnRes = await driver.spawnAgent(fakePi, {
	session: rootWsId,
	window: "herdr-ws-red-worker",
	command: cmdFile,
	cwd: "/tmp",
});

ok("R1: spawnAgent returns pane id", /^w\d+:p\w+$/.test(spawnRes.target), `target=${spawnRes.target}`);

// Check what workspace the tab landed in
const tabsRaw = realExec(["tab", "list"]);
const tabs = JSON.parse(tabsRaw.stdout || "{}").result?.tabs || [];
const ourTab = tabs.find((t) => t.label === "herdr-ws-red-worker");
ok("R1: tab exists with our label", Boolean(ourTab), `tab=${JSON.stringify(ourTab)}`);

// Pre-fix MISMATCH: tab lands in ROOT workspace (not swarm-agents)
ok(
	"R1: tab landed in ROOT workspace (pre-fix MISMATCH — should be swarm-agents)",
	ourTab?.workspace_id === rootWsId,
	`tab.workspace_id=${ourTab?.workspace_id} rootWsId=${rootWsId}`,
);

// Check if swarm-agents workspace exists (it shouldn't pre-fix)
const wsListAfter = JSON.parse(realExec(["workspace", "list"]).stdout || "{}");
const swarmAgentsWs = wsListAfter.result?.workspaces?.find((w) => w.label === "swarm-agents");
ok(
	"R1: NO swarm-agents workspace exists (pre-fix — driver never creates it)",
	!swarmAgentsWs,
	`workspaces=${JSON.stringify(wsListAfter.result?.workspaces?.map((w) => w.label))}`,
);

// Root workspace tab count increased (pre-fix — worker landed in root)
const rootWsAfter = wsListAfter.result?.workspaces?.find((w) => w.workspace_id === rootWsId);
const rootTabCountAfter = rootWsAfter?.tab_count || 0;
ok(
	"R1: root workspace tab count INCREASED (pre-fix — worker polluted root ws)",
	rootTabCountAfter > rootTabCountBefore,
	`before=${rootTabCountBefore} after=${rootTabCountAfter}`,
);

// R10-1: zero workspace ops in pre-fix (bypass proof)
const workspaceOps = execCalls.filter((c) => c.startsWith("herdr workspace"));
ok(
	"R1: driver emitted ZERO workspace operations (pre-fix bypass proof)",
	workspaceOps.length === 0,
	`workspaceOps=${JSON.stringify(workspaceOps)}`,
);

// Cleanup
if (ourTab) realExec(["tab", "close", ourTab.tab_id]);

writeFileSync(
	join(outDir, "report.md"),
	`# herdr-workspace-isolation RED lane (pre-fix)

pass=${pass} fail=${fail}

## exec census (real herdr 0.8.2 calls emitted by the driver)
${execCalls.map((c) => "  - " + c).join("\n")}

## Pre-fix MISMATCH evidence
- R1: worker tab landed in ROOT workspace (${rootWsId}, label="pi-graph-loop") instead of
  a dedicated "swarm-agents" workspace.
- R1: root workspace tab count increased from ${rootTabCountBefore} to ${rootTabCountAfter}
  (worker polluted root ws).
- R1: driver emitted ZERO workspace operations (no workspace list/create/close).
- R1: no "swarm-agents" workspace exists.

## Fix path
- ensureAgentsWorkspace(): list→match label "swarm-agents"→create-if-absent, cache id.
- spawnAgent: tab create --workspace <agentsWsId> (not root ws).
- Teardown: close workspace only when zero swarm-agent panes remain.
`,
);
rmSync(scratch, { recursive: true, force: true });
rmSync(cmdFile, { force: true });
console.log(`\n[RED] pass=${pass} fail=${fail} -> ${outDir}`);
process.exit(0); // Don't fail the script — the RED evidence is the fail count
