#!/usr/bin/env node
// role-playbook-spawn.test.mjs — Phase 0 red tests for role-playbook injection
//
// REPRODUCE-FIRST MANDATE: these tests were authored BEFORE the implementation and
// observed RED for the right reason (no --skill injection, no resolveRolePlaybook
// resolver, no Role Playbook section in identity, no playbook line in assignment
// bodies). They went green when the implementation landed.
//
// Run: node extensions/swarm/tests/role-playbook-spawn.test.mjs
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

let pass = 0,
	fail = 0;
const ok = (name, cond, info) => {
	if (cond) {
		pass++;
		console.log(`  ok   ${name}`);
	} else {
		fail++;
		console.error(`  FAIL ${name}${info ? ` — ${info}` : ""}`);
	}
};

console.log("=== Role playbook spawn ===");

// ---------------------------------------------------------------- childPiArgs / --skill
{
	const sessionMod = await import("../src/session.ts");
	const childPiArgs = sessionMod.childPiArgs;
	const childPiArgsWithSkills = sessionMod.childPiArgsWithSkills;
	delete process.env.PI_SWARM_CHILD_ARGS;

	// Baseline contract (pins existing behavior, must stay green throughout):
	const base = childPiArgs();
	ok("baseline: childPiArgs() has -e <abs-ext>", /-e\s+'?\S+'?$/.test(base) && base.includes("-e"));

	if (typeof childPiArgsWithSkills !== "function") {
		ok("childPiArgsWithSkills is exported", false, "export missing (RED)");
	} else {
		ok("childPiArgsWithSkills is exported", true);
		const withPlanner = childPiArgsWithSkills(["/abs/playbooks/planner"]);
		ok(
			"childPiArgsWithSkills(['/abs/playbooks/planner']) contains --skill '/abs/playbooks/planner'",
			withPlanner.includes("--skill") && withPlanner.includes("/abs/playbooks/planner"),
			`actual: ${withPlanner}`,
		);
		const basePos = withPlanner.indexOf("-e");
		const skillPos = withPlanner.indexOf("--skill");
		ok("--skill comes after -e args", basePos !== -1 && skillPos !== -1 && basePos < skillPos);
		const withTwo = childPiArgsWithSkills(["/abs/a", "/abs/b"]);
		ok("two skills append two --skill flags", (withTwo.match(/--skill/g) || []).length === 2);
		ok(
			"default childPiArgs() unchanged (no skills → no --skill)",
			!childPiArgs().includes("--skill"),
			`actual: ${childPiArgs()}`,
		);
		// PI_SWARM_CHILD_ARGS passthrough still wins verbatim even with skills
		process.env.PI_SWARM_CHILD_ARGS = "--approve --no-extensions";
		ok(
			"PI_SWARM_CHILD_ARGS wins verbatim even when skills passed",
			childPiArgsWithSkills(["/abs/a"]) === "--approve --no-extensions",
		);
		delete process.env.PI_SWARM_CHILD_ARGS;
	}
}

