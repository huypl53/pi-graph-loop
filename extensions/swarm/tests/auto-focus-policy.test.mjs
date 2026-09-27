// === auto-focus-policy.test.mjs — D1 regression (task herdr-autofocus-parity-20260927) ===
//
// AC4: follow|steal|suppress policy matrix — 3 modes × 3 root states (idle / mid-turn /
// unknown) on the herdr busy path. R10-1: boundary counters at the REAL pi.exec("herdr") seam.
// Tmux cases: policy is neutral under tmux (guard is herdr-only).

import { strictEqual, ok } from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, rmSync } from "node:fs";

const here = import.meta.dirname || new URL(".", import.meta.url).pathname;
const mod = await import(join(here, "..", "index.ts"));
const { maybeAutoFocusOnBusy } = mod;
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

function fakePi({ tabList = [] } = {}) {
	const execs = [];
	return {
		execs,
		api: {
			exec: async (bin, args) => {
				execs.push({ bin, args });
				const cmd = args.join(" ");
				if (bin === "herdr") {
					if (cmd.startsWith("tab list")) return { code: 0, stdout: JSON.stringify({ result: { tabs: tabList } }), stderr: "" };
					if (cmd.startsWith("tab focus")) return { code: 0, stdout: "{}", stderr: "" };
					return { code: 0, stdout: "{}", stderr: "" };
				}
				return { code: 0, stdout: "", stderr: "" };
			},
		},
	};
}
const countTabFocus = (execs) => execs.filter((e) => e.bin === "herdr" && e.args[0] === "tab" && e.args[1] === "focus").length;

const prevMgr = process.env.PI_SWARM_TERMINAL_MANAGER;
const setMgr = (m) => (process.env.PI_SWARM_TERMINAL_MANAGER = m);

const rootVariants = {
	idle: { id: "root", roleKind: "root", status: "running", runtimeStatus: "idle", tmuxSession: "wA" },
	midTurn: {
		id: "root",
		roleKind: "root",
		status: "running",
		runtimeStatus: "busy",
		tmuxSession: "wA",
		lastToolAt: new Date().toISOString(),
	},
	unknown: undefined,
};

function state(scratch, policy, rootState) {
	const agents = {
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
	};
	if (rootState) agents.root = rootState;
	return {
		version: 1,
		swarmId: "policy",
		cwd: scratch,
		tmuxSession: "wA",
		autoFocusBusy: true,
		autoFocusPolicy: policy,
		agents,
		delivered: {},
		messages: {},
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	};
}

// User focused OUTSIDE the agents workspace (wU) — the case the guard governs.
const outsideFixtures = {
	tabList: [
		{ tab_id: "wA:t1", workspace_id: "wA", label: "af-worker", focused: false },
		{ tab_id: "wU:t1", workspace_id: "wU", label: "user-tab", focused: true },
	],
};

console.log("=== D1 policy matrix (herdr busy path, user outside agents workspace) ===");

for (const [rootName, rootState] of Object.entries(rootVariants)) {
	// follow: pull iff root idle
	{
		const scratch = join(tmpdir(), `swarm-pol-follow-${rootName}-${process.pid}-${Date.now()}`);
		mkdirSync(scratch, { recursive: true });
		await writeState(paths(scratch), state(scratch, "follow", rootState));
		const { api, execs } = fakePi(outsideFixtures);
		setMgr("herdr");
		const res = await maybeAutoFocusOnBusy(api, { cwd: scratch }, "af-worker");
		// follow: pull iff root is NOT mid-turn. Unknown/absent root state counts as idle
		// (fail-open, mirrors the guard's query-failure fail-open).
		const expectPull = rootName !== "midTurn";
		const label = `follow + root ${rootName} → ${expectPull ? "PULL" : "root-busy-hold"}`;
		if (expectPull) {
			strictEqual(res.switched, true, label);
			ok(countTabFocus(execs) >= 1, `${label} — tab focus call at seam`);
		} else {
			strictEqual(res.switched, false, label);
			strictEqual(res.reason, "root-busy-hold", label);
			strictEqual(countTabFocus(execs), 0, `${label} — zero tab focus calls`);
		}
		console.log(`  ok   ${label}`);
		pass++;
		rmSync(scratch, { recursive: true, force: true });
	}
	// steal: always pull
	{
		const scratch = join(tmpdir(), `swarm-pol-steal-${rootName}-${process.pid}-${Date.now()}`);
		mkdirSync(scratch, { recursive: true });
		await writeState(paths(scratch), state(scratch, "steal", rootState));
		const { api, execs } = fakePi(outsideFixtures);
		setMgr("herdr");
		const res = await maybeAutoFocusOnBusy(api, { cwd: scratch }, "af-worker");
		strictEqual(res.switched, true, `steal + root ${rootName} → PULL`);
		ok(countTabFocus(execs) >= 1, `steal + root ${rootName} — tab focus call at seam`);
		console.log(`  ok   steal + root ${rootName} → PULL`);
		pass++;
		rmSync(scratch, { recursive: true, force: true });
	}
	// suppress: never pull
	{
		const scratch = join(tmpdir(), `swarm-pol-suppress-${rootName}-${process.pid}-${Date.now()}`);
		mkdirSync(scratch, { recursive: true });
		await writeState(paths(scratch), state(scratch, "suppress", rootState));
		const { api, execs } = fakePi(outsideFixtures);
		setMgr("herdr");
		const res = await maybeAutoFocusOnBusy(api, { cwd: scratch }, "af-worker");
		strictEqual(res.switched, false, `suppress + root ${rootName} → SKIP`);
		strictEqual(res.reason, "user-focused-outside-agents-workspace", `suppress + root ${rootName} reason`);
		strictEqual(countTabFocus(execs), 0, `suppress + root ${rootName} — zero tab focus calls`);
		console.log(`  ok   suppress + root ${rootName} → SKIP`);
		pass++;
		rmSync(scratch, { recursive: true, force: true });
	}
}

await asyncTest("tmux policy neutrality: follow + user 'outside' → busy path proceeds (guard is a no-op under tmux)", async () => {
	const scratch = join(tmpdir(), `swarm-pol-tmux-${process.pid}-${Date.now()}`);
	mkdirSync(scratch, { recursive: true });
	await writeState(paths(scratch), state(scratch, "follow", rootVariants.midTurn));
	const { api } = fakePi(outsideFixtures);
	setMgr("tmux");
	const res = await maybeAutoFocusOnBusy(api, { cwd: scratch }, "af-worker");
	strictEqual(res.switched, true, "tmux is session-scoped; guard must not veto regardless of policy/root state");
	rmSync(scratch, { recursive: true, force: true });
});

setMgr(prevMgr);
console.log(fail === 0 ? "\nALL POLICY TESTS PASSED." : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
