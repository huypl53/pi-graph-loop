#!/usr/bin/env node
/**
 * Issue 58 — trace-backed attestation tests.
 */
import { mkdtemp, mkdir, readFile, rm, writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const scratch = await mkdtemp(join(tmpdir(), `swarm-attestation-${process.pid}-${Date.now()}`));
const originalCwd = process.cwd();
process.chdir(scratch);
await mkdir(join(scratch, ".pi/swarm"), { recursive: true });
await writeFile(join(scratch, ".pi/settings.json"), JSON.stringify({ swarm: { defaultModel: "glm-5.1", defaultProvider: "zai-coding-cn" } }));

let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) { pass++; console.log("  ok  ", name); } else { fail++; console.error("  FAIL", name, detail ? `(${detail})` : ""); } };
const expectReject = async (fn, predicate, name) => {
	try { await fn(); ok(name, false, "expected rejection"); return null; }
	catch (err) { ok(name, predicate(err), err?.errorCode || err?.message || String(err)); return err; }
};
const readJson = async (file) => JSON.parse(await readFile(file, "utf8"));
const readTask = async (taskId) => readJson(join(scratch, `.pi/swarm/tasks/${taskId}/task.json`));
const readEvents = async () => {
	const raw = await readFile(join(scratch, ".pi/swarm/traces/events.jsonl"), "utf8").catch(() => "");
	return raw.split("\n").filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
};

async function loadExtension({ agentId = "root", isRoot = true } = {}) {
	if (agentId) process.env.PI_SWARM_AGENT_ID = agentId; else delete process.env.PI_SWARM_AGENT_ID;
	if (isRoot) process.env.PI_SWARM_IS_ROOT = "1"; else delete process.env.PI_SWARM_IS_ROOT;
	const tools = {};
	const handlers = {};
	const activeTools = new Set();
	const pi = {
		registerTool: (def) => { tools[def.name] = def; activeTools.add(def.name); },
		registerCommand: () => {},
		on: (ev, fn) => { (handlers[ev] ||= []).push(fn); },
		exec: async (cmd, args) => {
			if (cmd === "tmux" && args?.[0] === "display-message") return { code: 0, stdout: "%1\n", stderr: "" };
			if (cmd === "git" && args?.[0] === "rev-parse") return { code: 0, stdout: "baseline-commit\n", stderr: "" };
			if (cmd === "git" && args?.[0] === "diff") return { code: 0, stdout: " extensions/swarm/src/tools/tasks.ts | 10 +++++-----\n 1 file changed, 5 insertions(+), 5 deletions(-)\n", stderr: "" };
			return { code: 0, stdout: "", stderr: "" };
		},
		setModel: async () => true,
		sendMessage: () => {},
		getAllTools: () => Object.values(tools).map((t) => ({ name: t.name })),
		getActiveTools: () => Array.from(activeTools),
		setActiveTools: (names) => { activeTools.clear(); for (const n of names) activeTools.add(n); },
	};
	const mod = await import(join(here, "..", "index.ts"));
	mod.default(pi);
	for (const fn of handlers.session_start || []) {
		await fn({}, { cwd: scratch, mode: "tui", hasUI: false, ui: { setStatus: () => {}, notify: () => {} } });
	}
	return { tools, handlers };
}

const call = (tools, name, params) => tools[name].execute("call", params, undefined, undefined, { cwd: scratch });
const as = async (agentId, isRoot, fn) => {
	const prevId = process.env.PI_SWARM_AGENT_ID;
	const prevOrch = process.env.PI_SWARM_IS_ROOT;
	process.env.PI_SWARM_AGENT_ID = agentId;
	if (isRoot) process.env.PI_SWARM_IS_ROOT = "1"; else delete process.env.PI_SWARM_IS_ROOT;
	try { return await fn(); }
	finally {
		if (prevId === undefined) delete process.env.PI_SWARM_AGENT_ID; else process.env.PI_SWARM_AGENT_ID = prevId;
		if (prevOrch === undefined) delete process.env.PI_SWARM_IS_ROOT; else process.env.PI_SWARM_IS_ROOT = prevOrch;
	}
};
const attach = async (path, content) => {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, content, "utf8");
};
const taskJsonPath = (taskId) => join(scratch, `.pi/swarm/tasks/${taskId}/task.json`);

