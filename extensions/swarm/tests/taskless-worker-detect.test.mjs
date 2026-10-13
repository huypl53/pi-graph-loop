#!/usr/bin/env node
/**
 * taskless-worker-detect.test.mjs — RED-first suite for the taskless-worker detector
 * (plan: docs/swarm/plans/2026-10-13-worker-task-closure-gaps.md §1.4 Stage D & §4.4)
 *
 * Contract under test:
 *   - src/nudges/taskless-worker.ts exporting evaluateTasklessWorkerNudgeLocked(pi, cwd, p, st, nowMs)
 *   - Eligibility matrix (per non-root agent):
 *       - worker-fresh: running, no tasks, age 5' < grace (15') -> untouched
 *       - worker-taskless: running, no tasks, age 20', no unresolved requiresResponse -> self-nudged + root-noticed
 *       - worker-contractual: no tasks, age 20', but unresolved requiresResponse inbound -> untouched
 *       - worker-busy-taskless: running/busy, no tasks, age 20' -> NOTICED (fires while busy, the incident shape)
 *       - worker-with-task: activeTaskIds non-empty -> untouched
 *       - worker-leased: valid lease -> untouched
 *       - worker-paused: paused === true -> untouched
 *       - worker-referenced: no activeTaskIds but open graph node assigns it (isTaskReferenced) -> untouched
 *       - worker-stopped: status === "stopped" -> untouched
 *   - Caps and cooldown:
 *       - self-nudge: cap 1 per agent record (selfNudges >= 1 -> suppressed)
 *       - root notice: cap 2 (rootNotices >= TASKLESS_ROOT_NOTICE_CAP -> stop)
 *       - root notice cooldown: TASKLESS_ROOT_COOLDOWN_MS (30')
 *   - Scan throttle:
 *       - _lastScanAt throttle: second scan before TASKLESS_SCAN_INTERVAL_MS does nothing
 *   - Kill-switch:
 *       - PI_SWARM_TASKLESS_NUDGE_OFF=1 disables the phase entirely; traces agent.taskless.disabled once
 *   - R10-1:
 *       - pane-less world: 0 pi.sendMessage calls at boundary, durable mailbox rows present
 *   - De-path & tool hygiene:
 *       - zero raw filesystem paths in bodies; names ONLY LLM-callable tools (swarm_assign_task, swarm_send_message), NEVER /swarm
 */

import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

let tasklessMod = null;
try {
	tasklessMod = await import(join(here, "..", "src", "nudges", "taskless-worker.ts"));
} catch {
	tasklessMod = null;
}

let passed = 0,
	failed = 0;
const ok = (n, c, info) => {
	if (c) {
		passed++;
		console.log("  ok  ", n);
	} else {
		failed++;
		console.error("  FAIL:", n, info ?? "");
	}
};

const MIN = 60_000;
const NOW = 1_800_000_000_000;
const iso = (ms) => new Date(ms).toISOString();

function makeAgent(id, overrides = {}) {
	return {
		id,
		role: `${id} role`,
		roleKind: "worker",
		capabilities: [],
		activeTaskIds: [],
		maxConcurrentTasks: 1,
		status: "running",
		runtimeStatus: "idle",
		health: "healthy",
		tmuxTarget: `sess:${id}`,
		lastHeartbeatAt: iso(NOW),
		createdAt: iso(NOW - 20 * MIN),
		updatedAt: iso(NOW),
		...overrides,
	};
}

function makeState(agents, messages = {}, extras = {}) {
	return {
		version: 1,
		swarmId: "swarm-taskless-test",
		cwd: "/tmp",
		tmuxSession: "sess",
		agents: {
			root: makeAgent("root", { roleKind: "root", tmuxTarget: "sess:root" }),
			...agents,
		},
		delivered: {},
		messages: { ...messages },
		...extras,
	};
}

const scratch = await mkdtemp(join(tmpdir(), "taskless-detect-red-"));
await mkdir(join(scratch, ".pi/swarm/mailboxes"), { recursive: true });

const stateMod = await import(join(here, "..", "src", "state.ts"));
const { paths, withLock } = stateMod;
const p = paths(scratch);

