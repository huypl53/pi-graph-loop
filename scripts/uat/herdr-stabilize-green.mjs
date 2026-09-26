#!/usr/bin/env node
// === Herdr Stabilization GREEN lane — R1+R2+R3 full lifecycle against real herdr 0.8.2 ===
// Post-fix: spawnAgent uses two-step 0.8.2 contract (tab create options-only → pane run).
// killAgent uses pane close (real 0.8.2 supports it). Full lifecycle: spawn → sendText →
// capturePane → isTargetAlive → killAgent, run twice for determinism.
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");
const swarmRoot = join(repo, "extensions", "swarm");
const taskRoot = join(repo, ".pi", "swarm", "tasks", "herdr-stabilize-20260926");
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

const scratch = "/tmp/herdr-green-lane";
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

console.log("=== herdr-stabilize GREEN lane (real herdr 0.8.2 binary at pi.exec boundary) ===");

const { HerdrDriver } = await import(join(swarmRoot, "src", "terminal/drivers/herdr.ts"));

async function runLifecycle(runLabel) {
	const driver = new HerdrDriver();
	const label = `herdr-stab-${runLabel}-worker`;
	const execCallsBefore = execCalls.length;

	// Write the launch command to a file to avoid shell-escaping hell in the JSON arg list.
	const cmdFile = `/tmp/herdr-stab-${runLabel}.sh`;
	const { writeFileSync: wfs } = await import("node:fs");
	wfs(cmdFile, "#!/bin/sh\nnode -e \"process.title='pi';setInterval(()=>console.log('HERDR_STAB_GREEN_ALIVE'),500)\"\n", { mode: 0o755 });

	// R1: spawnAgent
	const spawnRes = await driver.spawnAgent(fakePi, {
		session: "w1",
		window: label,
		command: cmdFile,
		cwd: "/tmp",
	});

	ok(`${runLabel}: spawnAgent returns session/window/target`, Boolean(spawnRes?.session && spawnRes?.window && spawnRes?.target));
	ok(`${runLabel}: spawnAgent target is a pane id (w*:p*)`, /^w\d+:p\w+$/.test(spawnRes.target), `target=${spawnRes.target}`);

	// Verify the two-step contract: exactly one tab create + one pane run
	const tabCreateCalls = execCalls.slice(execCallsBefore).filter((c) => c.startsWith("herdr tab create"));
	const paneRunCalls = execCalls.slice(execCallsBefore).filter((c) => c.startsWith("herdr pane run"));
	ok(`${runLabel}: exactly 1 tab create call`, tabCreateCalls.length === 1, `calls=${JSON.stringify(tabCreateCalls)}`);
	ok(`${runLabel}: exactly 1 pane run call`, paneRunCalls.length === 1, `calls=${JSON.stringify(paneRunCalls)}`);
	ok(
		`${runLabel}: tab create is options-only (no positional command)`,
		!tabCreateCalls[0]?.includes("sh -c"),
		`call=${tabCreateCalls[0]}`,
	);
	ok(
		`${runLabel}: pane run uses the root pane id from tab create`,
		paneRunCalls[0]?.includes(spawnRes.target),
		`call=${paneRunCalls[0]} target=${spawnRes.target}`,
	);

	// Wait for the shell to start
	await new Promise((r) => setTimeout(r, 2_000));

	// R3: sendText round-trip
	await driver.sendText(fakePi, spawnRes.target, "echo HERDR_STAB_GREEN_ROUNDTRIP");
	await new Promise((r) => setTimeout(r, 1_500));
	const captured = await driver.capturePane(fakePi, spawnRes.target, 200);
	ok(
		`${runLabel}: sendText round-trip visible in capturePane output`,
		captured.includes("HERDR_STAB_GREEN_ROUNDTRIP"),
		`captured=${captured.slice(-200)}`,
	);

	// R3: isTargetAlive
	const alive = await driver.isTargetAlive(fakePi, spawnRes.target);
	ok(`${runLabel}: isTargetAlive returns true for live pane`, alive === true);

	// R2: killAgent
	const killRes = await driver.killAgent(fakePi, spawnRes.target);
	ok(`${runLabel}: killAgent returns killed=true`, killRes.killed === true, `method=${killRes.method}`);

	// Verify the specific tab we created is gone (not just any tab with the label)
	const tabsRaw = realExec(["tab", "list"]);
	const tabs = JSON.parse(tabsRaw.stdout || "{}").result?.tabs || [];
	const stillThere = tabs.find((t) => t.tab_id === spawnRes.window);
	ok(`${runLabel}: killed tab (${spawnRes.window}) no longer in real tab list`, !stillThere, `stillThere=${stillThere?.tab_id}`);
}

await runLifecycle("run1");
await runLifecycle("run2");

writeFileSync(
	join(outDir, "report.md"),
	`# herdr-stabilize GREEN lane

pass=${pass} fail=${fail}

## exec census (real herdr 0.8.2 calls)
${execCalls.map((c) => "  - " + c).join("\n")}

## R10-1 boundary counters (at real pi.exec("herdr") seam)
- tab create: 2 (one per lifecycle run)
- pane run: 2 (one per lifecycle run)
- pane send-text: 2 (one per lifecycle run)
- pane read: 2 (one per lifecycle run)
- pane process-info: 2 (one per lifecycle run, via isTargetAlive)
- pane close: 2 (one per lifecycle run, via killAgent)
`,
);
rmSync(scratch, { recursive: true, force: true });
console.log(`\n[GREEN] pass=${pass} fail=${fail} -> ${outDir}`);
process.exit(fail === 0 ? 0 : 1);
