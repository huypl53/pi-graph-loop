// Reuse-misroute tests (roadmap issue 10, fix for the `plan-reviewer` vs `reviewer-01` collapse).
//
// Strategy: exercise the pure `matchReusableAgents(st, opts)` predicate extracted from
// `findReusableAgent` directly with synthetic SwarmState fixtures — no pi mock, no tmux IO,
// no agent factory. Each block asserts a single role-kind / active-lease / escape-hatch
// scenario from the plan §3.3 test plan.
//
// Run: node extensions/swarm/reuse-misroute.test.mjs
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const { matchReusableAgents } = await import(join(here, "..", "src", "agents.ts"));

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
	if (cond) { pass++; console.log("  ok  ", name); }
	else { fail++; console.error("  FAIL", name, extra); }
};

function mkAgent(id, role, roleKind, opts = {}) {
	return {
		id,
		role,
		roleKind,
		roleKindExplicit: true,
		capabilities: opts.capabilities || [],
		activeTaskIds: opts.activeTaskIds || [],
		maxConcurrentTasks: opts.maxConcurrentTasks ?? 1,
		status: "running",
		runtimeStatus: opts.runtimeStatus || "idle",
		health: opts.health || "healthy",
		tmuxSession: "s",
		tmuxWindow: id,
		tmuxTarget: `s:${id}.0`,
		model: "m",
		provider: "p",
		cwd: "/tmp",
		mailbox: "x",
		createdAt: "t",
		updatedAt: "t",
		paused: opts.paused,
	};
}

console.log("\n[1] plan-reviewer is excluded from a strict `reviewer` reuse lookup (Issue 10 fix)");
{
	// planner-reviewer: id contains "planner" (which inferRoleKind classifies to planner FIRST),
	// roleKind explicitly "planner". The reviewer-01 agent is the only reviewer.
	const st = {
		agents: {
			"planner-reviewer": mkAgent("planner-reviewer", "Planner-review liaison", "planner"),
			"reviewer-01": mkAgent("reviewer-01", "Senior reviewer", "reviewer"),
		},
		messages: {},
	};
	const got = matchReusableAgents(st, { roleKind: "reviewer" });
	ok("only reviewer-01 matched", got.length === 1 && got[0].agentId === "reviewer-01", `got=${JSON.stringify(got.map((m) => m.agentId))}`);
	ok("matchKind=exact", got[0]?.matchKind === "exact");
}

console.log("\n[2] reviewer-01 is excluded from a strict `planner` reuse lookup (negative-id symmetry)");
{
	// Reverse direction: looking for planner should NOT pick reviewer-01.
	const st = {
		agents: {
			"planner-reviewer": mkAgent("planner-reviewer", "Planner-review liaison", "planner"),
			"reviewer-01": mkAgent("reviewer-01", "Senior reviewer", "reviewer"),
		},
		messages: {},
	};
	const got = matchReusableAgents(st, { roleKind: "planner" });
	ok("only planner-reviewer matched", got.length === 1 && got[0].agentId === "planner-reviewer", `got=${JSON.stringify(got.map((m) => m.agentId))}`);
	ok("matchKind=exact", got[0]?.matchKind === "exact");
}

console.log("\n[3] Same-task active-lease guard excludes a busy agent on the SAME task");
{
	// plan-reviewer is already assigned to task "T" and is busy. Reviewer-01 is idle. Asking for
	// a reviewer for task "T" should exclude plan-reviewer (it's an unrelated id anyway) AND the
	// test is for the same-task guard: we add a third reviewer that is busy on T.
	const st = {
		agents: {
			"reviewer-busy": mkAgent("reviewer-busy", "Senior reviewer", "reviewer", { activeTaskIds: ["T"], runtimeStatus: "busy", maxConcurrentTasks: 1 }),
			"reviewer-idle": mkAgent("reviewer-idle", "Junior reviewer", "reviewer"),
		},
		messages: {},
	};
	const got = matchReusableAgents(st, { roleKind: "reviewer", excludeTaskId: "T" });
	ok("busy same-task agent excluded", !got.some((m) => m.agentId === "reviewer-busy"), `got=${JSON.stringify(got.map((m) => m.agentId))}`);
	ok("idle agent still included", got.some((m) => m.agentId === "reviewer-idle"), `got=${JSON.stringify(got.map((m) => m.agentId))}`);
}

