// === auto-focus-skip-tracing.test.mjs — D5 regression (task herdr-autofocus-parity-20260927) ===
//
// AC2: every auto-focus skip on every driver emits exactly one durable focus.skip trace with a
// stable reason, at the REAL trace()/events.jsonl seam (R10-1 boundary counting — we count
// events.jsonl lines, not internal helper calls).
//
// Pi runtime contract (docs/swarm/pi-runtime-contract.md §1): this adds new events.jsonl
// records (Layer 1 surface, append-only) — no mailbox/Pi-queue/LLM-consumption changes, no §10
// claim changes.

import { strictEqual, ok } from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";

const here = import.meta.dirname || new URL(".", import.meta.url).pathname;
const mod = await import(join(here, "..", "index.ts"));
const { maybeAutoFocusOnBusy, maybeAutoFocusBusyAgent } = mod;
const { paths, writeState } = await import(join(here, "..", "src", "state.ts"));

let pass = 0;
let fail = 0;
async function asyncTest(name, fn) {
	try {
		await fn();
		pass++;
		console.log(`  ok   ${name}`);
	} catch (err) {
		fail++;
		console.error(`  FAIL ${name}:`, err);
	}
}

function fakePi({ tabList = [], panes = [] } = {}) {
	const execs = [];
	return {
		execs,
		api: {
			exec: async (bin, args) => {
				execs.push({ bin, args });
				const cmd = args.join(" ");
				if (bin === "herdr") {
					if (cmd === "tab list") return { code: 0, stdout: JSON.stringify({ result: { tabs: tabList } }), stderr: "" };
					if (cmd.startsWith("pane list")) return { code: 0, stdout: JSON.stringify({ result: { panes } }), stderr: "" };
					if (cmd === "workspace list") return { code: 0, stdout: JSON.stringify({ result: { workspaces: [] } }), stderr: "" };
					return { code: 0, stdout: "{}", stderr: "" };
				}
				return { code: 0, stdout: "", stderr: "" };
			},
		},
	};
}