// ---------------------------------------------------------------- resolveRolePlaybook
{
	const { resolveRolePlaybook } = await import("../src/config.ts");
	if (typeof resolveRolePlaybook !== "function") {
		ok("resolveRolePlaybook is exported from config.ts", false, "export missing (RED)");
	} else {
		ok("resolveRolePlaybook is exported from config.ts", true);
		for (const kind of ["planner", "implementer", "tester", "reviewer"]) {
			const p = resolveRolePlaybook(kind);
			ok(
				`resolveRolePlaybook('${kind}') returns a path`,
				typeof p === "string" && p.length > 0,
				`got ${p}`,
			);
			if (typeof p !== "string") continue;
			ok(
				`resolveRolePlaybook('${kind}') points at role-skills/${kind}`,
				p.includes(`role-skills/${kind}`) || p.includes(`role-skills\\${kind}`) || p.endsWith(`${kind}`),
				`got ${p}`,
			);
			ok(`resolveRolePlaybook('${kind}') path exists on disk`, existsSync(p), `got ${p}`);
		}

		// Fix node resolves the FIXER playbook, not implementer (playbook-layer selection only).
		const fixByNodeId = resolveRolePlaybook("implementer", { nodeId: "fix" });
		ok(
			"fix-node (roleKind implementer, nodeId 'fix') resolves fixer playbook",
			typeof fixByNodeId === "string" && fixByNodeId.includes("fixer"),
			`got ${fixByNodeId}`,
		);
		const fixByRoleStr = resolveRolePlaybook("implementer", { role: "fix implementer (rework)" });
		ok(
			"role string starting 'fix' resolves fixer playbook",
			typeof fixByRoleStr === "string" && fixByRoleStr.includes("fixer"),
			`got ${fixByRoleStr}`,
		);

		// Plain implementer does NOT get the fixer playbook.
		const impl = resolveRolePlaybook("implementer");
		ok(
			"plain implementer is NOT fixer playbook",
			typeof impl === "string" && !impl.includes("fixer"),
			`got ${impl}`,
		);

		// Root/observer/worker have no playbook.
		for (const kind of ["root", "observer", "worker"]) {
			ok(
				`resolveRolePlaybook('${kind}') is null (no playbook)`,
				resolveRolePlaybook(kind) === null,
				`got ${resolveRolePlaybook(kind)}`,
			);
		}
	}
}

// ---------------------------------------------------------------- buildIdentityMarkdown
{
	const { buildIdentityMarkdown } = await import("../src/identity.ts");
	const mkAgent = (id, role, roleKind) => ({
		id,
		role,
		roleKind,
		capabilities: [],
		activeTaskIds: [],
		maxConcurrentTasks: 1,
		status: "running",
		cwd: "/tmp/proj",
		tmuxTarget: "s:w.0",
		tmuxSession: "s",
		tmuxWindow: "w",
		mailbox: ".pi/swarm/mailboxes/a.jsonl",
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		model: "m",
		provider: "p",
	});
	const st = { swarmId: "swarm-test", agents: {} };
	const mdPlanner = buildIdentityMarkdown(st, mkAgent("planner-01", "Task planner", "planner"));
	ok("identity markdown contains '## Role Playbook' section", mdPlanner.includes("## Role Playbook"), "expected '## Role Playbook' heading");
	ok(
		"identity Role Playbook section references the planner playbook path",
		mdPlanner.includes("role-skills/planner"),
		`expected planner playbook path in Role Playbook section`,
	);
	ok(
		"identity Role Playbook section includes the charter (correctness first)",
		/không sai|not-wrong beats beautiful|Correctness first/i.test(mdPlanner),
		"expected charter text",
	);
	const mdImpl = buildIdentityMarkdown(st, mkAgent("implementer-01", "Node implementer", "implementer"));
	ok(
		"implementer identity references implementer playbook",
		mdImpl.includes("role-skills/implementer"),
		"expected implementer playbook path",
	);
}

// ---------------------------------------------------------------- buildAssignmentBody
{
	const { buildAssignmentBody } = await import("../src/taskgraph/formatting.ts");
	const task = {
		version: 1,
		taskId: "task-role-playbook-spawn",
		title: "Role playbook spawn",
		goal: "Inject role playbooks at spawn",
		status: "in_progress",
		priority: "normal",
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		owner: "root",
		workflow: "feature-dev",
		allowedFiles: ["src/a.ts"],
		acceptanceCriteria: ["criterion one"],
		validationCommands: [],
		start: "plan",
		currentNodes: [],
		sharedContext: { summary: "", decisions: [], openQuestions: [], risks: [] },
		nodes: {
			implement: { status: "assigned", role: "implementer", dependsOn: [], messageIds: [], attempts: 1, maxAttempts: 3 },
			test: { status: "pending", role: "tester", dependsOn: ["implement"], messageIds: [], attempts: 0, maxAttempts: 3 },
		},
		edges: [{ from: "implement", to: "test", when: "implemented" }],
		handoffs: [],
		gates: {},
		evidence: {},
	};
	const bodyImplement = buildAssignmentBody(task, "implement", "root");
	ok("assignment body contains 'Role playbook:' line", bodyImplement.includes("Role playbook:"), `body:\n${bodyImplement}`);
	ok(
		"assignment body references the role-skills path",
		/role-skills\/implementer/.test(bodyImplement),
		`body:\n${bodyImplement}`,
	);
	const bodyTest = buildAssignmentBody(task, "test", "root");
	ok(
		"tester assignment body references the tester playbook",
		/role-skills\/tester/.test(bodyTest),
		`body:\n${bodyTest}`,
	);
}

