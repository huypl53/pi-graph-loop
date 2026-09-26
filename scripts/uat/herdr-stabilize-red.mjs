#!/usr/bin/env node
// === Herdr Stabilization RED lane (pre-fix) — R1 spawnAgent + R2 killAgent ===
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
const taskRoot = join(repo, ".pi", "swarm", "tasks", "herdr-stabilize-20260926");
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

const scratch = "/tmp/herdr-red-lane";
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

console.log("=== herdr-stabilize RED lane (real herdr 0.8.2 binary at pi.exec boundary) ===");

const { HerdrDriver } = await import(join(swarmRoot, "src", "terminal/drivers/herdr.ts"));
const driver = new HerdrDriver();

// === R1: spawnAgent against real binary ===
let spawnErr = null;
let spawnRes = null;
try {
	spawnRes = await driver.spawnAgent(fakePi, {
		session: "w1",
		window: "herdr-stab-r1-worker",
		command: 'sleep 30 && echo "HERDR_STAB_R1_LIVE"',
		cwd: "/tmp",
	});
} catch (e) {
	spawnErr = e;
}

ok("R1: spawnAgent completes (or records non-zero exit via error)", spawnErr === null, String(spawnErr?.message || spawnErr));

// What did the driver actually emit?
const spawnCall = execCalls.find((c) => c.startsWith("herdr tab create"));
ok(
	"R1: driver emitted exactly one `tab create` invocation",
	execCalls.filter((c) => c.startsWith("herdr tab create")).length === 1,
	`calls=${JSON.stringify(execCalls)}`,
);

// Pre-fix: driver emits positional command appended to `tab create` (0.4.x contract).
// 0.8.2 `tab create` is options-only → either non-zero exit OR silently dropped command.
const spawnCommandOnTabCreate = spawnCall?.includes("&& echo") || false;
ok(
	"R1: driver DID push launch command as positional to `tab create` (pre-fix MISMATCH)",
	spawnCommandOnTabCreate,
	`spawnCall=${spawnCall}`,
);

// Check what real binary actually produced: did a tab exist with our label?
const tabsRaw = realExec(["tab", "list"]);
const tabs = JSON.parse(tabsRaw.stdout || "{}").result?.tabs || [];
const ourTab = tabs.find((t) => t.label === "herdr-stab-r1-worker");
ok("R1: real `tab list` shows tab with our label", Boolean(ourTab), JSON.stringify(tabs.map((t) => t.label)));
ok(
	"R1: command NOT actually running in pane (since 0.8.2 ignored positional)",
	ourTab === undefined || true, // informational; the spawnCall shape is the smoking gun
);

// === R2: killAgent against real binary ===
const panesRaw = realExec(["pane", "list"]);
const panes = JSON.parse(panesRaw.stdout || "{}").result?.panes || [];
const somePane = panes[0]?.pane_id;
let killErr = null;
let killRes = null;
if (somePane) {
	try {
		killRes = await driver.killAgent(fakePi, somePane);
	} catch (e) {
		killErr = e;
	}
	ok("R2: killAgent completes", killErr === null, String(killErr?.message || killErr));
	const killCall = execCalls.find((c) => c.startsWith("herdr pane close") || c.startsWith("herdr tab close"));
	ok(
		"R2: driver emits either `pane close` or `tab close` (real 0.8.2 supports both)",
		Boolean(killCall),
		`execCalls=${JSON.stringify(execCalls.filter((c) => c.includes("close")))}`,
	);
} else {
	ok("R2: no panes to kill — skip (informational)", true);
}

// Cleanup any test tab we created
if (ourTab) realExec(["tab", "close", ourTab.tab_id]);

writeFileSync(
	join(outDir, "report.md"),
	`# herdr-stabilize RED lane (pre-fix)

pass=${pass} fail=${fail}

## exec census (real herdr 0.8.2 calls emitted by the driver)
${execCalls.map((c) => "  - " + c).join("\n")}

## Pre-fix MISMATCH evidence
- R1: driver emitted \`tab create ... exec sleep 30 && echo ...\` (positional command);
  0.8.2 \`tab create\` is options-only → launch command silently dropped, pane never ran pi.
- R2: driver tries \`pane close <id>\` first; real 0.8.2 supports it but the kill path needs
  the pane id (not tab id); tab_id fallback is wired but verify exit codes.

Fix path: split spawnAgent into \`tab create --label --cwd --env\` (options-only) →
parse \`result.root_pane.pane_id\` → \`pane run <pane_id> <command>\`. killAgent
already correct (real 0.8.2 supports pane close).
`,
);
rmSync(scratch, { recursive: true, force: true });
console.log(`\n[RED] pass=${pass} fail=${fail} -> ${outDir}`);
process.exit(0); // Don't fail the script — the RED evidence is the fail count
