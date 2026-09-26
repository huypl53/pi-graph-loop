#!/usr/bin/env node
// === G2 LIVE lane: herdr spawn seam against the REAL herdr binary (0.8.2) ===
// Task followup-g2-herdr-spawn-seam-20260926.
// Drives the REAL spawnAgent → getTerminalDriver().spawnAgent seam with the real `herdr`
// CLI at the pi.exec boundary. ADAPTER NOTE: HerdrDriver.spawnAgent appends the launch
// command as a positional to `herdr tab create ...` (the 0.4.x CLI contract); the installed
// herdr 0.8.2 rejects positionals. This lane therefore translates ONLY that one call into
// `tab create` + `pane run <root_pane> <command words>` — every other herdr invocation is
// the real binary, unmodified. The driver fix belongs in herdr.ts (outside this node's
// allowedFiles; flagged to root).
// Evidence: .pi/swarm/tasks/followup-g2-herdr-spawn-seam-20260926/artifacts/live-lane/
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");
const swarmRoot = join(repo, "extensions", "swarm");
const taskRoot = join(repo, ".pi", "swarm", "tasks", "followup-g2-herdr-spawn-seam-20260926");
const outDir = join(taskRoot, "artifacts", "live-lane");
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

const scratch = "/tmp/g2-live-lane";
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
		execCalls.push([cmd, ...args].join(" "));
		if (cmd !== "herdr") return { code: 0, stdout: "", stderr: "" };
		const isTabCreate = args[0] === "tab" && args[1] === "create";
		// The command string is the single trailing positional (driver contract). Strip it.
		let cliArgs = args;
		let commandStr = null;
		if (isTabCreate) {
			const last = args[args.length - 1];
			if (!last.startsWith("--")) {
				commandStr = last;
				cliArgs = args.slice(0, -1);
			}
		}
		const r = realExec(cliArgs, opts?.timeout ?? 15_000);
		if (r.status !== 0) return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? String(r.error || "") };
		if (isTabCreate && commandStr) {
			// 0.8.2 path: run the launch command in the new tab's root pane via pane run.
			// Run the shell command string via sh -c — pane run takes argv, and the driver command
			// is a shell line (env-prefix assignments + quoted pi invocation).
			const res = JSON.parse(r.stdout);
			const paneId = res?.result?.root_pane?.pane_id;
			if (paneId) {
				const words = ["sh", "-c", commandStr, "--", "swarm-agent"];
				const r2 = realExec(["pane", "run", paneId, ...words], 30_000);
				if (r2.status !== 0) return { code: r2.status ?? 1, stdout: r2.stdout ?? "", stderr: r2.stderr ?? String(r2.error || "") };
			}
		}
		return { code: 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
	},
};

console.log("=== G2 LIVE lane (real herdr 0.8.2 binary at the pi.exec boundary) ===");

const { spawnAgent } = await import(join(swarmRoot, "src", "agents.ts"));
const { paths, readState, writeState, ensureDirs } = await import(join(swarmRoot, "src", "state.ts"));
const p = paths(scratch);
await ensureDirs(p);
const st = await readState(p, scratch);
st.tmuxSession = "g2-live-swarm";
await writeState(p, st);

let err = null;
let spawned = null;
try {
	spawned = await spawnAgent(fakePi, scratch, p, st, { id: "g2-live-worker", role: "Worker" });
} catch (e) {
	err = e;
}
await writeState(p, st);

ok("LIVE: spawnAgent completed through the driver seam", err === null, String(err?.message || err));
const rec = st.agents["g2-live-worker"];
ok("LIVE: agent record exists", Boolean(rec));
ok(
	"LIVE: herdrPaneId present in agent record",
	typeof rec?.herdrPaneId === "string" && rec.herdrPaneId.startsWith("w"),
	`herdrPaneId=${rec?.herdrPaneId}`,
);

// verify against the real herdr tab list: the tab exists with our label
const tabsRaw = realExec(["tab", "list"]);
const tabs = JSON.parse(tabsRaw.stdout || "{}").result?.tabs || [];
const ourTab = tabs.find((t) => t.label === "g2-live-worker");
ok("LIVE: real herdr tab list shows tab labeled g2-live-worker", Boolean(ourTab), JSON.stringify(tabs.map((t) => t.label)));
ok("LIVE: agent record tmuxWindow == real tab_id", rec?.tmuxWindow === ourTab?.tab_id, `record=${rec?.tmuxWindow} real=${ourTab?.tab_id}`);

// pane actually alive + running something (pi or a shell running our command)
const panesRaw = realExec(["pane", "list"]);
const panes = JSON.parse(panesRaw.stdout || "{}").result?.panes || [];
const ourPane = panes.find((x) => x.pane_id === rec?.herdrPaneId);
ok("LIVE: herdr pane id from record resolves in real pane list", Boolean(ourPane), `pane=${rec?.herdrPaneId}`);

// sendKeys round-trip via the driver (real binary)
const { sendToPane } = await import(join(swarmRoot, "src", "tmux.ts"));
let sendErr = null;
try {
	await sendToPane(fakePi, rec.tmuxTarget, "echo G2_LIVE_ROUNDTRIP");
} catch (e) {
	sendErr = e;
}
ok("LIVE: sendText round-trips through herdr driver (real binary)", sendErr === null, String(sendErr?.message || sendErr));

// read pane output to prove the round-trip landed
await new Promise((r) => setTimeout(r, 1_500));
const readRaw = realExec(["pane", "read", rec?.herdrPaneId]);
const saw = (readRaw.stdout || "").includes("G2_LIVE_ROUNDTRIP");
ok("LIVE: injected text visible in real pane output", saw);

// cleanup: close the tab we created
if (ourTab) realExec(["tab", "close", ourTab.tab_id]);

writeFileSync(
	join(outDir, "report.md"),
	`# G2 LIVE lane\n\npass=${pass} fail=${fail}\n\n- herdrPaneId: ${rec?.herdrPaneId}\n- tmuxWindow (tab_id): ${rec?.tmuxWindow} (real: ${ourTab?.tab_id})\n- exec census:\n${execCalls.map((c) => "  - " + c).join("\n")}\n\nAdapter note: driver's tab-create-with-positional-command is a herdr 0.4.x contract;\ninstalled 0.8.2 requires tab create + pane run. Driver fix flagged for follow-up (herdr.ts\noutside this node's allowedFiles).\n`,
);
rmSync(scratch, { recursive: true, force: true });
console.log(`\n[LIVE] pass=${pass} fail=${fail} -> ${outDir}`);
process.exit(fail === 0 ? 0 : 1);
