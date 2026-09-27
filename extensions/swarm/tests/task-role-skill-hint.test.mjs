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

// 1. Regression guard: existing lines still present.
ok(
	"textResult contains 'Created task … at …' line",
	text.includes(`Created task task-role-skill-hint at .pi/swarm/tasks/task-role-skill-hint`),
	text,
);
ok("textResult contains 'Start: …' line", /^Start: \w+/m.test(text), text);
ok("textResult contains 'Ready: …' line", /^Ready: .*$/m.test(text), text);

// 2. Hint is exactly the concise form, appended as the last line.
const lines = text.split("\n");
const lastLine = lines[lines.length - 1];
ok("textResult ends with the exact concise hint", lastLine === "Hint: use task-role-staffing.", `last line: ${JSON.stringify(lastLine)}`);

// 3. Hint does NOT contain paths, tool names, or workflow directions.
ok("hint does not contain a path", !/Hint:[^]*\//.test(text), text);
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
