// === H2 lane: swarm.yml terminalManager wiring (env > cfg > tmux default) ===
// RED: yml declares terminalManager: herdr + env unset → getTerminalDriver() still
//      resolves TmuxDriver (cfg declared-but-unwired). GREEN: same yml resolves HerdrDriver.
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";

const ROOT = resolve(import.meta.dirname, "..", "..");
const OUT = process.env.UAT_OUT_DIR || join(ROOT, ".pi/swarm-uat/runs/herdr-cfg-wiring");
const PHASE = process.env.UAT_PHASE || "red";
mkdirSync(OUT, { recursive: true });

const scratch = join(OUT, "scratch");
mkdirSync(scratch, { recursive: true });
mkdirSync(join(scratch, ".pi"), { recursive: true });

// Harness imports the REAL driver factory and prints the resolved driver class name.
const harness = [
	'import { getTerminalDriver } from "' + join(ROOT, "extensions/swarm/src/terminal/index.ts") + '";',
	"const d = getTerminalDriver();",
	'console.log("DRIVER:" + (d.constructor ? d.constructor.name : typeof d));',
].join("\n");
writeFileSync(join(scratch, "harness.mts"), harness);

function run(cwd) {
	const r = spawnSync("bun", [resolve(join(scratch, "harness.mts"))], {
		encoding: "utf8",
		env: { ...process.env, PI_SWARM_TERMINAL_MANAGER: "" },
		cwd,
	});
	const m = (r.stdout || "").match(/DRIVER:(\S+)/);
	return m ? m[1] : "ERROR:" + (r.stderr || "").split("\n").slice(-2).join(" ");
}

const noYml = run(scratch); // .pi/swarm.yml written below — run from parent-ish dir instead
writeFileSync(join(scratch, ".pi", "swarm.yml"), "terminalManager: herdr\n");
const withYml = run(scratch);
// default check from a dir with no yml
const plain = join(OUT, "plain");
mkdirSync(plain, { recursive: true });
const defaultDriver = run(plain);

const results = [
	{ name: "yml terminalManager: herdr + env unset -> HerdrDriver", got: withYml, pass: withYml === "HerdrDriver" },
	{ name: "no yml + env unset -> TmuxDriver (default unchanged)", got: defaultDriver, pass: defaultDriver === "TmuxDriver" },
];

let pass = 0,
	fail = 0;
for (const t of results) {
	t.pass ? pass++ : fail++;
	console.log((t.pass ? "PASS" : "FAIL") + ": " + t.name + " (got " + t.got + ")");
}
writeFileSync(
	join(OUT, "report-" + PHASE + ".md"),
	"# H2 lane (" +
		PHASE +
		")\n\npass=" +
		pass +
		" fail=" +
		fail +
		"\n\n- driver(env unset, yml herdr): " +
		withYml +
		"\n- driver(env unset, no yml): " +
		defaultDriver +
		"\n- (control run before yml write: " +
		noYml +
		")\n",
);
console.log("RESULT: pass=" + pass + " fail=" + fail);
process.exit(fail === 0 ? 0 : 1);
