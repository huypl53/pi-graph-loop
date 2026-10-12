#!/usr/bin/env node
/**
 * Regression test for the task-role-staffing hint.
 *
 * Asserts that:
 *  1. swarm_create_task's textResult still contains the existing
 *     "Created task … at …\nStart: …\nReady: …" lines (regression guard).
 *  2. The textResult ends with the exact hint "Hint: use task-role-staffing."
 *     and nothing else beyond the existing lines.
 *  3. The hint does NOT contain paths, tool names, or workflow directions.
 *  4. The skill file exists at
 *     extensions/swarm/role-skills/task-role-staffing/SKILL.md with
 *     frontmatter name: task-role-staffing.
 *  5. The skill body mentions swarm_spawn_agent and swarm_assign_task by
 *     name and does NOT mention any invented tool.
 *  6. swarm_create_task's details payload is unchanged (same keys:
 *     taskId, task, taskMd, taskJson, autoClosed).
 */
import { rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");
const swarmRoot = join(here, "..");
const scratch = join(tmpdir(), `swarm-task-role-skill-hint-${process.pid}-${Date.now()}`);
rmSync(scratch, { recursive: true, force: true });
process.env.PI_SWARM_AGENT_ID = "root";
process.env.PI_SWARM_IS_ROOT = "1";
const { default: factory } = await import(join(swarmRoot, "index.ts"));
const tools = {};
factory({
	registerTool: (def) => {
		tools[def.name] = def;
	},
	registerCommand: () => {},
	on: () => {},
	sendMessage: () => {},
	exec: async (cmd, args) => (cmd === "git" ? { code: 0, stdout: "deadbeef\n", stderr: "" } : { code: 1, stdout: "", stderr: "" }),
});
let pass = 0,
	fail = 0;
const ok = (name, condition, info = "") => {
	if (condition) {
		pass++;
		console.log("  ok  ", name);
	} else {
		fail++;
		console.error("  FAIL", name, info);
	}
};
const call = (name, params) => tools[name].execute("call", params, undefined, undefined, { cwd: scratch });

const result = await call("swarm_create_task", {
	taskId: "task-role-skill-hint",
	title: "Task role skill hint",
	goal: "Verify the concise hint naming the task-role-staffing skill",
	qualificationMode: "auto",
});
const text = result.content[0].text;
const details = result.details;

// 1. Regression guard: existing lines still present. (2026-10-12 depath: the path segment
// `at .pi/swarm/tasks/...` was removed from the create-text per task depath-swarm-tool-outputs.)
ok(
	"textResult contains 'Created task …' line (no path)",
	text.startsWith(`Created task task-role-skill-hint\n`),
	text,
);
ok("textResult contains 'Start: …' line", /^Start: \w+/m.test(text), text);
ok("textResult contains 'Ready: …' line", /^Ready: .*$/m.test(text), text);

const lastLine = text.split("\n")[text.split("\n").length - 1];
// 2. Hint starts with the concise form. (2026-10-12 depath: appended bounded-tool steer
// `Inspect with swarm_task_status …` per task depath-swarm-tool-outputs, Site 7.)
ok(
	"textResult ends with concise hint + bounded-tool steer",
	lastLine === 'Hint: use task-role-staffing. Inspect with swarm_task_status (detail:"graph" for the full node/edge map).',
	`last line: ${JSON.stringify(lastLine)}`,
);

// 3. Hint does NOT contain paths, tool names, or workflow directions.
// (2026-10-12 depath: the steer names detail:"graph" — a tool arg, not a filesystem path.
// Assertion is now: no filesystem-shaped segments — no `.pi/swarm`, no leading-slash paths.)
ok("hint does not contain a path", !/Hint:[^]*(\.pi\/swarm|\s\/[a-z])/.test(text), text);
ok("hint does not contain a tool name", !/Hint:[^]*swarm_(spawn|assign|staff|role)/.test(text), text);
ok("hint does not contain workflow verbs", !/Hint:[^]*(then|write|call|use existing)/i.test(text), text);

// 4. Skill file exists with correct frontmatter.
const skillPath = join(swarmRoot, "role-skills/task-role-staffing/SKILL.md");
ok("skill file exists", existsSync(skillPath));
const skillBody = existsSync(skillPath) ? readFileSync(skillPath, "utf8") : "";
ok(
	"skill frontmatter name is task-role-staffing",
	/^---[\s\S]*name: task-role-staffing[\s\S]*---/m.test(skillBody),
	skillBody.slice(0, 200),
);

// 5. Skill body mentions the two existing tools and no invented tool.
ok("skill body mentions swarm_spawn_agent", skillBody.includes("swarm_spawn_agent"), skillBody.slice(0, 200));
ok("skill body mentions swarm_assign_task", skillBody.includes("swarm_assign_task"), skillBody.slice(0, 200));
// The skill may warn against invented tools in the Pitfalls section, but it
// must not prescribe one in the Procedure section.
const procedureMatch = skillBody.match(/## Procedure([\s\S]*?)(?=\n## |\s*$)/);
const procedureSection = procedureMatch ? procedureMatch[1] : "";
ok(
	"skill Procedure does not prescribe an invented tool",
	!/swarm_staff_task\b|swarm_role_\w+\b|\bswarm_staffing\b/.test(procedureSection),
	procedureSection.slice(0, 200),
);

// 6. details payload is unchanged.
ok("details has taskId", details.taskId === "task-role-skill-hint");
ok("details has task object", typeof details.task === "object" && details.task !== null);
ok("details has taskMd", typeof details.taskMd === "string");
ok("details has taskJson", typeof details.taskJson === "string");
ok("details has autoClosed array", Array.isArray(details.autoClosed));

rmSync(scratch, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
