#!/usr/bin/env node
/**
 * R26: scope parser must treat trailing-slash dir patterns as subtree coverage.
 *
 * Plan §0 root cause: normalizeScopePattern splits on '/' and rejects empty segments,
 * so "a/b/" yields null → scopePatternsOverlap returns "unknown" → scopesOverlap
 * conservatively reports conflict on any pair containing a trailing-slash pattern.
 * Net effect: NO two implement leases with dir scopes can ever run concurrently
 * (spurious ACTIVE_SCOPE_CONFLICT). This blocked R25 plan assignment.
 *
 * Plan §2 fix: in normalizeScopePattern, detect trailing slash BEFORE split; strip;
 * re-append a trailing "**" sentinel so dir/ ≡ dir/**.
 *
 * RED asserts (current broken behavior) → GREEN after fix.
 */

import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { rmSync, existsSync, readFileSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const scratch = join(tmpdir(), `swarm-r26-scope-${process.pid}-${Date.now()}`);
rmSync(scratch, { recursive: true, force: true });

// Real-module import for the unit tests (deterministic, offline, no side effects).
const {
	normalizeScopePattern,
	scopePatternsOverlap,
	scopesOverlap,
} = await import(join(here, "..", "src", "taskgraph.ts"));

let fail = 0;
const ok = (name, cond, info) => {
	if (cond) console.log("  ok  ", name);
	else { fail++; console.error("  FAIL", name, info !== undefined ? `(${JSON.stringify(info)})` : ""); }
};

console.log("\n== Unit tests ==");

// §3 regression matrix — dir-with-trailing-slash semantics (post-fix truth)
ok("dir/disjoint: ('a/b/','c/d/') === false", scopePatternsOverlap("a/b/", "c/d/") === false);
ok("dir/equal: ('a/b/','a/b/') === true", scopePatternsOverlap("a/b/", "a/b/") === true);
ok("dir/file-in-dir: ('a/b/','a/b/c.ts') === true", scopePatternsOverlap("a/b/", "a/b/c.ts") === true);
ok("dir/dir-itself: ('a/b/','a/b') === true (dir covers itself)", scopePatternsOverlap("a/b/", "a/b") === true);
ok("dir/nested-file: ('a/b/','a/b/c/d.ts') === true", scopePatternsOverlap("a/b/", "a/b/c/d.ts") === true);

// §3 regression matrix — previously-valid unchanged (no behavior drift)
ok("exact-equal: ('a','a') === true", scopePatternsOverlap("a", "a") === true);
ok("prefix-mismatch: ('a','a/b') === false (exact prefix, not subtree)", scopePatternsOverlap("a", "a/b") === false);
ok("exact-prefix-not-subtree: ('a/b','a/b/c') === false", scopePatternsOverlap("a/b", "a/b/c") === false);
ok("intra-glob: ('src/*.ts','src/a.ts') === true", scopePatternsOverlap("src/*.ts", "src/a.ts") === true);
ok("intra-glob-mismatch: ('src/*.ts','src/nested/a.ts') === false", scopePatternsOverlap("src/*.ts", "src/nested/a.ts") === false);
ok("wildcard-subtree: ('src/**','src/a.ts') === true", scopePatternsOverlap("src/**", "src/a.ts") === true);
ok("brace-glob: ('src/**/*.{ts,tsx}','src/a.ts') stays 'unknown' (unsupported syntax)",
	scopePatternsOverlap("src/**/*.{ts,tsx}", "src/a.ts") === "unknown");
ok("absolute path: ('/etc/passwd','a') stays 'unknown'", scopePatternsOverlap("/etc/passwd", "a") === "unknown");
ok("parent-traversal: ('a/../b','a') stays 'unknown'", scopePatternsOverlap("a/../b", "a") === "unknown");
ok("dot-segment: ('./a','./a') stays 'unknown'", scopePatternsOverlap("./a", "./a") === "unknown");

// §3 — double-trailing-slash handled (normalized)
ok("double-trailing: ('a/b//','a/b/c') === true (collapsed to a/b/)",
	scopePatternsOverlap("a/b//", "a/b/c") === true);
ok("internal-double-slash: ('a//b','a') stays 'unknown' (internal // never collapses)",
	scopePatternsOverlap("a//b", "a") === "unknown");

// §3 — scopesOverlap returns the right relation for equal trailing-slash dirs
const eqDisjoint = scopesOverlap({ files: ["ext-a/"] }, { files: ["ext-b/"] });
ok("scopesOverlap disjoint dirs === {overlap:false}",
	JSON.stringify(eqDisjoint) === JSON.stringify({ overlap: false }), eqDisjoint);

const eqSame = scopesOverlap({ files: ["ext-a/"] }, { files: ["ext-a/"] });
ok("scopesOverlap equal trailing-slash dirs === {overlap:true,relation:'equal'}",
	JSON.stringify(eqSame) === JSON.stringify({ overlap: true, relation: "equal" }), eqSame);

const dirVsFile = scopesOverlap({ files: ["ext-a/"] }, { files: ["ext-a/specific.ts"] });
ok("scopesOverlap dir vs file inside dir === {overlap:true,relation:'glob-match'}",
	JSON.stringify(dirVsFile) === JSON.stringify({ overlap: true, relation: "glob-match" }), dirVsFile);

// Unknown-syntax floor still conservatively conflicts
const unknownSyntax = scopesOverlap({ files: ["{a,b}/"] }, { files: ["c/"] });
ok("scopesOverlap unknown-syntax (brace glob) still conservatively conflicting",
	JSON.stringify(unknownSyntax) === JSON.stringify({ overlap: true, relation: "unknown-syntax" }), unknownSyntax);

// normalizeScopePattern returns non-null array for trailing-slash dir
const np = normalizeScopePattern("a/b/");
ok("normalizeScopePattern('a/b/') returns array (not null)", Array.isArray(np), np);

console.log("\n== E2E: parallel assign of two disjoint dir-scoped tasks ==");

// Now the E2E: real tool-handler factory, scratch cwd, two registered workers.
process.env.PI_SWARM_AGENT_ID = "root";
const mod = await import(join(here, "..", "index.ts"));
const factory = mod.default;

const tools = {};
const pi = {
	registerTool: (def) => { tools[def.name] = def; },
	registerCommand: () => {},
	on: () => {},
	exec: async (cmd, args) => {
		if (cmd === "tmux" && args[0] === "display-message") return { code: 0, stdout: "%1\n", stderr: "" };
		if (cmd === "git") return { code: 0, stdout: "deadbeef\n", stderr: "" };
		return { code: 1, stdout: "", stderr: "" };
	},
	sendMessage: () => {},
};
factory(pi);

const call = async (name, params) => {
	const t = tools[name]; if (!t) throw new Error("no tool " + name);
	return t.execute("call", params, undefined, undefined, { cwd: scratch });
};
const awaitAs = async (agentId, name, params) => {
	const prev = process.env.PI_SWARM_AGENT_ID;
	process.env.PI_SWARM_AGENT_ID = agentId;
	try { return await call(name, params); } finally { process.env.PI_SWARM_AGENT_ID = prev; }
};

async function ensureWorker(agentId, roleKind) {
	await awaitAs(agentId, "swarm_register_agent", {
		tmuxTarget: "unknown",
		role: `test ${roleKind}`,
		roleKind,
		id: agentId,
		inject: false,
	});
}

await ensureWorker("worker-a", "implementer");
await ensureWorker("worker-b", "implementer");

// Task 26-a: implement node allowedFiles ["ext-a/"]
const ctA = await call("swarm_create_task", {
	title: "R26-A disjoint dir scope",
	goal: "g",
	priority: "normal",
	cwd: scratch,
	start: "plan",
	nodes: {
		plan: { role: "planner" },
		implement: { role: "implementer", dependsOn: ["plan"], allowedFiles: ["ext-a/"] },
	},
	edges: [{ from: "plan", to: "implement", when: "planned" }],
});
const taskIdA = ctA.content[0].text.match(/task-[A-Za-z0-9-]+/)[0];

await call("swarm_assign_task", { taskId: taskIdA, nodeId: "plan", agentId: "worker-a", cwd: scratch });
const planA = JSON.parse(readFileSync(join(scratch, `.pi/swarm/tasks/${taskIdA}/task.json`), "utf8")).nodes.plan;
await awaitAs("worker-a", "swarm_update_task", {
	taskId: taskIdA, nodeId: "plan", status: "done", outcome: "planned",
	attemptId: planA.activeAttemptId, cwd: scratch,
});
await call("swarm_assign_task", { taskId: taskIdA, nodeId: "implement", agentId: "worker-a", cwd: scratch });
ok("26-a/implement active lease held", existsSync(join(scratch, `.pi/swarm/tasks/${taskIdA}/task.json`)));

// Task 26-b: implement node allowedFiles ["ext-b/"] — disjoint dir, must NOT conflict
const ctB = await call("swarm_create_task", {
	title: "R26-B disjoint dir scope",
	goal: "g",
	priority: "normal",
	cwd: scratch,
	start: "plan",
	nodes: {
		plan: { role: "planner" },
		implement: { role: "implementer", dependsOn: ["plan"], allowedFiles: ["ext-b/"] },
	},
	edges: [{ from: "plan", to: "implement", when: "planned" }],
});
const taskIdB = ctB.content[0].text.match(/task-[A-Za-z0-9-]+/)[0];

// Advance 26-b's plan to done before assigning implement
await call("swarm_assign_task", { taskId: taskIdB, nodeId: "plan", agentId: "worker-a", cwd: scratch });
const planB = JSON.parse(readFileSync(join(scratch, `.pi/swarm/tasks/${taskIdB}/task.json`), "utf8")).nodes.plan;
await awaitAs("worker-a", "swarm_update_task", {
	taskId: taskIdB, nodeId: "plan", status: "done", outcome: "planned",
	attemptId: planB.activeAttemptId, cwd: scratch,
});

// RED case pre-fix: assigning 26-b/implement to worker-b throws ACTIVE_SCOPE_CONFLICT
let bResult = null;
let bThrew = null;
try {
	bResult = await call("swarm_assign_task", { taskId: taskIdB, nodeId: "implement", agentId: "worker-b", cwd: scratch });
} catch (err) {
	bThrew = err;
}
ok("26-b assign: succeeds (no ACTIVE_SCOPE_CONFLICT) — disjoint trailing-slash dirs allowed",
	bThrew === null && bResult !== null, bThrew ? bThrew.errorCode : null);

// Negative control: same dir on two tasks MUST still conflict (conservative floor for real conflict)
const ctC = await call("swarm_create_task", {
	title: "R26-C SAME dir scope (negative control)",
	goal: "g",
	priority: "normal",
	cwd: scratch,
	start: "plan",
	nodes: {
		plan: { role: "planner" },
		implement: { role: "implementer", dependsOn: ["plan"], allowedFiles: ["ext-a/"] },
	},
	edges: [{ from: "plan", to: "implement", when: "planned" }],
});
const taskIdC = ctC.content[0].text.match(/task-[A-Za-z0-9-]+/)[0];
// Advance plan first
await call("swarm_assign_task", { taskId: taskIdC, nodeId: "plan", agentId: "worker-a", cwd: scratch });
const planC = JSON.parse(readFileSync(join(scratch, `.pi/swarm/tasks/${taskIdC}/task.json`), "utf8")).nodes.plan;
await awaitAs("worker-a", "swarm_update_task", {
	taskId: taskIdC, nodeId: "plan", status: "done", outcome: "planned",
	attemptId: planC.activeAttemptId, cwd: scratch,
});
let cThrew = null;
try {
	await call("swarm_assign_task", { taskId: taskIdC, nodeId: "implement", agentId: "worker-b", cwd: scratch });
} catch (err) {
	cThrew = err;
}
ok("negative control: same trailing-slash dir on second task still ACTIVE_SCOPE_CONFLICT",
	cThrew !== null && cThrew.errorCode === "ACTIVE_SCOPE_CONFLICT",
	cThrew ? cThrew.errorCode : null);

// Unknown-syntax negative control: brace-glob scope still conservatively conflicts
const ctD = await call("swarm_create_task", {
	title: "R26-D unknown-syntax scope (negative control)",
	goal: "g",
	priority: "normal",
	cwd: scratch,
	start: "plan",
	nodes: {
		plan: { role: "planner" },
		implement: { role: "implementer", dependsOn: ["plan"], allowedFiles: ["{a,b}/"] },
	},
	edges: [{ from: "plan", to: "implement", when: "planned" }],
});
const taskIdD = ctD.content[0].text.match(/task-[A-Za-z0-9-]+/)[0];
// Advance plan first
await call("swarm_assign_task", { taskId: taskIdD, nodeId: "plan", agentId: "worker-a", cwd: scratch });
const planD = JSON.parse(readFileSync(join(scratch, `.pi/swarm/tasks/${taskIdD}/task.json`), "utf8")).nodes.plan;
await awaitAs("worker-a", "swarm_update_task", {
	taskId: taskIdD, nodeId: "plan", status: "done", outcome: "planned",
	attemptId: planD.activeAttemptId, cwd: scratch,
});
let dThrew = null;
try {
	await call("swarm_assign_task", { taskId: taskIdD, nodeId: "implement", agentId: "worker-b", cwd: scratch });
} catch (err) {
	dThrew = err;
}
ok("negative control: unknown-syntax scope still ACTIVE_SCOPE_CONFLICT",
	dThrew !== null && dThrew.errorCode === "ACTIVE_SCOPE_CONFLICT",
	dThrew ? dThrew.errorCode : null);

// Cleanup
rmSync(scratch, { recursive: true, force: true });

console.log(`\nR26 SCOPE ${fail === 0 ? "PASS" : "FAIL"} (${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