// Scenario 1: bogus citation rejected with actionable missing-event error
{
	console.log("\n--- Scenario 1: missing event id rejected ---");
	await rm(join(scratch, ".pi"), { recursive: true, force: true });
	await mkdir(join(scratch, ".pi/swarm"), { recursive: true });
	const { tools } = await loadExtension();
	await call(tools, "swarm_register_agent", { id: "worker-a", role: "implementer", roleKind: "implementer", tmuxTarget: "unknown", inject: false });
	const ct = await call(tools, "swarm_create_task", { taskId: "task-attest-1", title: "attest 1", goal: "g", priority: "normal", cwd: scratch, nodes: { only: { role: "implementer", terminal: true } }, edges: [] });
	const taskId = ct.content[0].text.match(/task-[A-Za-z0-9-]+/)[0];
	await call(tools, "swarm_assign_task", { taskId, nodeId: "only", agentId: "worker-a", cwd: scratch });
	const attemptId = (await readTask(taskId)).nodes.only.activeAttemptId;
	const err = await expectReject(
		() => as("worker-a", false, () => call(tools, "swarm_update_task", {
			taskId,
			nodeId: "only",
			status: "done",
			outcome: "implemented",
			attemptId,
			note: "Passed: attestation.test.mjs",
			attestations: [{ claim: "Passed: attestation.test.mjs", tool: "bash", eventId: "e-nope", ts: "2026-08-29T00:00:00.000Z" }],
			cwd: scratch,
		})),
		(e) => e?.errorCode === "ATTESTATION_REJECTED" && String(e?.message || e).includes("EVENT_NOT_FOUND"),
		"missing event id rejected",
	);
	ok("error names claim", String(err?.message || err).includes("Passed: attestation.test.mjs"));
}

// Scenario 2: cited failure event blocks Passed claim
{
	console.log("\n--- Scenario 2: failure evidence blocks Passed claim ---");
	await rm(join(scratch, ".pi"), { recursive: true, force: true });
	await mkdir(join(scratch, ".pi/swarm"), { recursive: true });
	const { tools } = await loadExtension();
	await call(tools, "swarm_register_agent", { id: "worker-b", role: "implementer", roleKind: "implementer", tmuxTarget: "unknown", inject: false });
	const ct = await call(tools, "swarm_create_task", { taskId: "task-attest-2", title: "attest 2", goal: "g", priority: "normal", cwd: scratch, nodes: { only: { role: "implementer", terminal: true } }, edges: [] });
	const taskId = ct.content[0].text.match(/task-[A-Za-z0-9-]+/)[0];
	await call(tools, "swarm_assign_task", { taskId, nodeId: "only", agentId: "worker-b", cwd: scratch });
	const attemptId = (await readTask(taskId)).nodes.only.activeAttemptId;
	const eventsPath = join(scratch, ".pi/swarm/traces/events.jsonl");
	await attach(eventsPath, `${JSON.stringify({ ts: "2026-08-29T10:00:00.000Z", event: "tool.executed", eid: "e-fail", tool: "bash", isError: true, cls: "error", exitCode: 1 })}\n`);
	await expectReject(
		() => as("worker-b", false, () => call(tools, "swarm_update_task", {
			taskId,
			nodeId: "only",
			status: "done",
			outcome: "implemented",
			attemptId,
			note: "Passed: attestation.test.mjs",
			attestations: [{ claim: "Passed: attestation.test.mjs", tool: "bash", eventId: "e-fail", ts: "2026-08-29T10:00:00.000Z" }],
			cwd: scratch,
		})),
		(e) => e?.errorCode === "ATTESTATION_REJECTED" && String(e?.message || e).includes("EXIT_MISMATCH"),
		"failure evidence rejected",
	);
}