const sentMessages = [];
const pi = {
	registerTool: () => {},
	registerCommand: () => {},
	on: () => {},
	sendMessage: (m, o) => {
		sentMessages.push({ m, o });
	},
	exec: async (cmd, args) => {
		if (cmd === "tmux" && args?.[0] === "display-message") return { code: 0, stdout: "pi\t1234\n", stderr: "" };
		if (cmd === "tmux" && args?.[0] === "list-panes") return { code: 0, stdout: "%1 0 1 1\n", stderr: "" };
		return { code: 0, stdout: "", stderr: "" };
	},
};

async function readMailbox(who) {
	try {
		const raw = await readFile(join(scratch, ".pi", "swarm", "mailboxes", `${who}.jsonl`), "utf8");
		return raw
			.split("\n")
			.filter(Boolean)
			.map((l) => {
				try {
					return JSON.parse(l);
				} catch {
					return null;
				}
			})
			.filter(Boolean);
	} catch {
		return [];
	}
}

async function run(st, nowMs = NOW, taskGraphs) {
	sentMessages.length = 0;
	return withLock(p, async () => tasklessMod.evaluateTasklessWorkerNudgeLocked(pi, scratch, p, st, nowMs, taskGraphs));
}

console.log("=== taskless-worker-detect (RED-first) ===");

ok(
	"module src/nudges/taskless-worker.ts exports evaluateTasklessWorkerNudgeLocked (RED: missing pre-fix)",
	Boolean(tasklessMod && typeof tasklessMod.evaluateTasklessWorkerNudgeLocked === "function"),
	"import failed or export missing",
);

