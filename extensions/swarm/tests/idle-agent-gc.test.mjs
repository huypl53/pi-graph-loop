#!/usr/bin/env node
/**
 * idle-agent-gc.test.mjs — RED-first suite for the idle-agent GC nudge
 * (plan: docs/swarm/plans/2026-10-13-idle-agent-gc-nudge.md)
 *
 * Contract under test (pre-fix: module missing → RED; post-fix → GREEN):
 *   - src/nudges/idle-agent-gc.ts: evaluateIdleAgentGcNudgeLocked(pi, cwd, p, st, nowMs)
 *   - Eligibility: running + idle + hbAge > afterMs + no activeTaskIds + no valid lease
 *     + not paused + not task-referenced (isTaskReferenced closure from agent-gc.ts)
 *   - Cooldown (per-agent), maxNudges cap (+ single cap trace), whole-scan interval gate
 *   - Nudge via deliverMessageLocked → root; idempotencyKey agent:{agentId}:nudge:idle-gc:{seq}
 *   - R10-1: sendMessageCalls === nudges (1:1; zero when disabled/capped/cooled)
 *   - Body hygiene: names swarm_stop_agent tool; NEVER names a /swarm slash command
 *     or a raw .pi/ filesystem path (de-path rule)
 */

import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

let idleGc = null;
try {
	idleGc = await import(join(here, "..", "src", "nudges", "idle-agent-gc.ts"));
} catch {
	idleGc = null;
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
		createdAt: iso(NOW - 60 * MIN),
		updatedAt: iso(NOW),
		...overrides,
	};
}

function makeState(agents, extras = {}) {
	return {
		version: 1,
		swarmId: "swarm-x",
		cwd: "/tmp",
		tmuxSession: "sess",
		agents: {
			root: makeAgent("root", { roleKind: "root", tmuxTarget: "sess:root" }),
			...agents,
		},
		delivered: {},
		messages: {},
		...extras,
	};
}

// Scratch cwd so paths()/readState have a real project dir (nudge path writes mailboxes).
const scratch = await mkdtemp(join(tmpdir(), "idle-gc-red-"));
await mkdir(join(scratch, ".pi/swarm/mailboxes"), { recursive: true });
await writeFile(
	join(scratch, ".pi", "settings.json"),
	JSON.stringify({ swarm: { defaultModel: "glm-5.1", defaultProvider: "zai-coding-cn" } }),
);

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
	// Emulate a live pi tmux pane so deliverMessageLocked's pane-injection path succeeds:
	// display-message → pi command (isPanePiLike), list-panes → one pane (capturePane), rest → ok.
	exec: async (cmd, args) => {
		if (cmd === "tmux" && args?.[0] === "display-message") return { code: 0, stdout: "pi\t1234\n", stderr: "" };
		if (cmd === "tmux" && args?.[0] === "list-panes") return { code: 0, stdout: "%1 0 1 1\n", stderr: "" };
		return { code: 0, stdout: "", stderr: "" };
	},
};

