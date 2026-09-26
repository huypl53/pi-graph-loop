// === H5 lane: workspace-create root tab is closed after first agent spawn ===
// RED: ensureAgentsWorkspace creates ws with an idle shell root tab that stays forever
//      (live observation 2026-09-26: swarm-agents wK:t1 label '1', idle zsh).
// GREEN: driver closes the root tab right after the first agent tab is created;
//        workspace survives (>=1 tab remains), no dead shell tab.
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";

const ROOT = resolve(import.meta.dirname, "..", "..");
const OUT = process.env.UAT_OUT_DIR || join(ROOT, ".pi/swarm-uat/runs/herdr-ws-root-tab");
const PHASE = process.env.UAT_PHASE || "red";
const WS_LABEL = process.env.PROBE_WS_LABEL || "swarm-h5-probe";
mkdirSync(OUT, { recursive: true });

function herdr(args) {
	return spawnSync("herdr", args, { encoding: "utf8" });
}
function wsList() {
	const r = herdr(["workspace", "list"]);
	try {
		return JSON.parse(r.stdout).result.workspaces;
	} catch {
		return [];
	}
}
function tabsOf(wsId) {
	const r = herdr(["tab", "list", "--workspace", wsId]);
	try {
		return JSON.parse(r.stdout).result.tabs;
	} catch {
		return [];
	}
}
function cleanup(probeWs) {
	if (!probeWs) return;
	for (const t of tabsOf(probeWs.workspace_id)) herdr(["tab", "close", t.tab_id]);
	herdr(["workspace", "close", probeWs.workspace_id]);
}

// pre-clean any stale probe ws
cleanup(wsList().find((w) => w.label === WS_LABEL));

// Drive the REAL driver against the REAL binary with a probe label.
const probe = [
	'import { HerdrDriver } from "' + join(ROOT, "extensions/swarm/src/terminal/drivers/herdr.ts") + '";',
	"const fakePi = { exec: async (cmd, args) => {",
	'  const r = await Bun.spawn(["herdr", ...args]).capture();', // not used; driver calls pi.exec(cmd,args)
	"  return r;",
	"} };",
].join("\n");
// Simpler: drive through a pi.exec adapter that shells out to the real herdr binary:
const probe2 = [
	'import { HerdrDriver } from "' + join(ROOT, "extensions/swarm/src/terminal/drivers/herdr.ts") + '";',
	"const pi = { exec: async (cmd, args) => {",
	'  const p = Bun.spawnSync({ cmd: ["herdr", ...args], stdout: "pipe", stderr: "pipe" });',
	"  return { code: p.exitCode, stdout: new TextDecoder().decode(p.stdout), stderr: new TextDecoder().decode(p.stderr) };",
	"} };",
	"const d = new HerdrDriver();",
	'process.env.PI_SWARM_HERDR_WS_LABEL = "' + WS_LABEL + '";',
	'await d.spawnAgent(pi, { session: "w1", window: "h5-probe-agent", command: "sleep 30", cwd: "' + ROOT + '" });',
	'console.log("SPAWNED");',
].join("\n");
writeFileSync(join(OUT, "probe.mts"), probe2);

const run = spawnSync("bun", [resolve(join(OUT, "probe.mts"))], { encoding: "utf8", cwd: OUT });
const spawned = (run.stdout || "").includes("SPAWNED");

let pass = 0,
	fail = 0;
const results = [];
function check(name, ok, detail) {
	results.push(name + " -> " + (ok ? "PASS" : "FAIL") + " (" + detail + ")");
	ok ? pass++ : fail++;
}

const ws = wsList().find((w) => w.label === WS_LABEL);
check("driver spawned agent via real binary", spawned, (run.stderr || "").split("\n").slice(-1)[0].slice(0, 80));
const tabs = ws ? tabsOf(ws.workspace_id) : [];
const tabLabels = tabs.map((t) => String(t.label));
check(
	"workspace exists with exactly the agent tab (root tab closed)",
	spawned && tabs.length === 1 && tabLabels.includes("h5-probe-agent"),
	tabs.length + " tabs: " + JSON.stringify(tabLabels),
);

// teardown: close agent tab -> ws should auto-close or be closable
cleanup(ws);
writeFileSync(
	join(OUT, "report-" + PHASE + ".md"),
	"# H5 lane (" + PHASE + ")\n\npass=" + pass + " fail=" + fail + "\n\n" + results.map((r) => "- " + r).join("\n") + "\n",
);
console.log(results.join("\n"));
console.log("RESULT: pass=" + pass + " fail=" + fail);
process.exit(fail === 0 ? 0 : 1);
