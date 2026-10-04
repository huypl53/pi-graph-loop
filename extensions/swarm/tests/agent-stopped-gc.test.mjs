#!/usr/bin/env node
/**
 * agent-stopped-gc.test.mjs — RED-first pure-function suite
 * (task-202610041206-issue-stopped-agent-reco / issue stopped-agent-records-gc, plan §RED)
 *
 * Seeded-state matrix (issue content §4): fresh-stopped / aged-stopped / task-referenced /
 * response-debt stopped agents — visibility + purge eligibility asserted BEFORE source edits.
 *
 * Contract under test (pre-fix: module missing → RED; post-fix → GREEN):
 *   - src/agent-gc.ts: stoppedGcCandidates(st, opts), applyStoppedGc(st, candidates, opts),
 *     filterAgentRows(rows, {includeStopped})
 *   Gates: status==="stopped" AND id!=="root" AND age >= stoppedOlderThanMs (default 24h)
 *          AND no non-terminal task node references it as assignee AND no response debt.
 *   Visibility: default view hides stopped rows; targeted agentId slim rows keep working;
 *               view:"full" implies includeStopped.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

let agentGc = null;
try {
	agentGc = await import(join(here, "..", "src", "agent-gc.ts"));
} catch {
	agentGc = null;
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

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const iso = (ms) => new Date(ms).toISOString();

function makeStoppedAgent(id, stoppedAtMs, extras = {}) {
	return {
		id,
		role: "worker",
		roleKind: "worker",
		status: "stopped",
		runtimeStatus: "stopped",
		health: "unhealthy",
		activeTaskIds: [],
		tmuxTarget: `sess:${id}`,
		lastShutdownAt: iso(stoppedAtMs),
		createdAt: iso(stoppedAtMs - HOUR),
		updatedAt: iso(stoppedAtMs),
		...extras,
	};
}

function makeState(agents, extras = {}) {
	return { version: 1, swarmId: "swarm-x", cwd: "/tmp", agents, delivered: {}, messages: {}, ...extras };
}

function statusRow(agent) {
	return { agentId: agent.id, status: agent.status, taskProgressState: "dead", paneAlive: false, why: "agent stopped" };
}

console.log("=== agent-stopped-gc (pure RED matrix) ===");

if (!agentGc || typeof agentGc.stoppedGcCandidates !== "function") {
	ok("module src/agent-gc.ts exports stoppedGcCandidates (RED: missing pre-fix)", false, "import failed or export missing");
} else {
	ok("module src/agent-gc.ts exports stoppedGcCandidates", true);

	const {
		stoppedGcCandidates,
		applyStoppedGc,
		DEFAULT_STOPPED_OLDER_THAN_MS,
	} = agentGc;

	ok("DEFAULT_STOPPED_OLDER_THAN_MS is 24h", DEFAULT_STOPPED_OLDER_THAN_MS === 24 * HOUR, String(DEFAULT_STOPPED_OLDER_THAN_MS));

	// Matrix: fresh-stopped (1h), aged-stopped (30h), task-referenced stopped (aged), debt stopped (aged)
	const agents = {
		root: { id: "root", status: "running", runtimeStatus: "idle", lastHeartbeatAt: iso(NOW) },
		fresh: makeStoppedAgent("fresh", NOW - 1 * HOUR),
		aged: makeStoppedAgent("aged", NOW - 30 * HOUR),
		referenced: makeStoppedAgent("referenced", NOW - 30 * HOUR),
		"in-debt": makeStoppedAgent("in-debt", NOW - 30 * HOUR),
		running: { id: "running", status: "running", runtimeStatus: "idle", lastHeartbeatAt: iso(NOW) },
	};
	const st = makeState(agents, {
		messages: {
			// response-debt message addressed to in-debt: delivered, requiresResponse, unresolved
			"m-1": {
				id: "m-1",
				from: "root",
				to: "in-debt",
				status: "mailbox_delivered",
				requiresResponse: true,
				createdAt: iso(NOW - HOUR),
				updatedAt: iso(NOW - HOUR),
			},
		},
	});
	const taskGraphs = [
		{
			taskId: "task-1",
			nodes: { n1: { id: "n1", role: "implementer", assignee: "referenced", status: "in_progress" } },
		},
	];

	const cands = stoppedGcCandidates(st, { nowMs: NOW, taskGraphs });
	const byId = Object.fromEntries(cands.map((c) => [c.agentId, c]));

	ok("fresh-stopped NOT purge-eligible (age < 24h)", byId.fresh && byId.fresh.eligible === false, JSON.stringify(byId.fresh));
	ok("aged-stopped purge-eligible (30h, unreferenced, debt-free)", byId.aged && byId.aged.eligible === true, JSON.stringify(byId.aged));
	ok(
		"task-referenced stopped NOT eligible, blocked by task reference",
		byId.referenced && byId.referenced.eligible === false && (byId.referenced.blocked || []).includes("task-referenced"),
		JSON.stringify(byId.referenced),
	);
	ok(
		"response-debt stopped NOT eligible, blocked by response debt",
		byId["in-debt"] && byId["in-debt"].eligible === false && (byId["in-debt"].blocked || []).includes("response-debt"),
		JSON.stringify(byId["in-debt"]),
	);
	ok("running agent is not a candidate at all", !("running" in byId), Object.keys(byId).join(","));
	ok("root is never a candidate", !("root" in byId), Object.keys(byId).join(","));

	// applyStoppedGc: removes eligible records + delivered ledger, keeps everything else
	const st2 = makeState(
		{
			...agents,
			aged: makeStoppedAgent("aged", NOW - 30 * HOUR),
			referenced: makeStoppedAgent("referenced", NOW - 30 * HOUR),
			"in-debt": makeStoppedAgent("in-debt", NOW - 30 * HOUR),
		},
		{
			messages: st.messages,
		delivered: { aged: ["m-9"], referenced: ["m-8"], "in-debt": ["m-7"], root: ["m-0"] },
		},
	);
	const cands2 = stoppedGcCandidates(st2, { nowMs: NOW, taskGraphs });
	const res = applyStoppedGc(st2, cands2, { dryRun: false });
	ok("applyStoppedGc purged exactly the eligible agent", res.purged.includes("aged") && res.purged.length === 1, JSON.stringify(res));
	ok("purged agent record removed from state", !st2.agents.aged, "aged still present");
	ok("purged delivered ledger removed", !st2.delivered.aged, "delivered.aged still present");
	ok("task-referenced record kept", Boolean(st2.agents.referenced), "referenced removed!");
	ok("response-debt record kept", Boolean(st2.agents["in-debt"]), "in-debt removed!");
	ok("dryRun leaves state untouched", (() => {
		const st3 = makeState({ aged: makeStoppedAgent("aged", NOW - 30 * HOUR) }, { delivered: { aged: ["m-9"] } });
		const c = stoppedGcCandidates(st3, { nowMs: NOW });
		applyStoppedGc(st3, c, { dryRun: true });
		return Boolean(st3.agents.aged) && Boolean(st3.delivered.aged);
	})(), "dryRun mutated state");
}

// filterAgentRows — default hiding + includeStopped + full view
if (!agentGc || typeof agentGc.filterAgentRows !== "function") {
	ok("module src/agent-gc.ts exports filterAgentRows (RED: missing pre-fix)", false, "import failed or export missing");
} else {
	const { filterAgentRows } = agentGc;
	const rows = [statusRow({ id: "root", status: "running" }), statusRow({ id: "live", status: "running" }), statusRow({ id: "dead", status: "stopped" })];

	ok("default view hides stopped rows", filterAgentRows(rows, {}).length === 2 && !filterAgentRows(rows, {}).some((r) => r.status === "stopped"), JSON.stringify(filterAgentRows(rows, {})));
	ok("includeStopped:true shows all rows", filterAgentRows(rows, { includeStopped: true }).length === 3);
	ok("view:full implies includeStopped", filterAgentRows(rows, { view: "full" }).length === 3);
	ok("targeted stopped row still returned (regression guard)", filterAgentRows([rows[2]], { agentId: "dead" }).length === 1, "stopped targeted row was hidden");
	ok("targeted live row unaffected", filterAgentRows([rows[1]], { agentId: "live" }).length === 1);
	ok("live rows never hidden by default", filterAgentRows(rows, {}).some((r) => r.agentId === "live"));
}

console.log(`\n---\nagent-stopped-gc results: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