// The message LEDGER (st.messages) carries lifecycle fields only — subject/body live in the
// recipient mailbox JSONL. Helper reads root's mailbox file.
async function readRootMailbox() {
	try {
		const raw = await readFile(join(scratch, ".pi", "swarm", "mailboxes", "root.jsonl"), "utf8");
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

async function readEvents() {
	try {
		const raw = await readFile(p.events, "utf8");
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
	return withLock(p, async () => idleGc.evaluateIdleAgentGcNudgeLocked(pi, scratch, p, st, nowMs, taskGraphs));
}

console.log("=== idle-agent-gc (RED-first) ===");

ok(
	"module src/nudges/idle-agent-gc.ts exports evaluateIdleAgentGcNudgeLocked (RED: missing pre-fix)",
	Boolean(idleGc && typeof idleGc.evaluateIdleAgentGcNudgeLocked === "function"),
	"import failed or export missing",
);

if (idleGc && typeof idleGc.evaluateIdleAgentGcNudgeLocked === "function") {
	// S1 — eligible idle agent gets exactly one nudge naming it
	{
		const st = makeState({ "worker-idle": makeAgent("worker-idle", { lastHeartbeatAt: iso(NOW - 30 * MIN) }) });
		const r = await run(st);
		ok("S1: evaluator emitted for eligible idle agent", r.nudged >= 1, JSON.stringify(r));
		const mail = await readRootMailbox();
		const nudges = mail.filter((m) => m.to === "root" && /idle-gc/.test(m.idempotencyKey || ""));
		ok(
			"S1: nudge addressed to root",
			nudges.length === 1 && /worker-idle/.test(nudges[0].subject || ""),
			JSON.stringify(nudges.map((m) => m.subject)),
		);
		const body = nudges[0]?.body || "";
		ok("S1: body names swarm_stop_agent tool", body.includes("swarm_stop_agent"), body.slice(0, 200));
		ok("S1: body NEVER names a /swarm slash command", !/\/swarm\s+\w/.test(body), body.slice(0, 300));
		ok("S1: body contains no raw .pi/ path", !body.includes(".pi/"), body.slice(0, 300));
		ok(
			"S1: R10-1 zero pi.sendMessage crossings (delivery stays L1 + pane-injection; L2 surfacing is the pump's job — pump-phases.ts:155 precedent)",
			sentMessages.length === 0,
			String(sentMessages.length),
		);
	}

	// S2 — heartbeat fresh → not eligible (busy-at-tool-boundary shape)
	{
		const st = makeState({ "worker-fresh": makeAgent("worker-fresh", { lastHeartbeatAt: iso(NOW - 2 * MIN) }) });
		const r = await run(st);
		ok("S2: fresh heartbeat not nudged", r.nudged === 0 && Object.keys(st.messages).length === 0, JSON.stringify(r));
		ok("S2: zero sendMessage (R10-1)", sentMessages.length === 0, String(sentMessages.length));
	}

	// S3 — busy (has activeTaskIds) skipped
	{
		const st = makeState({
			"worker-busy": makeAgent("worker-busy", {
				lastHeartbeatAt: iso(NOW - 30 * MIN),
				activeTaskIds: ["task-1"],
				runtimeStatus: "busy",
			}),
		});
		const r = await run(st);
		ok("S3: busy worker not nudged", r.nudged === 0, JSON.stringify(r));
	}

	// S4 — valid reuse lease skipped; expired lease eligible
	{
		const st = makeState({
			"worker-leased": makeAgent("worker-leased", {
				lastHeartbeatAt: iso(NOW - 30 * MIN),
				leaseKind: "reuse",
				leaseUntil: iso(NOW + 60 * MIN),
			}),
			"worker-expired": makeAgent("worker-expired", {
				lastHeartbeatAt: iso(NOW - 30 * MIN),
				leaseKind: "reuse",
				leaseUntil: iso(NOW - 10 * MIN),
			}),
		});
		const r = await run(st);
		const subjects = (await readRootMailbox()).map((m) => m.subject || "").join("|");
		ok("S4: leased worker skipped", !subjects.includes("worker-leased"), subjects);
		ok("S4: expired-lease worker nudged", subjects.includes("worker-expired"), subjects);
	}

	// S5 — paused skipped
	{
		const st = makeState({ "worker-paused": makeAgent("worker-paused", { lastHeartbeatAt: iso(NOW - 30 * MIN), paused: true }) });
		const r = await run(st);
		ok("S5: paused worker not nudged", r.nudged === 0, JSON.stringify(r));
	}

	// S6 — task-referenced (non-terminal node assignee) skipped
	{
		const graphs = [{ taskId: "task-9", nodes: { n1: { assignee: "worker-ref", status: "in_progress" } } }];
		const st = makeState({ "worker-ref": makeAgent("worker-ref", { lastHeartbeatAt: iso(NOW - 30 * MIN) }) });
		const r = await run(st, NOW, graphs);
		ok("S6: task-referenced worker not nudged", r.nudged === 0, JSON.stringify(r));
	}

	// S7 — cooldown: immediate re-run suppressed, after cooldown next seq fires
	{
		const st = makeState({ "worker-cd": makeAgent("worker-cd", { lastHeartbeatAt: iso(NOW - 30 * MIN) }) });
		await run(st);
		const n1 = Object.keys(st.messages).length;
		sentMessages.length = 0;
		const r2 = await run(st, NOW + MIN);
		ok(
			"S7: re-run within cooldown suppressed",
			r2.nudged === 0 && Object.keys(st.messages).length === n1,
			JSON.stringify({ r2, count: Object.keys(st.messages).length }),
		);
		const r3 = await run(st, NOW + 31 * MIN);
		ok("S7: re-run after cooldown nudges again", r3.nudged === 1, JSON.stringify(r3));
		ok("S7: R10-1 zero pi.sendMessage for the second nudge", sentMessages.length === 0, String(sentMessages.length));
	}

	// S8 — cap: maxNudges=2 (env) → 3rd call suppressed + cap trace once
	{
		process.env.PI_SWARM_IDLE_GC_MAX_NUDGES = "2";
		try {
			const st = makeState({ "worker-cap": makeAgent("worker-cap", { lastHeartbeatAt: iso(NOW - 30 * MIN) }) });
			await run(st, NOW);
			await run(st, NOW + 31 * MIN);
			const countBefore = Object.keys(st.messages).length;
			sentMessages.length = 0;
			await run(st, NOW + 62 * MIN);
			ok(
				"S8: cap reached — no further nudge",
				Object.keys(st.messages).length === countBefore,
				JSON.stringify(Object.keys(st.messages).length),
			);
			ok("S8: cap suppression sends nothing (R10-1)", sentMessages.length === 0, String(sentMessages.length));
			const events = await readEvents();
			const capTraces = events.filter((e) => e.event === "agent.idle_gc.cap");
			ok("S8: cap trace emitted exactly once", capTraces.length === 1, JSON.stringify(capTraces));
		} finally {
			delete process.env.PI_SWARM_IDLE_GC_MAX_NUDGES;
		}
	}

	// S9 — disabled: env off → phase no-op, zero sends
	{
		process.env.PI_SWARM_IDLE_GC_NUDGE_OFF = "1";
		try {
			const st = makeState({ "worker-off": makeAgent("worker-off", { lastHeartbeatAt: iso(NOW - 30 * MIN) }) });
			const r = await run(st);
			ok("S9: disabled evaluator no-op", (r.nudged ?? 0) === 0 && Object.keys(st.messages).length === 0, JSON.stringify(r));
			ok("S9: zero sendMessage when disabled (R10-1)", sentMessages.length === 0, String(sentMessages.length));
		} finally {
			delete process.env.PI_SWARM_IDLE_GC_NUDGE_OFF;
		}
	}

	// S10 — idempotency key family (on the durable mailbox line)
	{
		const st = makeState({ "worker-key": makeAgent("worker-key", { lastHeartbeatAt: iso(NOW - 30 * MIN) }) });
		await run(st);
		const msg = (await readRootMailbox()).find((m) => m.to === "root" && /worker-key/.test(m.idempotencyKey || ""));
		ok(
			"S10: idempotencyKey matches agent:{agentId}:nudge:idle-gc:{seq}",
			Boolean(msg?.idempotencyKey && /^agent:worker-key:nudge:idle-gc:1$/.test(msg.idempotencyKey)),
			msg?.idempotencyKey,
		);
	}
} else {
	// Count the S1–S10 blocks as failing so the suite exits non-zero in RED.
	for (let i = 1; i <= 10; i++) ok(`S${i} (blocked: module missing)`, false, "idle-agent-gc.ts not implemented yet");
}

console.log(`\n---\nidle-agent-gc results: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
