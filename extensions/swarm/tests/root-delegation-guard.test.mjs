#!/usr/bin/env node
/**
 * Test: Root Orchestrator Delegation Guard & Static Identity
 *
 * Mandate: Reproduce First (2026-08-31)
 *
 * Verifies:
 * 1. `before_agent_start` injects the static Root Orchestrator Directive for root sessions (does not return early).
 * 2. `tool_result` tracks consecutive direct file edits (edit/write) for root:
 *    - Edits 1 & 2 pass cleanly without advisory notices.
 *    - Edit 3+ appends a gentle advisory notice reminding root to delegate to swarm workers.
 * 3. Calling a swarm coordination tool (swarm_assign_task, swarm_create_task, etc.) resets the streak counter.
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const scratch = join(tmpdir(), `swarm-root-guard-${process.pid}-${Date.now()}`);
mkdirSync(scratch, { recursive: true });

let fail = 0;
function ok(n, c, extra) {
	if (c) {
		console.log("  ok  ", n);
	} else {
		fail++;
		console.error("  FAIL", n, extra ? extra : "");
	}
}

// 1. Setup mock pi runtime
const hookHandlers = {};
const registeredTools = {};
const mockPi = {
	on: (ev, handler) => {
		hookHandlers[ev] ||= [];
		hookHandlers[ev].push(handler);
	},
	registerTool: (def) => {
		registeredTools[def.name] = def;
	},
	registerCommand: () => {},
	exec: async () => ({ code: 0, stdout: "", stderr: "" }),
	sendMessage: () => {},
};

// Import hooks
const { registerSwarmHooks } = await import(join(here, "..", "src", "hooks.ts"));
registerSwarmHooks(mockPi);

const ctx = {
	cwd: scratch,
	mode: "tui",
	isIdle: () => true,
	hasUI: true,
	ui: { notify: () => {} },
};

console.log("\n[C1] before_agent_start: Root session receives static Root Orchestrator directive");
{
	process.env.PI_SWARM_AGENT_ID = "root";
	process.env.PI_SWARM_IS_ROOT = "1";

	const beforeAgentStartHandlers = hookHandlers.before_agent_start || [];
	ok("before_agent_start hook registered", beforeAgentStartHandlers.length > 0);

	const initialEvent = {
		systemPrompt: "You are a coding assistant with tool access.",
	};

	let result;
	for (const h of beforeAgentStartHandlers) {
		const res = await h(initialEvent, ctx);
		if (res) result = res;
	}

	ok("result is returned for root (not undefined/skipped)", result !== undefined && result?.systemPrompt !== undefined);
	const prompt = result?.systemPrompt || "";
	ok("systemPrompt contains [PI-SWARM ROOT ORCHESTRATOR]", prompt.includes("[PI-SWARM ROOT ORCHESTRATOR]"));
	ok("systemPrompt contains delegating instructions", prompt.includes("swarm_create_task") && prompt.includes("swarm_assign_task"));
}

console.log("\n[C2] tool_result: Root edit streak tracking & gentle advisory");
{
	process.env.PI_SWARM_AGENT_ID = "root";
	process.env.PI_SWARM_IS_ROOT = "1";

	const toolResultHandlers = hookHandlers.tool_result || [];
	ok("tool_result hook registered", toolResultHandlers.length > 0);

	// Simulating 1st edit
	const edit1 = {
		type: "tool_result",
		toolName: "edit",
		toolCallId: "call-1",
		input: { path: "src/index.ts" },
		content: [{ type: "text", text: "Successfully edited src/index.ts" }],
		isError: false,
	};
	for (const h of toolResultHandlers) {
		const res = await h(edit1, ctx);
		if (res?.content) edit1.content = res.content;
	}
	const text1 = edit1.content.map((c) => c.text || "").join("\n");
	ok("Edit 1 does NOT contain advisory notice", !text1.includes("[Root Orchestrator Advisory]"));

	// Simulating 2nd edit
	const edit2 = {
		type: "tool_result",
		toolName: "write",
		toolCallId: "call-2",
		input: { path: "src/utils.ts" },
		content: [{ type: "text", text: "Successfully wrote src/utils.ts" }],
		isError: false,
	};
	for (const h of toolResultHandlers) {
		const res = await h(edit2, ctx);
		if (res?.content) edit2.content = res.content;
	}
	const text2 = edit2.content.map((c) => c.text || "").join("\n");
	ok("Edit 2 does NOT contain advisory notice", !text2.includes("[Root Orchestrator Advisory]"));

	// Simulating 3rd edit -> Streak >= 3 threshold!
	const edit3 = {
		type: "tool_result",
		toolName: "edit",
		toolCallId: "call-3",
		input: { path: "src/main.ts" },
		content: [{ type: "text", text: "Successfully edited src/main.ts" }],
		isError: false,
	};
	for (const h of toolResultHandlers) {
		const res = await h(edit3, ctx);
		if (res?.content) edit3.content = res.content;
	}
	const text3 = edit3.content.map((c) => c.text || "").join("\n");
	ok("Edit 3 CONTAINS [Root Orchestrator Advisory]", text3.includes("[Root Orchestrator Advisory]"));
	ok("Advisory mentions delegating to swarm workers", text3.includes("swarm_create_task") || text3.includes("swarm_assign_task"));

	// Calling a swarm tool should reset streak
	const swarmAction = {
		type: "tool_result",
		toolName: "swarm_assign_task",
		toolCallId: "call-4",
		input: { taskId: "t1", nodeId: "n1", to: "worker-1" },
		content: [{ type: "text", text: "Task assigned" }],
		isError: false,
	};
	for (const h of toolResultHandlers) {
		await h(swarmAction, ctx);
	}

	// Simulating 4th edit after streak reset -> Should be clean again!
	const edit4 = {
		type: "tool_result",
		toolName: "edit",
		toolCallId: "call-5",
		input: { path: "src/fix.ts" },
		content: [{ type: "text", text: "Successfully edited src/fix.ts" }],
		isError: false,
	};
	for (const h of toolResultHandlers) {
		const res = await h(edit4, ctx);
		if (res?.content) edit4.content = res.content;
	}
	const text4 = edit4.content.map((c) => c.text || "").join("\n");
	ok("Edit 4 after swarm action does NOT contain advisory notice (streak was reset)", !text4.includes("[Root Orchestrator Advisory]"));
}

rmSync(scratch, { recursive: true, force: true });

console.log(`\nTest summary: ${fail === 0 ? "ALL PASS" : `${fail} FAILED`}`);
if (fail > 0) process.exit(1);