// Scenario 3: claim in artifact body without attestation is blocked
{
	console.log("\n--- Scenario 3: missing attestation is rejected ---");
	await rm(join(scratch, ".pi"), { recursive: true, force: true });
	await mkdir(join(scratch, ".pi/swarm"), { recursive: true });
	const { tools } = await loadExtension();
	await call(tools, "swarm_register_agent", { id: "worker-c", role: "implementer", roleKind: "implementer", tmuxTarget: "unknown", inject: false });
	const ct = await call(tools, "swarm_create_task", { taskId: "task-attest-3", title: "attest 3", goal: "g", priority: "normal", cwd: scratch, nodes: { only: { role: "implementer", terminal: true } }, edges: [] });
	const taskId = ct.content[0].text.match(/task-[A-Za-z0-9-]+/)[0];
	await call(tools, "swarm_assign_task", { taskId, nodeId: "only", agentId: "worker-c", cwd: scratch });
	const attemptId = (await readTask(taskId)).nodes.only.activeAttemptId;
	await writeFile(join(scratch, ".pi/swarm/tasks", taskId, "artifacts", "implementation-report.md"), "Passed: attestation.test.mjs\n", "utf8");
	await expectReject(
		() => as("worker-c", false, () => call(tools, "swarm_update_task", {
			taskId,
			nodeId: "only",
			status: "done",
			outcome: "implemented",
			attemptId,
			artifact: "artifacts/implementation-report.md",
			cwd: scratch,
		})),
		(e) => e?.errorCode === "ATTESTATION_REJECTED" && String(e?.message || e).includes("ATTESTATION_MISSING"),
		"missing attestation rejected",
	);
}

// Scenario 4: ts mismatch rejected
{
	console.log("\n--- Scenario 4: ts mismatch rejected ---");
	await rm(join(scratch, ".pi"), { recursive: true, force: true });
	await mkdir(join(scratch, ".pi/swarm"), { recursive: true });
	const { tools } = await loadExtension();
	await call(tools, "swarm_register_agent", { id: "worker-d", role: "implementer", roleKind: "implementer", tmuxTarget: "unknown", inject: false });
	const ct = await call(tools, "swarm_create_task", { taskId: "task-attest-4", title: "attest 4", goal: "g", priority: "normal", cwd: scratch, nodes: { only: { role: "implementer", terminal: true } }, edges: [] });
	const taskId = ct.content[0].text.match(/task-[A-Za-z0-9-]+/)[0];
	await call(tools, "swarm_assign_task", { taskId, nodeId: "only", agentId: "worker-d", cwd: scratch });
	const attemptId = (await readTask(taskId)).nodes.only.activeAttemptId;
	await attach(join(scratch, ".pi/swarm/traces/events.jsonl"), `${JSON.stringify({ ts: "2026-08-29T11:00:00.000Z", event: "tool.executed", eid: "e-ts", tool: "bash", isError: false, cls: "success", exitCode: 0 })}\n`);
	await expectReject(
		() => as("worker-d", false, () => call(tools, "swarm_update_task", {
			taskId,
			nodeId: "only",
			status: "done",
			outcome: "implemented",
			attemptId,
			note: "Passed: attestation.test.mjs",
			attestations: [{ claim: "Passed: attestation.test.mjs", tool: "bash", eventId: "e-ts", ts: "2026-08-29T11:00:01.000Z" }],
			cwd: scratch,
		})),
		(e) => e?.errorCode === "ATTESTATION_REJECTED" && String(e?.message || e).includes("TS_MISMATCH"),
		"ts mismatch rejected",
	);
}

// Scenario 5: honest attestation passes and includes diffstat
{
	console.log("\n--- Scenario 5: honest attestation passes ---");
	await rm(join(scratch, ".pi"), { recursive: true, force: true });
	await mkdir(join(scratch, ".pi/swarm"), { recursive: true });
	const { tools } = await loadExtension();
	await call(tools, "swarm_register_agent", { id: "worker-e", role: "implementer", roleKind: "implementer", tmuxTarget: "unknown", inject: false });
	const ct = await call(tools, "swarm_create_task", { taskId: "task-attest-5", title: "attest 5", goal: "g", priority: "normal", cwd: scratch, nodes: { only: { role: "implementer", terminal: true } }, edges: [] });
	const taskId = ct.content[0].text.match(/task-[A-Za-z0-9-]+/)[0];
	await call(tools, "swarm_assign_task", { taskId, nodeId: "only", agentId: "worker-e", cwd: scratch });
	const attemptId = (await readTask(taskId)).nodes.only.activeAttemptId;
	await attach(join(scratch, ".pi/swarm/traces/events.jsonl"), `${JSON.stringify({ ts: "2026-08-29T12:00:00.000Z", event: "tool.executed", eid: "e-ok", tool: "bash", isError: false, cls: "success", exitCode: 0 })}\n`);
	const res = await as("worker-e", false, () => call(tools, "swarm_update_task", {
		taskId,
		nodeId: "only",
		status: "done",
		outcome: "implemented",
		attemptId,
		note: "Passed: attestation.test.mjs",
		attestations: [{ claim: "Passed: attestation.test.mjs", tool: "bash", eventId: "e-ok", ts: "2026-08-29T12:00:00.000Z" }],
		cwd: scratch,
	}));
	ok("honest update succeeded", res?.content?.[0]?.text?.includes("Updated node"));
	ok("diffstat included in output", res?.content?.[0]?.text?.includes("Attestation diffstat:"));
	const taskEvents = await readFile(join(scratch, `.pi/swarm/tasks/${taskId}/events.jsonl`), "utf8").then((raw) => raw.split("\n").filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean));
	ok("attestation ok trace emitted", taskEvents.some((e) => e.event === "task.attestation.ok" && e.taskId === taskId));
	ok("attestation diffstat trace emitted", taskEvents.some((e) => e.event === "task.attestation.diffstat" && e.taskId === taskId));
}