if (tasklessMod && typeof tasklessMod.evaluateTasklessWorkerNudgeLocked === "function") {
	// Matrix test
	{
		const agents = {
			"worker-fresh": makeAgent("worker-fresh", { createdAt: iso(NOW - 5 * MIN) }),
			"worker-taskless": makeAgent("worker-taskless", { createdAt: iso(NOW - 20 * MIN) }),
			"worker-contractual": makeAgent("worker-contractual", { createdAt: iso(NOW - 20 * MIN) }),
			"worker-busy-taskless": makeAgent("worker-busy-taskless", { runtimeStatus: "busy", createdAt: iso(NOW - 20 * MIN) }),
			"worker-with-task": makeAgent("worker-with-task", { activeTaskIds: ["task-1"], createdAt: iso(NOW - 20 * MIN) }),
			"worker-leased": makeAgent("worker-leased", {
				leaseKind: "reuse",
				leaseUntil: iso(NOW + 30 * MIN),
				createdAt: iso(NOW - 20 * MIN),
			}),
			"worker-paused": makeAgent("worker-paused", { paused: true, createdAt: iso(NOW - 20 * MIN) }),
			"worker-referenced": makeAgent("worker-referenced", { createdAt: iso(NOW - 20 * MIN) }),
			"worker-stopped": makeAgent("worker-stopped", { status: "stopped", createdAt: iso(NOW - 20 * MIN) }),
		};
		const messages = {
			"msg-req-1": {
				id: "msg-req-1",
				from: "root",
				to: "worker-contractual",
				requiresResponse: true,
				status: "mailbox_delivered",
				createdAt: iso(NOW - 10 * MIN),
			},
		};
		const taskGraphs = [
			{
				taskId: "task-open",
				nodes: {
					n1: { assignee: "worker-referenced", status: "ready" },
				},
			},
		];

		const st = makeState(agents, messages);
		const res = await run(st, NOW, taskGraphs);

		ok("evaluator ran", res.scanRan === true);
		ok("selfNudged count is 2 (worker-taskless + worker-busy-taskless)", res.selfNudged === 2, `selfNudged=${res.selfNudged}`);
		ok("rootNotified count is 2", res.rootNotified === 2, `rootNotified=${res.rootNotified}`);

		// Check worker-taskless mailbox
		const mbTaskless = await readMailbox("worker-taskless");
		ok(
			"worker-taskless received self-nudge",
			mbTaskless.length === 1 && mbTaskless[0].idempotencyKey === "agent:worker-taskless:nudge:taskless-self",
		);
		const selfBody = mbTaskless[0]?.body || "";
		ok("self-nudge body mentions no task graph", selfBody.includes("no task-graph assignment"));
		ok("self-nudge mentions swarm_send_message fallback", selfBody.includes("swarm_send_message"));
		ok("self-nudge contains no raw .pi/ path", !selfBody.includes(".pi/"));
		ok("self-nudge never mentions /swarm command", !/\/swarm\s+\w/.test(selfBody));

		// Check worker-busy-taskless mailbox
		const mbBusy = await readMailbox("worker-busy-taskless");
		ok("worker-busy-taskless received self-nudge (fires while busy)", mbBusy.length === 1);

		// Untouched workers have empty mailboxes
		for (const id of [
			"worker-fresh",
			"worker-contractual",
			"worker-with-task",
			"worker-leased",
			"worker-paused",
			"worker-referenced",
			"worker-stopped",
		]) {
			const mb = await readMailbox(id);
			ok(`${id} mailbox is empty (untouched)`, mb.length === 0, `${id} got ${mb.length} messages`);
		}

		// Root mailbox checks
		const rootMail = await readMailbox("root");
		const rootNotices = rootMail.filter((m) => /taskless-root/.test(m.idempotencyKey || ""));
		ok("root received 2 taskless notices", rootNotices.length === 2, `received=${rootNotices.length}`);
		for (const rn of rootNotices) {
			const b = rn.body || "";
			ok("root notice offers swarm_assign_task", b.includes("swarm_assign_task"));
			ok("root notice contains no raw .pi/ path", !b.includes(".pi/"));
			ok("root notice never mentions /swarm command", !/\/swarm\s+\w/.test(b));
		}

		// R10-1 boundary check
		ok("R10-1 zero pi.sendMessage calls (mailbox-only path)", sentMessages.length === 0, String(sentMessages.length));

		// Caps and cooldown checks
		// 1) Scan throttle: immediate second call is interval-gated
		const resThrottle = await run(st, NOW + 10_000, taskGraphs);
		ok("immediate second scan interval-gated", resThrottle.scanRan === false && resThrottle.reason === "interval_gated");

		// 2) Run after scan interval but before root cooldown: self-nudge capped (already 1), root notice in cooldown
		const resCooldown = await run(st, NOW + 70_000, taskGraphs);
		ok("run past scan interval ran", resCooldown.scanRan === true);
		ok("self-nudge capped at 1 (0 emitted)", resCooldown.selfNudged === 0);
		ok("root notice in cooldown (0 emitted)", resCooldown.rootNotified === 0);

		// 3) Run after root cooldown (NOW + 31 MIN): worker-fresh would be 36m old at NOW+31MIN!
		// Keep worker-fresh young (or re-anchor createdAt relative to test now) so it stays untouched:
		st.agents["worker-fresh"].createdAt = iso(NOW + 31 * MIN - 5 * MIN);
		st.agents["worker-leased"].leaseUntil = iso(NOW + 31 * MIN + 30 * MIN);
		const resSecondRoot = await run(st, NOW + 31 * MIN, taskGraphs);
		ok("after root cooldown: root notice 2 emitted", resSecondRoot.rootNotified === 2, `rootNotified=${resSecondRoot.rootNotified}`);
		ok("after root cooldown: self-nudge remains capped at 0", resSecondRoot.selfNudged === 0);

		// 4) Run after another cooldown (NOW + 62 MIN): root notices reach cap 2 -> 0 emitted
		st.agents["worker-fresh"].createdAt = iso(NOW + 62 * MIN - 5 * MIN);
		st.agents["worker-leased"].leaseUntil = iso(NOW + 62 * MIN + 30 * MIN);
		const resCap = await run(st, NOW + 62 * MIN, taskGraphs);
		ok("after cap reached: root notice capped at 0", resCap.rootNotified === 0);

		// Kill-switch check
		process.env.PI_SWARM_TASKLESS_NUDGE_OFF = "1";
		const stKill = makeState({ "w-kill": makeAgent("w-kill") });
		const resKill = await run(stKill, NOW + 70 * MIN, taskGraphs);
		ok("kill-switch PI_SWARM_TASKLESS_NUDGE_OFF=1 disables scan", resKill.scanRan === false && resKill.reason === "disabled");
		delete process.env.PI_SWARM_TASKLESS_NUDGE_OFF;
	}
}

console.log(`\n${failed === 0 ? "TASKLESS-WORKER-DETECT PASS" : "TASKLESS-WORKER-DETECT FAIL"} (${passed} passed, ${failed} failed)`);
await rm(scratch, { recursive: true, force: true });
process.exit(failed === 0 ? 0 : 1);
