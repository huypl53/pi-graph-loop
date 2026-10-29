// === swarm/tests/guest-goal-nudge.test.mjs — guest-goal v1 (task guest-goal, 2026-10-30) ===
// RED-first repro (bug-fix mandate 2026-08-31): a plain `pi` session (no PI_SWARM_AGENT_ID, no
// PI_SWARM_IS_ROOT — resolves to the anonymous swarm-guest) has NO goal surface today:
//   1. `/swarm goal set` refuses non-root ("goal is root-only");
//   2. the tool path `swarm_set_goal` requires root authority AND the guest loses the whole
//      swarm_* tool surface via applySwarmToolGating;
//   3. no evaluator/watchdog ever considers a guest's goal — the root pump is root-only.
// So a solo human in a guest session cannot give themselves the standing-goal nudge the root's
// solo goals just gained (vacuous-user-goal-nudge, 2026-10-29). This suite pins the NEW design:
//   - `/swarm guest-goal set/show/done` (guest-only surface; root keeps /swarm goal);
//   - st.guestGoal slot (single per project, SwarmGoal shape, origin "user");
//   - evalGuestGoalNudgeLocked: check-streak debounce → pi.sendMessage L2 nudge,
//     cap + backoff, trace goal.idle_nudge { route: "guest_solo" };
//   - guest turn_end {stop} resets consecutiveNoResolveNudges;
//   - the guest watchdog one-shot runs from agent_settled in ALL modes (the -p lane surface).
//
// Test harness notes:
// - Production imports come from src/index.ts → EVERY hook/tool/command registration runs; this
//   suite exercises the real registerSettledHook/registerTurnEndHook code paths with a mock pi.
// - The mock pi records sendMessage calls (the R10-1 L2 boundary).
import { rmSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, "..", "src");
const swarmDir = join(here, "..");
const swarmExtensionFactory = (await import(join(swarmDir, "index.ts"))).default;
const { stopGuestGoalWatchdog } = await import(join(srcDir, "nudges", "guest-goal.ts"));
const { paths } = await import(join(srcDir, "state.ts"));
const { SWARM_GUEST_ID } = await import(join(srcDir, "constants.ts"));

