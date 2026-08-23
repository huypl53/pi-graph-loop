// Auto-rotation engine test with MOCKED tmux (no real panes/pi processes needed).
//
// Verifies the FULL automatic loop — no manual /swarm commands:
//   watchPoolOnce detects a "dead" agent pane -> benches its model slot ->
//   restartAgent re-picks from the pool -> the agent is respawned on a DIFFERENT slot.
//
// tmux is faked at the pi.exec boundary: a script pane records every tmux command, and
// liveness is simulated by killing/removing the pane from the fake tmux state.
//
// Run: node extensions/swarm/pool-auto-rotate.test.mjs
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paths } from "./src/state.ts";
import { readState, writeState } from "./src/state.ts";
import { watchPoolOnce } from "./src/hooks.ts";
import { poolStatus } from "./src/pool.ts";

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.error("  FAIL:", name); } };

const dir = await mkdtemp(join(tmpdir(), "pool-auto-"));
await mkdir(join(dir, ".pi"), { recursive: true });
await writeFile(join(dir, ".pi", "settings.json"), JSON.stringify({
	swarm: {
		defaultModel: "glm-5.1",
		defaultProvider: "zai-coding-cn",
		modelPool: [
			{ model: "glm-5.1", provider: "zai-coding-cn", weight: 50 },
			{ model: "gpt-5.4-mini", provider: "openai", weight: 30 },
			{ model: "claude-sonnet-4", provider: "anthropic", weight: 0 },
		],
		rotation: { strategy: "round-robin", cooldownMs: 300_000, maxRetries: 2 },
	},
}));
process.chdir(dir);
const p = paths(dir);

// --- fake tmux: state + command log ----------------------------------------------
const fake = {
	panes: new Set(["sess:worker-a.0", "sess:worker-b.0"]), // worker-b "dies" mid-test
	commands: [],
	spawned: [], // { target, cmd } from new-window/new-session
};
const makePi = () => ({
	exec: async (bin, args) => {
		if (bin !== "tmux") return { code: 0, stdout: "", stderr: "" };
		fake.commands.push(args.join(" "));
		const j = args.join(" ");
		if (j.startsWith("display-message")) {
			const t = args[args.indexOf("-t") + 1];
			// liveness: pane must exist; and panes listed as dead report failure
			if (!fake.panes.has(t)) return { code: 1, stdout: "", stderr: "can't find pane" };
			const w = t.includes(":") ? t.slice(t.indexOf(":") + 1).split(".")[0] : "w";
			if (j.includes("pane_current_command")) {
				const cmd = w === "worker-b" ? "zsh" : "node";
				return { code: 0, stdout: cmd, stderr: "" };
			}
			return { code: 0, stdout: `${w}\t%0`, stderr: "" };
		}
		if (j.startsWith("new-window") || j.startsWith("new-session")) {
			const t = args[args.indexOf("-t") + 1];
			const w = j.startsWith("new-window") ? t.split(":")[1] || "w" : t;
			const target = `${j.startsWith("new-session") ? t : t.split(":")[0]}:${w}.0`;
			fake.panes.add(target);
			fake.spawned.push({ target, cmd: args.slice(-1)[0] });
			return { code: 0, stdout: "", stderr: "" };
		}
		if (j.startsWith("kill-window") || j.startsWith("kill-pane")) {
			const t = args[args.indexOf("-t") + 1];
			for (const k of [...fake.panes]) if (k === t || k.startsWith(t) || t.startsWith(k.replace(".0", ""))) fake.panes.delete(k);
			return { code: 0, stdout: "", stderr: "" };
		}
		return { code: 0, stdout: "", stderr: "" };
	},
});
const pi = makePi();

// Seed state: two running agents; worker-b's pane will be dead (removed from fake.panes).
const st = await readState(p, dir);
const ts = new Date().toISOString();
for (const id of ["worker-a", "worker-b"]) {
	st.agents[id] = {
		id, role: "worker", roleKind: "worker", capabilities: [], activeTaskIds: [], maxConcurrentTasks: 1,
		status: "running", runtimeStatus: "idle", health: "healthy", lastSessionStartAt: ts, lastAgentStartAt: ts,
		tmuxSession: "sess", tmuxWindow: id, tmuxTarget: `sess:${id}.0`,
		model: "glm-5.1", provider: "zai-coding-cn", cwd: dir, mailbox: ".pi/swarm/mailboxes/x.jsonl",
		createdAt: ts, updatedAt: ts,
	};
}
await writeState(p, st);

// Simulate the failure: worker-b's pane is gone (e.g. pi exited on a 429 quota error).
fake.panes.delete("sess:worker-b.0");

// Disable SPAWN_SETTLE delay for test speed.
process.env.PI_TEST_FAST = "1";

// Run the watcher ONCE — this is the automatic path (normally driven by the orchestrator's interval).
const result = await watchPoolOnce(pi, dir, p);

ok("watcher checked candidates", result.checked >= 1);
ok("watcher respawned worker-b", result.respawned.includes("worker-b"));
ok("watcher left healthy worker-a alone", !result.respawned.includes("worker-a"));

// worker-b's old slot must be benched (failure recorded -> cooldown on 1st watcher failure streak
// after restartAgent... note: recordSlotFailure fires once here; with maxRetries=2 a single failure
// does NOT bench — but rotation must still happen via rotateFromSlot).
const st2 = await readState(p, dir);
const wb = st2.agents["worker-b"];
ok("worker-b respawned on a DIFFERENT model", wb.model !== "glm-5.1");
ok("worker-b provider switched too", wb.provider !== "zai-coding-cn");
ok("worker-b still same id (mailbox/identity preserved)", wb.id === "worker-b" && wb.role === "worker");
ok("worker-b marked running again", wb.status === "running");

const ps = await poolStatus(p);
const glm = ps.slots.find((s) => s.model === "glm-5.1");
ok("glm slot has recorded failure", (glm.health?.failures ?? 0) >= 1);
ok("glm slot failure mentions the dead agent", /worker-b/.test(glm.health?.lastError || ""));

// The respawn command must target the new model/provider.
const spawnCmd = fake.spawned[fake.spawned.length - 1]?.cmd || "";
ok("respawn command uses the new model", spawnCmd.includes(wb.model));
ok("respawn command uses the new provider", spawnCmd.includes(wb.provider));

// Idempotence/cooldown: an immediate second run must NOT respawn again (per-agent throttle).
const r2 = await watchPoolOnce(pi, dir, p);
ok("second run does not re-respawn (throttle)", !r2.respawned.includes("worker-b"));

// Manual stop must never be auto-respawned.
const st3 = await readState(p, dir);
st3.agents["worker-a"].status = "stopped";
st3.agents["worker-a"].manualStop = true;
fake.panes.delete("sess:worker-a.0");
await writeState(p, st3);
const r3 = await watchPoolOnce(pi, dir, p);
ok("manually stopped agent is not auto-respawned", !r3.respawned.includes("worker-a"));

console.log(`\n${fail === 0 ? "PASS" : "FAIL"}: ${pass} passed, ${fail} failed`);
process.chdir("/");
await rm(dir, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