// ---------------------------------------------------------------- role skill frontmatter (pi validation rules)
{
	const roleSkillsDir = join(new URL(".", import.meta.url).pathname, "../role-skills");
	ok("role-skills directory exists", existsSync(roleSkillsDir));
	const expected = ["planner", "implementer", "fixer", "tester", "reviewer"];
	const seen = [];
	try {
		seen.push(...readdirSync(roleSkillsDir).filter((d) => !d.startsWith(".")));
	} catch {}
	ok(
		`role-skills has all five playbook dirs (${expected.join(", ")})`,
		expected.every((e) => seen.includes(e)),
		`seen: ${seen.join(", ")}`,
	);
	for (const kind of expected) {
		const skillFile = join(roleSkillsDir, kind, "SKILL.md");
		if (!existsSync(skillFile)) {
			ok(`role-skills/${kind}/SKILL.md exists`, false, "missing file");
			continue;
		}
		const raw = readFileSync(skillFile, "utf8");
		const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/);
		if (!fmMatch) {
			ok(`role-skills/${kind}: frontmatter block present`, false, "no --- block");
			continue;
		}
		const fm = fmMatch[1];
		const nameM = fm.match(/^name:\s*(.+)$/m);
		const descM = fm.match(/^description:\s*(.+)$/m);
		ok(`role-skills/${kind}: name present`, !!nameM);
		ok(`role-skills/${kind}: description present`, !!descM);
		if (nameM) {
			const name = nameM[1].trim();
			ok(
				`role-skills/${kind}: name='${name}' ≤64 chars lowercase-hyphen`,
				name.length <= 64 &&
					/^[a-z0-9-]+$/.test(name) &&
					!name.startsWith("-") &&
					!name.endsWith("-") &&
					!name.includes("--"),
			);
		}
		if (descM) {
			ok(
				`role-skills/${kind}: description ≤1024 chars and non-empty`,
				descM[1].trim().length <= 1024 && descM[1].trim().length > 0,
			);
		}
		ok(`role-skills/${kind}: name matches directory`, nameM ? nameM[1].trim() === kind : false);
	}
	// ROLE_CHARTER_DEFAULT constant exists
	const { ROLE_CHARTER_DEFAULT, ROLE_PLAYBOOK_KINDS } = await import("../src/constants.ts");
	ok(
		"ROLE_CHARTER_DEFAULT exported from constants.ts",
		typeof ROLE_CHARTER_DEFAULT === "string" && ROLE_CHARTER_DEFAULT.length > 10,
	);
	ok(
		"ROLE_PLAYBOOK_KINDS exported from constants.ts",
		Array.isArray(ROLE_PLAYBOOK_KINDS) && ROLE_PLAYBOOK_KINDS.length === 5,
		`got ${ROLE_PLAYBOOK_KINDS}`,
	);
	ok(
		"ROLE_CHARTER_DEFAULT contains the correctness-first philosophy",
		/không sai|not-wrong beats beautiful/i.test(ROLE_CHARTER_DEFAULT || ""),
		`got: ${ROLE_CHARTER_DEFAULT}`,
	);
}

console.log(`\nResults: ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