const ORIG = { ...process.env };
const S = { agentId: "", envRoot: "", cwd: "" };
const results = [];
let current = null;
const t = (name, fn) => {
	current = { name, fn };
	results.push(current);
};
const eq = (a, b, msg) => {
	if (a !== b) throw new Error(`${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
};
const ok = (v, msg) => {
	if (!v) throw new Error(msg);
};

function mockCtx(cwd, mode = "tui", idle = true) {
	return {
		cwd,
		mode,
		isIdle: () => idle,
		session: { id: "sess-guest-test" },
		ui: { notify: () => {}, setFooter: () => {}, setStatus: () => {} },
	};
}

function mockPi() {
	const sent = [];
	const handlers = {};
	const commands = {};
	return {
		sent,
		handlers,
		commands,
		registerTool: () => {},
		registerCommand: (name, def) => {
			commands[name] = def;
		},
		registerMessageRenderer: () => {},
		on: (evt, fn) => {
			(handlers[evt] ||= []).push(fn);
		},
		sendMessage: (m, opts) => {
			sent.push({ ...m, __opts: opts });
		},
		ui: {
			notify: () => {},
			setFooter: () => {},
			setStatus: () => {},
		},
		setActiveTools: () => {},
		getAllTools: () => [],
	};
}

async function fire(evt, event, ctx) {
	for (const fn of pi_current.handlers[evt] || []) await fn(event, ctx);
}

async function cmd(raw, ctx) {
	// Route through the REAL registerCommand surface (runCommand → dispatch), not the handler directly.
	const def = pi_current.commands["swarm"];
	await def.handler(raw, ctx);
}

let pi_current = null;

async function freshWorld(env = {}) {
	const root = process.env.GUEST_GOAL_TMPDIR ?? join("/tmp", `swarm-guest-goal-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
	rmSync(root, { recursive: true, force: true });
	mkdirSync(join(root, ".pi/swarm"), { recursive: true });
	const pi = mockPi();
	pi_current = pi;
	process.env = { ...ORIG, PI_SWARM_AGENT_ID: SWARM_GUEST_ID, ...env };
	swarmExtensionFactory(pi);
	const ctx = mockCtx(root);
	return { root, pi, ctx };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
t("S1 guest-goal command: set → st.guestGoal (origin user), show reflects, done clears", async () => {
	const { root, pi, ctx } = await freshWorld();
	const p = paths(root);
	await fire("session_start", { reason: "test" }, ctx);
	// No goal initially.
	let st = JSON.parse(readFileSync(p.state, "utf8"));
	ok(!st.guestGoal, "no guestGoal initially");
	// set
	await cmd("guest-goal set Finish the refactor alone. No spawning.", ctx);
	st = JSON.parse(readFileSync(p.state, "utf8"));
	ok(st.guestGoal, "guestGoal written");
	eq(st.guestGoal.origin, "user", "guest goal origin is user");
	eq(st.guestGoal.setBy, SWARM_GUEST_ID, "setBy is the guest id");
	ok(st.guestGoal.id.startsWith("goal-"), "goalId shape");
	ok(!st.goal, "root slot st.goal untouched");
	// show
	await cmd("guest-goal show", ctx);
	// done
	await cmd("guest-goal done", ctx);
	st = JSON.parse(readFileSync(p.state, "utf8"));
	ok(!st.guestGoal, "guestGoal cleared");
	// usage line for unknown sub
	await cmd("guest-goal bogus", ctx);
});

t("S2 root keeps /swarm guest-goal OUT (authority): notify warning, no state write", async () => {
	const { root, pi, ctx } = await freshWorld();
	const p = paths(root);
	// Override identity to root for the command path.
	process.env.PI_SWARM_AGENT_ID = "root";
	await cmd("guest-goal set solo here", ctx);
	if (existsSync(p.state)) {
		const st = JSON.parse(readFileSync(p.state, "utf8"));
		ok(!st.guestGoal && !st.goal, "no goal written when root calls guest-goal");
	}
});

t("S3 red core: guest idle + guestGoal set → goal.idle_nudge fires at L2 (3-check streak)", async () => {
	const { root, pi, ctx } = await freshWorld({
		PI_SWARM_GOAL_IDLE_CHECK_INTERVAL_MS: "10",
		PI_SWARM_GOAL_IDLE_CHECKS_REQUIRED: "3",
	});
	const p = paths(root);
	await fire("session_start", { reason: "test" }, ctx);
	await cmd("guest-goal set Finish the refactor alone.", ctx);
	// Simulate the guest settling idle (the one-shot evaluate surface), several times.
	// Pre-fix: NOTHING evaluates a guest goal — zero nudges forever (the live symptom).
	for (let i = 0; i < 5; i++) {
		await fire("agent_settled", {}, ctx);
		await sleep(30);
	}
	// Assert the L2 boundary (mock pi.sent) — the durable trace proof is in S7.
	const sent = pi.sent.filter((m) => (m.content || "").includes("Standing goal"));
	ok(sent.length >= 1, `expected >=1 guest goal nudge at L2, got ${sent.length} (sent=${JSON.stringify(pi.sent.map((s) => s.content))})`);
	const allTrigger = sent.every((m) => m.__opts?.triggerTurn === true);
	ok(allTrigger, "every nudge sent with triggerTurn:true (L2 opts at the real mock-pi sendMessage boundary)");
});

t("S4 cap: after MAX (3) nudges the evaluator holds (backoff), no unbounded spam", async () => {
	const { root, pi, ctx } = await freshWorld({
		PI_SWARM_GOAL_IDLE_CHECK_INTERVAL_MS: "10",
		PI_SWARM_GOAL_IDLE_CHECKS_REQUIRED: "3",
	});
	const p = paths(root);
	await fire("session_start", { reason: "test" }, ctx);
	await cmd("guest-goal set Cap me.", ctx);
	for (let i = 0; i < 25; i++) {
		await fire("agent_settled", {}, ctx);
		await sleep(30);
	}
	const sent = pi.sent.filter((m) => (m.content || "").includes("Standing goal"));
	ok(sent.length === 3, `cap: expected exactly 3 nudges over 25 settles, got ${sent.length}`);
	const allTrigger = sent.every((m) => m.__opts?.triggerTurn === true);
	ok(allTrigger, "capped nudges also carry triggerTurn:true");
});

t("S5 turn_end {stop} resolve: consecutiveNoResolveNudges resets for the guest", async () => {
	const { root, pi, ctx } = await freshWorld({
		PI_SWARM_GOAL_IDLE_CHECK_INTERVAL_MS: "10",
		PI_SWARM_GOAL_IDLE_CHECKS_REQUIRED: "3",
	});
	const p = paths(root);
	await fire("session_start", { reason: "test" }, ctx);
	await cmd("guest-goal set Resolve me.", ctx);
	// 3 settles → 1 nudge, counter=1.
	for (let i = 0; i < 3; i++) {
		await fire("agent_settled", {}, ctx);
		await sleep(30);
	}
	let st = JSON.parse(readFileSync(p.state, "utf8"));
	eq(st.guestGoal.consecutiveNoResolveNudges, 1, "counter=1 after first nudge");
	// Guest assistant turn ends with stopReason stop → resolve.
	await fire("turn_end", { message: { role: "assistant", stopReason: "stop" } }, ctx);
	st = JSON.parse(readFileSync(p.state, "utf8"));
	eq(st.guestGoal.consecutiveNoResolveNudges, 0, "counter reset by turn_end stop");
});

t("S6 busy guest: no nudge while not idle (watchdog gate)", async () => {
	const { root, pi } = await freshWorld({
		PI_SWARM_GOAL_IDLE_CHECK_INTERVAL_MS: "10",
		PI_SWARM_GOAL_IDLE_CHECKS_REQUIRED: "3",
	});
	const busyCtx = mockCtx(root, "tui", false);
	await fire(pi.handlers, "session_start", { reason: "test" }, busyCtx);
	await cmd("guest-goal set hold while busy", busyCtx);
	for (let i = 0; i < 5; i++) {
		await fire("agent_settled", {}, busyCtx);
		await sleep(30);
	}
	const sent = pi.sent.filter((m) => (m.content || "").includes("Standing goal"));
	eq(sent.length, 0, "busy guest receives zero nudges");
});

t("S7 trace census: goal.idle_nudge events carry route guest_solo in events.jsonl", async () => {
	const { root, pi, ctx } = await freshWorld({
		PI_SWARM_GOAL_IDLE_CHECK_INTERVAL_MS: "10",
		PI_SWARM_GOAL_IDLE_CHECKS_REQUIRED: "3",
	});
	const p = paths(root);
	await fire("session_start", { reason: "test" }, ctx);
	await cmd("guest-goal set trace me", ctx);
	for (let i = 0; i < 4; i++) {
		await fire("agent_settled", {}, ctx);
		await sleep(30);
	}
	const lines = readFileSync(p.events, "utf8")
		.trim()
		.split("\n")
		.map((l) => JSON.parse(l));
	const nudges = lines.filter((e) => e.event === "goal.idle_nudge");
	ok(nudges.length >= 1, "goal.idle_nudge traced");
	for (const n of nudges) {
		eq(n.route, "guest_solo", "route guest_solo");
	}
});

// ---------------------------------------------------------------------------
// Runner
let failed = 0;
// The watchdog chain (armed in TUI-mode worlds) holds the event loop open — stop it so the
// process exits promptly (the production chain is stopped by session_shutdown).

for (const r of results) {
	try {
		await r.fn();
		console.log(`ok - ${r.name}`);
	} catch (err) {
		failed++;
		console.log(`FAIL - ${r.name}\n    ${err?.message || err}`);
	}
}
process.env = ORIG;
stopGuestGoalWatchdog(); // drop the watchdog timer so the process exits promptly
if (failed) {
	console.log(`GUEST-GOAL FAIL (${failed} failed, ${results.length - failed} passed)`);
	process.exit(1);
}
console.log(`GUEST-GOAL PASS (0 failed, ${results.length} passed)`);