// Scenario 6: no pass/fail claims preserves behavior
{
	console.log("\n--- Scenario 6: no claims untouched ---");
	await rm(join(scratch, ".pi"), { recursive: true, force: true });
	await mkdir(join(scratch, ".pi/swarm"), { recursive: true });
	const { tools } = await loadExtension();
	await call(tools, "swarm_register_agent", { id: "worker-f", role: "implementer", roleKind: "implementer", tmuxTarget: "unknown", inject: false });
	const ct = await call(tools, "swarm_create_task", { taskId: "task-attest-6", title: "attest 6", goal: "g", priority: "normal", cwd: scratch, nodes: { only: { role: "implementer", terminal: true } }, edges: [] });
	const taskId = ct.content[0].text.match(/task-[A-Za-z0-9-]+/)[0];
	await call(tools, "swarm_assign_task", { taskId, nodeId: "only", agentId: "worker-f", cwd: scratch });
	const attemptId = (await readTask(taskId)).nodes.only.activeAttemptId;
	const res = await as("worker-f", false, () => call(tools, "swarm_update_task", { taskId, nodeId: "only", status: "done", outcome: "implemented", attemptId, note: "No claims here", cwd: scratch }));
	ok("untouched flow succeeds", res?.content?.[0]?.text?.includes("Updated node"));
}

// Scenario 7: legacy tool+ts citation resolves
{
	console.log("\n--- Scenario 7: legacy citation passes ---");
	await rm(join(scratch, ".pi"), { recursive: true, force: true });
	await mkdir(join(scratch, ".pi/swarm"), { recursive: true });
	const { tools } = await loadExtension();
	await call(tools, "swarm_register_agent", { id: "worker-g", role: "implementer", roleKind: "implementer", tmuxTarget: "unknown", inject: false });
	const ct = await call(tools, "swarm_create_task", { taskId: "task-attest-7", title: "attest 7", goal: "g", priority: "normal", cwd: scratch, nodes: { only: { role: "implementer", terminal: true } }, edges: [] });
	const taskId = ct.content[0].text.match(/task-[A-Za-z0-9-]+/)[0];
	await call(tools, "swarm_assign_task", { taskId, nodeId: "only", agentId: "worker-g", cwd: scratch });
	const attemptId = (await readTask(taskId)).nodes.only.activeAttemptId;
	await attach(join(scratch, ".pi/swarm/traces/events.jsonl"), `${JSON.stringify({ ts: "2026-08-29T13:00:00.000Z", event: "tool.invoked", tool: "bash", cls: "success", durationMs: 12 })}\n`);
	const res = await as("worker-g", false, () => call(tools, "swarm_update_task", {
		taskId,
		nodeId: "only",
		status: "done",
		outcome: "implemented",
		attemptId,
		note: "Passed: legacy bash citation",
		attestations: [{ claim: "Passed: legacy bash citation", tool: "bash", eventId: "missing-eid", ts: "2026-08-29T13:00:00.000Z" }],
		cwd: scratch,
	}));
	ok("legacy citation update succeeded", res?.content?.[0]?.text?.includes("Updated node"));
}

