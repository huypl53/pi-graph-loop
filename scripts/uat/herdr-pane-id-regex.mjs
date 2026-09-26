// === H4 lane: herdr pane-id regex misclassifies non-numeric workspace ids (wK:p5) ===
// RED: isValidHerdrPaneId("wK:p5") === false (regex requires digits) → inspectProcess falls to
//      label-resolution → pane list titles are null → piLike:false → engine marks live agents dead.
// GREEN: regex accepts workspace ids with letters/digits ([A-Za-z0-9_-]+) → direct probe works.
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";

const ROOT = resolve(import.meta.dirname, "..", "..");
const OUT = process.env.UAT_OUT_DIR || join(ROOT, ".pi/swarm-uat/runs/herdr-pane-id-regex");
const PHASE = process.env.UAT_PHASE || "red";
mkdirSync(OUT, { recursive: true });

const probe = [
	'import { HerdrDriver } from "' + join(ROOT, "extensions/swarm/src/terminal/drivers/herdr.ts") + '";',
	"const fakePi = { exec: async (cmd, args) => {",
	'  if (args[1] === "process-info") {',
	'    if (args[2] === "--pane" && args[3] === "wK:p5") {',
	'      return { code: 0, stdout: JSON.stringify({ result: { process_info: { foreground_processes: [{ name: "pi", pid: 1, cmdline: "pi" }] } } }), stderr: "" };',
	"    }",
	'    return { code: 1, stdout: "", stderr: "unknown option" };',
	"  }",
	'  if (args[1] === "list") return { code: 0, stdout: JSON.stringify({ result: { panes: [{ paneId: "wK:p5", title: null }] } }), stderr: "" };',
	'  return { code: 0, stdout: "{}", stderr: "" };',
	"} };",
	"const d = new HerdrDriver();",
	'const ok = await d.isTargetAlive(fakePi, "wK:p5");',
	'console.log("ALIVE:" + ok);',
].join("\n");
writeFileSync(join(OUT, "probe.mts"), probe);

const r = spawnSync("bun", [resolve(join(OUT, "probe.mts"))], {
	encoding: "utf8",
	env: { ...process.env, PI_SWARM_TERMINAL_MANAGER: "" },
	cwd: OUT,
});
const alive = (r.stdout || "").match(/ALIVE:(\S+)/)?.[1] || "ERR:" + (r.stderr || "").split("\n").slice(-1)[0];

// Live cross-check against the REAL binary + real pane (wK:p5 hosts pi right now):
const live = spawnSync("herdr", ["pane", "process-info", "--pane", "wK:p5"], { encoding: "utf8" });
const liveOk = live.status === 0 && (live.stdout || "").includes("foreground_processes");

const results = [
	{ name: "driver isTargetAlive('wK:p5') with real-CLI-shaped mock → true", pass: alive === "true", got: alive },
	{
		name: "REAL herdr binary: process-info --pane wK:p5 returns foreground_processes",
		pass: liveOk,
		got: liveOk ? "yes" : "no: " + (live.stderr || live.stdout || "").slice(0, 60),
	},
];
let pass = 0,
	fail = 0;
for (const t of results) {
	t.pass ? pass++ : fail++;
	console.log((t.pass ? "PASS" : "FAIL") + ": " + t.name + " (got " + t.got + ")");
}
writeFileSync(
	join(OUT, "report-" + PHASE + ".md"),
	"# H4 lane (" +
		PHASE +
		")\n\npass=" +
		pass +
		" fail=" +
		fail +
		"\n\n- driver isTargetAlive wK:p5: " +
		alive +
		"\n- real binary probe: " +
		(liveOk ? "ok" : "fail") +
		"\n",
);
console.log("RESULT: pass=" + pass + " fail=" + fail);
process.exit(fail === 0 ? 0 : 1);
