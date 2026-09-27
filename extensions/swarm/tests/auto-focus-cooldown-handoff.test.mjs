// === auto-focus-cooldown-handoff.test.mjs — D4 regression (task herdr-autofocus-parity-20260927) ===
//
// AC6: two settles <2.5s apart must NOT silently drop the second handoff. RED (pre-fix): the
// global 2.5s cooldown skipped the second settle with "cooldown". GREEN: the settle path uses
// a 250ms PER-TARGET cooldown (handoff-priority) — different targets hand off freely;
// identical-target re-fires within 250ms are debounced.

import { strictEqual, ok } from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";

const here = import.meta.dirname || new URL(".", import.meta.url).pathname;
const mod = await import(join(here, "..", "index.ts"));
const { maybeAutoFocusBusyAgent } = mod;
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

const piStub = { exec: async () => ({ code: 0, stdout: JSON.stringify({ result: {} }), stderr: "" }) };

const prevMgr = process.env.PI_SWARM_TERMINAL_MANAGER;

const worker = (id, win) => ({
	id,
	role: "worker",
	roleKind: "worker",
	status: "running",
	runtimeStatus: "busy",
	tmuxSession: "mock",
	tmuxWindow: win,
	tmuxTarget: `%${win}`,
});

const baseState = (scratch) => ({
	version: 1,
	swarmId: "handoff",
	cwd: scratch,
	tmuxSession: "mock",
	autoFocusBusy: true,
	agents: {
		wa: worker("wa", "wa"),
		wb: worker("wb", "wb"),
		wc: worker("wc", "wc"),
	},
	delivered: {},
	messages: {},
	createdAt: new Date().toISOString(),
	updatedAt: new Date().toISOString(),
});

const readSkips = (scratch, reason) => {
	const f = paths(scratch).events;
	if (!existsSync(f)) return [];
	return readFileSync(f, "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l))
		.filter((e) => e.event === "focus.skip" && e.reason === reason);
};

console.log("=== D4 settle-path per-target cooldown (mock driver, deterministic) ===");

await asyncTest("three settles at t=0/1000/2000ms → all three handoffs succeed (no cooldown drops)", async () => {
	const scratch = join(tmpdir(), `swarm-d4-handoff-${process.pid}-${Date.now()}`);
	mkdirSync(scratch, { recursive: true });
	await writeState(paths(scratch), baseState(scratch));

	// Mock driver getFocusStatus reports activeWindowName "main" — bypass the active-window
	// guard so the test isolates the cooldown semantics (not the pane-matching fix, which
	// herdr-pane-to-tab-matching.test.mjs covers).
	const results = [];
	results.push(await maybeAutoFocusBusyAgent(piStub, { cwd: scratch }, "wa", { bypassActiveGuard: true }));
	await new Promise((r) => setTimeout(r, 1000));
	results.push(await maybeAutoFocusBusyAgent(piStub, { cwd: scratch }, "wb", { bypassActiveGuard: true }));
	await new Promise((r) => setTimeout(r, 1000));
	results.push(await maybeAutoFocusBusyAgent(piStub, { cwd: scratch }, "wc", { bypassActiveGuard: true }));

	strictEqual(results[0].switched, true, `first handoff: ${JSON.stringify(results[0])}`);
	strictEqual(results[1].switched, true, `RED was reason:"cooldown" here — second handoff must succeed: ${JSON.stringify(results[1])}`);
	strictEqual(results[2].switched, true, `third handoff must succeed: ${JSON.stringify(results[2])}`);

	const drops = readSkips(scratch, "cooldown");
	strictEqual(drops.length, 0, "no silently-dropped handoffs in events.jsonl");
	rmSync(scratch, { recursive: true, force: true });
});

await asyncTest("identical target re-fire within 250ms → debounced with cooldown skip", async () => {
	const scratch = join(tmpdir(), `swarm-d4-debounce-${process.pid}-${Date.now()}`);
	mkdirSync(scratch, { recursive: true });
	await writeState(paths(scratch), baseState(scratch));

	const first = await maybeAutoFocusBusyAgent(piStub, { cwd: scratch }, "wa", { bypassActiveGuard: true });
	strictEqual(first.switched, true);
	// Immediate second settle handoffing to the SAME target (wb stays busy) — per-target
	// cooldown debounces within 250ms.
	const second = await maybeAutoFocusBusyAgent(piStub, { cwd: scratch }, "wa", { bypassActiveGuard: true });
	strictEqual(second.switched, false, "same-target re-fire within 250ms is debounced");
	strictEqual(second.reason, "cooldown");
	rmSync(scratch, { recursive: true, force: true });
});

process.env.PI_SWARM_TERMINAL_MANAGER = prevMgr;
console.log(fail === 0 ? "\nALL HANDOFF COOLDOWN TESTS PASSED." : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