// Scenario 8: hook writes tool.executed evidence line
{
	console.log("\n--- Scenario 8: tool_execution_end hook appends evidence ---");
	await rm(join(scratch, ".pi"), { recursive: true, force: true });
	await mkdir(join(scratch, ".pi/swarm"), { recursive: true });
	const { handlers } = await loadExtension({ agentId: "worker-hook", isRoot: false });
	const hooks = handlers.tool_execution_end || [];
	ok("hook registered", hooks.length >= 1);
	for (const hook of hooks) await hook({ toolName: "bash", eventId: "e-hook", ts: "2026-08-29T14:00:00.000Z", cls: "success", exitCode: 0 }, { cwd: scratch });
	const ev = await readEvents();
	ok("tool.executed evidence line present", ev.some((e) => e.event === "tool.executed" && e.eid === "e-hook" && e.tool === "bash"));
}

// Scenario 9: missing baseline still passes with note
{
	console.log("\n--- Scenario 9: missing baseline is tolerated ---");
	await rm(join(scratch, ".pi"), { recursive: true, force: true });
	await mkdir(join(scratch, ".pi/swarm"), { recursive: true });
	const { tools } = await loadExtension();
	await call(tools, "swarm_register_agent", { id: "worker-h", role: "implementer", roleKind: "implementer", tmuxTarget: "unknown", inject: false });
	const ct = await call(tools, "swarm_create_task", { taskId: "task-attest-9", title: "attest 9", goal: "g", priority: "normal", cwd: scratch, nodes: { only: { role: "implementer", terminal: true } }, edges: [] });
	const taskId = ct.content[0].text.match(/task-[A-Za-z0-9-]+/)[0];
	await call(tools, "swarm_assign_task", { taskId, nodeId: "only", agentId: "worker-h", cwd: scratch });
	await unlink(join(scratch, `.pi/swarm/tasks/${taskId}/baseline.txt`)).catch(() => {});
	const attemptId = (await readTask(taskId)).nodes.only.activeAttemptId;
	await attach(join(scratch, ".pi/swarm/traces/events.jsonl"), `${JSON.stringify({ ts: "2026-08-29T15:00:00.000Z", event: "tool.executed", eid: "e-base", tool: "bash", isError: false, cls: "success", exitCode: 0 })}\n`);
	const res = await as("worker-h", false, () => call(tools, "swarm_update_task", {
		taskId,
		nodeId: "only",
		status: "done",
		outcome: "implemented",
		attemptId,
		note: "Passed: baseline missing still okay",
		attestations: [{ claim: "Passed: baseline missing still okay", tool: "bash", eventId: "e-base", ts: "2026-08-29T15:00:00.000Z" }],
		cwd: scratch,
	}));
	ok("baseline missing still succeeds", res?.content?.[0]?.text?.includes("Updated node"));
	ok("diff unavailable noted", res?.content?.[0]?.text?.includes("git diff unavailable"));
}

// Scenario 10: non-target outcome ignores attestation claims
{
	console.log("\n--- Scenario 10: planned outcome not gated ---");
	await rm(join(scratch, ".pi"), { recursive: true, force: true });
	await mkdir(join(scratch, ".pi/swarm"), { recursive: true });
	const { tools } = await loadExtension();
	await call(tools, "swarm_register_agent", { id: "planner-x", role: "planner", roleKind: "planner", tmuxTarget: "unknown", inject: false });
	const ct = await call(tools, "swarm_create_task", { taskId: "task-attest-10", title: "attest 10", goal: "g", priority: "normal", cwd: scratch, nodes: { only: { role: "planner", terminal: true } }, edges: [] });
	const taskId = ct.content[0].text.match(/task-[A-Za-z0-9-]+/)[0];
	await call(tools, "swarm_assign_task", { taskId, nodeId: "only", agentId: "planner-x", cwd: scratch });
	const attemptId = (await readTask(taskId)).nodes.only.activeAttemptId;
	const res = await as("planner-x", false, () => call(tools, "swarm_update_task", {
		taskId,
		nodeId: "only",
		status: "done",
		outcome: "planned",
		attemptId,
		note: "Passed: ignored claim on non-target outcome",
		attestations: [{ claim: "Passed: ignored claim on non-target outcome", tool: "bash", eventId: "e-nope", ts: "2026-08-29T16:00:00.000Z" }],
		cwd: scratch,
	}));
	ok("non-target outcome update succeeds", res?.content?.[0]?.text?.includes("Updated node"));
}

process.chdir(originalCwd);
console.log(`\nSummary: ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