const readSkips = (scratch) => {
	const p = paths(scratch);
	const f = p.events;
	if (!existsSync(f)) return [];
	return readFileSync(f, "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l))
		.filter((e) => e.event === "focus.skip");
};

const baseState = (scratch, extra = {}) => ({
	version: 1,
	swarmId: "skip-trace",
	cwd: scratch,
	tmuxSession: "wA",
	autoFocusBusy: true,
	agents: {
		"af-worker": {
			id: "af-worker",
			role: "worker",
			roleKind: "worker",
			status: "running",
			runtimeStatus: "busy",
			tmuxSession: "wA",
			tmuxWindow: "wA:t1",
			tmuxTarget: "wA:p1",
		},
	},
	delivered: {},
	messages: {},
	createdAt: new Date().toISOString(),
	updatedAt: new Date().toISOString(),
	...extra,
});

const prevMgr = process.env.PI_SWARM_TERMINAL_MANAGER;

console.log("=== focus.skip tracing (D5) ===");

await asyncTest("suppress-policy skip emits one focus.skip with user-focused-outside-agents-workspace", async () => {
	const scratch = join(tmpdir(), `swarm-skiptrace-1-${process.pid}-${Date.now()}`);
	mkdirSync(scratch, { recursive: true });
	await writeState(paths(scratch), baseState(scratch, { autoFocusPolicy: "suppress" }));
	const { api } = fakePi({
		tabList: [
			{ tab_id: "wA:t1", workspace_id: "wA", label: "af-worker", focused: false },
			{ tab_id: "wU:t1", workspace_id: "wU", label: "user-tab", focused: true },
		],
	});
	process.env.PI_SWARM_TERMINAL_MANAGER = "herdr";
	const res = await maybeAutoFocusOnBusy(api, { cwd: scratch }, "af-worker");
	strictEqual(res.reason, "user-focused-outside-agents-workspace");
	const skips = readSkips(scratch);
	strictEqual(skips.length, 1, `exactly one focus.skip expected, got ${skips.length}`);
	strictEqual(skips[0].path, "busy");
	strictEqual(skips[0].agentId, "af-worker");
	strictEqual(skips[0].reason, "user-focused-outside-agents-workspace");
	rmSync(scratch, { recursive: true, force: true });
});

await asyncTest("follow-policy + root mid-turn emits root-busy-hold skip", async () => {
	const scratch = join(tmpdir(), `swarm-skiptrace-2-${process.pid}-${Date.now()}`);
	mkdirSync(scratch, { recursive: true });
	await writeState(
		paths(scratch),
		baseState(scratch, {
			autoFocusPolicy: "follow",
			agents: {
				root: {
					id: "root",
					roleKind: "root",
					status: "running",
					runtimeStatus: "busy",
					tmuxSession: "wA",
					lastToolAt: new Date().toISOString(),
				},
				"af-worker": baseState(scratch).agents["af-worker"],
			},
		}),
	);
	const { api } = fakePi({
		tabList: [
			{ tab_id: "wA:t1", workspace_id: "wA", label: "af-worker", focused: false },
			{ tab_id: "wU:t1", workspace_id: "wU", label: "user-tab", focused: true },
		],
	});
	process.env.PI_SWARM_TERMINAL_MANAGER = "herdr";
	const res = await maybeAutoFocusOnBusy(api, { cwd: scratch }, "af-worker");
	strictEqual(res.reason, "root-busy-hold");
	const skips = readSkips(scratch);
	strictEqual(skips.length, 1);
	strictEqual(skips[0].reason, "root-busy-hold");
	rmSync(scratch, { recursive: true, force: true });
});

await asyncTest("disabled flag emits focus.skip with disabled", async () => {
	const scratch = join(tmpdir(), `swarm-skiptrace-3-${process.pid}-${Date.now()}`);
	mkdirSync(scratch, { recursive: true });
	await writeState(paths(scratch), baseState(scratch, { autoFocusBusy: false }));
	const { api } = fakePi({});
	process.env.PI_SWARM_TERMINAL_MANAGER = "herdr";
	const res = await maybeAutoFocusOnBusy(api, { cwd: scratch }, "af-worker");
	strictEqual(res.reason, "disabled");
	const skips = readSkips(scratch);
	strictEqual(skips.length, 1);
	strictEqual(skips[0].reason, "disabled");
	rmSync(scratch, { recursive: true, force: true });
});

await asyncTest("root agentId emits focus.skip with root_excluded", async () => {
	const scratch = join(tmpdir(), `swarm-skiptrace-4-${process.pid}-${Date.now()}`);
	mkdirSync(scratch, { recursive: true });
	await writeState(paths(scratch), baseState(scratch));
	const { api } = fakePi({});
	process.env.PI_SWARM_TERMINAL_MANAGER = "herdr";
	const res = await maybeAutoFocusOnBusy(api, { cwd: scratch }, "root");
	strictEqual(res.reason, "root_excluded");
	const skips = readSkips(scratch);
	strictEqual(skips.length, 1);
	strictEqual(skips[0].reason, "root_excluded");
	rmSync(scratch, { recursive: true, force: true });
});

await asyncTest("settle-path active_window_mismatch emits focus.skip", async () => {
	const scratch = join(tmpdir(), `swarm-skiptrace-5-${process.pid}-${Date.now()}`);
	mkdirSync(scratch, { recursive: true });
	await writeState(paths(scratch), baseState(scratch));
	// mock driver: getFocusStatus reports activeWindowName "main" — never matches wA:t1.
	const { api } = fakePi({});
	process.env.PI_SWARM_TERMINAL_MANAGER = "mock";
	const res = await maybeAutoFocusBusyAgent(api, { cwd: scratch }, "af-worker");
	strictEqual(res.reason, "active_window_mismatch");
	const skips = readSkips(scratch);
	strictEqual(skips.length, 1);
	strictEqual(skips[0].path, "settle");
	strictEqual(skips[0].reason, "active_window_mismatch");
	rmSync(scratch, { recursive: true, force: true });
});

process.env.PI_SWARM_TERMINAL_MANAGER = prevMgr;
console.log(fail === 0 ? "\nALL SKIP-TRACING TESTS PASSED." : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