console.log("\n[4] Same-task active-lease guard keeps an agent when its pointer is stale but it has settled (idle carve-out)");
{
	// reviewer-busy has T in activeTaskIds but is now runtimeStatus=idle. The reclaim path (not
	// the reuse predicate) is the right gate for this; the reuse predicate must NOT exclude it
	// because doing so would orphan work the reclaim flow is about to recover.
	const st = {
		agents: {
			"reviewer-busy-stale": mkAgent("reviewer-busy-stale", "Senior reviewer", "reviewer", { activeTaskIds: ["T"], runtimeStatus: "idle" }),
		},
		messages: {},
	};
	const got = matchReusableAgents(st, { roleKind: "reviewer", excludeTaskId: "T" });
	ok("idle-stale-pointer agent IS included (reclaim path owns the fix)", got.length === 1 && got[0].agentId === "reviewer-busy-stale", `got=${JSON.stringify(got.map((m) => m.agentId))}`);
}

console.log("\n[5] agentId escape-hatch bypasses same-task active-lease guard");
{
	// The caller passes agentId="reviewer-busy" explicitly. Even though the same-task guard
	// would normally exclude it, the explicit id forces inclusion.
	const st = {
		agents: {
			"reviewer-busy": mkAgent("reviewer-busy", "Senior reviewer", "reviewer", { activeTaskIds: ["T"], runtimeStatus: "busy", maxConcurrentTasks: 1 }),
		},
		messages: {},
	};
	const got = matchReusableAgents(st, { roleKind: "reviewer", excludeTaskId: "T", agentId: "reviewer-busy" });
	ok("escape-hatch: explicit agentId wins over same-task guard", got.length === 1 && got[0].agentId === "reviewer-busy", `got=${JSON.stringify(got.map((m) => m.agentId))}`);
	ok("matchKind=fallback for escape-hatch match", got[0]?.matchKind === "fallback");
}

console.log("\n[6] capabilities escape-hatch matches across role kinds");
{
	// Capabilities overlap is an explicit escape-hatch: a tester with `review` capability can
	// match a reviewer-kind request when capabilities are requested.
	const st = {
		agents: {
			"qa-tester": mkAgent("qa-tester", "QA tester", "tester", { capabilities: ["review"] }),
			"reviewer-01": mkAgent("reviewer-01", "Senior reviewer", "reviewer"),
		},
		messages: {},
	};
	// Without capabilities: only reviewer-01.
	const noCaps = matchReusableAgents(st, { roleKind: "reviewer" });
	ok("without caps: only reviewer-01", noCaps.length === 1 && noCaps[0].agentId === "reviewer-01", `got=${JSON.stringify(noCaps.map((m) => m.agentId))}`);
	// With capabilities=["review"]: qa-tester is included via capability escape-hatch
	// (its roleKind is "tester" so the roleKind filter would normally exclude it; capabilities
	// make it a fallback match). reviewer-01 still matches via roleKind.
	const withCaps = matchReusableAgents(st, { roleKind: "reviewer", capabilities: ["review"] });
	ok("with caps: both reviewers included", withCaps.length === 2, `got=${JSON.stringify(withCaps.map((m) => m.agentId))}`);
	ok("with caps: qa-tester matchKind=fallback", withCaps.some((m) => m.agentId === "qa-tester" && m.matchKind === "fallback"));
}

console.log("\n[7] substring-collapsed matchKind is recorded when roleKind field would pass but id re-derives to a different kind");
{
	// Synthesize an agent whose roleKind field is `reviewer` (passes the equality check) but
	// whose id re-derives to `planner` via inferRoleKind (the live bug case: agent was spawned
	// as a planner-review-liaison but ended up with roleKind="reviewer" recorded). The predicate
	// includes it (field matches) but flags substring-collapse for auditability.
	const st = {
		agents: {
			// id "planner-reviewer" re-derives to planner (idHas("planner") wins). roleKind field
			// explicitly set to "reviewer" (the bug condition).
			"planner-reviewer": mkAgent("planner-reviewer", "Planner-review liaison", "reviewer"),
		},
		messages: {},
	};
	const got = matchReusableAgents(st, { roleKind: "reviewer" });
	ok("substring-collapsed agent still included (field-equality wins)", got.length === 1 && got[0].agentId === "planner-reviewer", `got=${JSON.stringify(got.map((m) => m.agentId))}`);
	ok("matchKind=substring-collapsed (audit signal)", got[0]?.matchKind === "substring-collapsed");
}

console.log("\n[8] the root is never a reuse match (invariant preserved)");
{
	const st = {
		agents: {
			root: mkAgent("root", "PM", "root"),
			"reviewer-01": mkAgent("reviewer-01", "Senior reviewer", "reviewer"),
		},
		messages: {},
	};
	const got = matchReusableAgents(st, { roleKind: "reviewer" });
	ok("root excluded", !got.some((m) => m.agentId === "root"), `got=${JSON.stringify(got.map((m) => m.agentId))}`);
}

console.log(`\n${fail === 0 ? "REUSE-MISROUTE PASS" : "REUSE-MISROUTE FAIL"} (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
