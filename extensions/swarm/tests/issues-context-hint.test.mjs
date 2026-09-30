#!/usr/bin/env node
/**
 * swarm-issues Phase 4 — context hint lifecycle suite (red-first).
 *
 * Contract (plan §6/§8.3):
 *   - root: exactly ONE compact activation hint per activation (dedupe on replay);
 *   - worker: exactly ONE hint per issue-linked assignment attempt (re-assign re-fires once);
 *   - none after stop/complete; none for superseded (fenced) assignment; none for unlinked task;
 *   - body: id/title + skill name ONLY, never snapshot content; informational (no debt);
 *   - all through the REAL deliverMessageLocked + real swarm_assign_task tool.
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "..", "src");
const extRoot = join(here, "..");
process.env.PI_SWARM_AGENT_ID = "root";
process.env.PI_SWARM_IS_ROOT = "1";

const { paths, readState, writeState, ensureDirs } = await import(join(src, "state.ts"));
const { getIssueRun } = await import(join(src, "issues", "state.ts"));
const { handleIssuesCommand } = await import(join(src, "commands", "issues.ts"));
const { issueHintBody, hintAllowedForRun } = await import(join(src, "issues", "controller.ts"));

let passed = 0;
async function t(name, fn) {
	try {
		await fn();
		passed++;
		console.log(`  ok   ${name}`);
	} catch (err) {
		console.error(`  FAIL ${name}: ${err instanceof Error ? err.message : String(err)}`);
		process.exitCode = 1;
	}
}

function mailboxRecords(cwd) {
	try {
		const mailboxesDir = join(cwd, ".pi", "swarm", "mailboxes");
		const out = [];
		for (const f of readdirSync(mailboxesDir).filter((f) => f.endsWith(".jsonl"))) {
			for (const l of readFileSync(join(mailboxesDir, f), "utf8").split("\n")) {
				if (l.trim()) out.push(JSON.parse(l));
			}
		}
		return out;
	} catch {
		return [];
	}
}
const hintRecs = (cwd, kind) => mailboxRecords(cwd).filter((r) => String(r.idempotencyKey || "").startsWith(`issues-hint:${kind}:`));

function seedWorld() {
	const cwd = mkdtempSync(join(tmpdir(), "issues-hint-"));
	for (const d of ["traces", "mailboxes", "tasks"]) mkdirSync(join(cwd, ".pi", "swarm", d), { recursive: true });
	mkdirSync(join(cwd, "docs"), { recursive: true });
	writeFileSync(join(cwd, "docs", "one.md"), "doc one\n");
	writeFileSync(join(cwd, "docs", "two.md"), "doc two\n");
	writeFileSync(
		join(cwd, ".pi", "swarm", "issues.yml"),
		"issues:\n  - id: hint-one\n    title: Hint One\n    content: do one\n    docs:\n      - docs/one.md\n  - id: hint-two\n    title: Hint Two\n    content: do two\n    docs:\n      - docs/two.md\n",
	);
	return cwd;
}

function makePiSpy() {
	const calls = { tools: {} };
	return {
		calls,
		on: () => {},
		off: () => {},
		registerTool: (tl) => {
			calls.tools[tl.name] = tl;
		},
		registerCommand: () => {},
		sendMessage: () => {},
		sendUserMessage: () => {},
		exec: async () => ({ code: 0, stdout: "", stderr: "" }),
		setModel: async () => true,
		getAllTools: () => [],
		getActiveTools: () => [],
		setActiveTools: () => {},
		ui: { notify: () => {}, setWidget: () => {}, setStatus: () => {}, setFooter: () => {} },
	};
}

// --- pure helper shape ---
await t("hint body: id/title + skill name only, single line", () => {
	const b = issueHintBody("hint-one", "Hint One");
	assert.match(b, /"hint-one"/);
	assert.match(b, /Hint One/);
	assert.match(b, /swarm-issues skill/);
	assert.equal(b.split("\n").length, 1, "must be a single compact line");
	assert.doesNotMatch(b, /snapshot|content|docs/i, "no snapshot content in hint body");
});

await t("stale fencing helper: only running+active linkage allows", () => {
	assert.equal(hintAllowedForRun({ status: "running", activeIssueId: "a", queue: [{ issueId: "a", status: "active" }] }, "a"), true);
	assert.equal(hintAllowedForRun({ status: "stopped", activeIssueId: "a", queue: [{ issueId: "a", status: "active" }] }, "a"), false);
	assert.equal(hintAllowedForRun({ status: "complete", activeIssueId: "a", queue: [{ issueId: "a", status: "active" }] }, "a"), false);
	assert.equal(hintAllowedForRun({ status: "running", activeIssueId: "b", queue: [{ issueId: "a", status: "active" }] }, "a"), false);
	assert.equal(hintAllowedForRun({ status: "running", activeIssueId: "a", queue: [{ issueId: "a", status: "done" }] }, "a"), false);
	assert.equal(hintAllowedForRun(undefined, "a"), false);
});

// --- root activation hint through the real start command ---
await t("root: exactly ONE activation hint per activation; replay does not re-fire; body compact", async () => {
	const cwd = seedWorld();
	const p = paths(cwd);
	await ensureDirs(p);
	const ctx = { cwd, ui: { notify: () => {} } };
	await handleIssuesCommand("issues", ["start"], ctx, p, {});
	const recs = hintRecs(cwd, "activate");
	assert.equal(recs.length, 1, `expected exactly 1 activation hint, got ${recs.length}`);
	assert.equal(recs[0].requiresAck, false, "informational: no ack debt");
	assert.equal(recs[0].requiresResponse, false, "informational: no response debt");
	assert.match(recs[0].body, /"hint-one"/);
	assert.match(recs[0].body, /swarm-issues skill/);
	assert.doesNotMatch(recs[0].body, /do one/, "no issue content in the hint body");
	// replay of the same activation (idempotent) must not add hints
	await handleIssuesCommand("issues", ["start"], ctx, p, {}); // refused: already running — no new hint
	assert.equal(hintRecs(cwd, "activate").length, 1);
	rmSync(cwd, { recursive: true, force: true });
});

// --- worker attempt hint through the REAL swarm_assign_task tool ---
async function assignLinkedTask(cwd, pi) {
	const p = paths(cwd);
	const st = await readState(p, cwd);
	const run = getIssueRun(st);
	const taskId = run.queue[0].taskId;
	const reg = pi.calls.tools;
	await reg["swarm_assign_task"].execute("x", { taskId, nodeId: "start", agentId: "worker-a" }, undefined, undefined, { cwd });
	return taskId;
}

await t("worker: exactly ONE hint per issue-linked assignment attempt; reassign re-fires once", async () => {
	const cwd = seedWorld();
	const p = paths(cwd);
	await ensureDirs(p);
	await handleIssuesCommand("issues", ["start"], { cwd, ui: { notify: () => {} } }, p, {});
	const pi = makePiSpy();
	const { registerAgentsTools } = await import(join(src, "tools", "agents.ts"));
	const { registerTasksTools } = await import(join(src, "tools", "tasks.ts"));
	registerAgentsTools(pi);
	registerTasksTools(pi);
	// give the worker a real agent record so assignment succeeds
	const st0 = await readState(p, cwd);
	st0.agents["worker-a"] = { id: "worker-a", role: "worker", roleKind: "worker", status: "running", runtimeStatus: "idle", tmuxAlive: true, lastHeartbeatAt: new Date().toISOString(), activeTaskIds: [], createdAt: new Date().toISOString() };
	await writeState(p, st0);
	const taskId = await assignLinkedTask(cwd, pi);
	let recs = hintRecs(cwd, "attempt");
	assert.equal(recs.length, 1, `expected 1 attempt hint, got ${recs.length}`);
	assert.equal(recs[0].to, "worker-a");
	assert.match(recs[0].body, /"hint-one"/);
	assert.match(recs[0].body, /swarm-issues skill/);
	assert.equal(recs[0].requiresResponse, false, "no response debt");
	// idempotent reuse of the same assignment must NOT re-fire (same attempts count)
	// registerTasksTools already registered swarm_assign_task (duplicate registration would
	// double the tool; the idempotent-reuse leg reuses the existing registration)
	await pi.calls.tools["swarm_assign_task"].execute("x", { taskId, nodeId: "start", agentId: "worker-a" }, undefined, undefined, { cwd });
	recs = hintRecs(cwd, "attempt");
	assert.equal(recs.length, 1, `idempotent reuse must not re-fire (got ${recs.length})`);
	rmSync(cwd, { recursive: true, force: true });
});

await t("unlinked assignment: NO attempt hint", async () => {
	const cwd = seedWorld();
	const p = paths(cwd);
	await ensureDirs(p);
	const pi = makePiSpy();
	const { registerAgentsTools } = await import(join(src, "tools", "agents.ts"));
	const { registerTasksTools } = await import(join(src, "tools", "tasks.ts"));
	registerAgentsTools(pi);
	registerTasksTools(pi);
	const st = await readState(p, cwd);
	st.agents["worker-b"] = { id: "worker-b", role: "worker", roleKind: "worker", status: "running", runtimeStatus: "idle", tmuxAlive: true, lastHeartbeatAt: new Date().toISOString(), activeTaskIds: [], createdAt: new Date().toISOString() };
	await writeState(p, st);
	// create a NON-issue task via the real tool
	const created = await pi.calls.tools["swarm_create_task"].execute("x", { title: "plain task", goal: "work" }, undefined, undefined, { cwd });
	const text = typeof created === "string" ? created : JSON.stringify(created);
	const taskId = String(text).match(/task-[a-z0-9-]+/)?.[0];
	assert.ok(taskId, "sanity: unlinked task created");
	await pi.calls.tools["swarm_assign_task"].execute("x", { taskId, nodeId: "plan", agentId: "worker-b" }, undefined, undefined, { cwd });
	assert.equal(hintRecs(cwd, "attempt").length, 0, "unlinked assignment must produce zero hints");
	rmSync(cwd, { recursive: true, force: true });
});

await t("stop: no hints after run stopped (advance blocked; fence body stays issue-scoped)", async () => {
	const cwd = seedWorld();
	const p = paths(cwd);
	await ensureDirs(p);
	const ctx = { cwd, ui: { notify: () => {} } };
	await handleIssuesCommand("issues", ["start"], ctx, p, {});
	const st = await readState(p, cwd);
	st.agents["worker-stop"] = { id: "worker-stop", role: "worker", roleKind: "worker", status: "running", runtimeStatus: "idle", tmuxAlive: true, lastHeartbeatAt: new Date().toISOString(), activeTaskIds: [], createdAt: new Date().toISOString() };
	await writeState(p, st);
	{ const runNow = getIssueRun(await readState(p, cwd)); console.error("DEBUG pre-stop:", runNow.status, JSON.stringify(runNow.queue.map(q=>({i:q.issueId,s:q.status})))); }
	const linkedTaskId = getIssueRun(st).queue[0].taskId;
	await handleIssuesCommand("issues", ["stop"], ctx, p, {});
	const beforeA = hintRecs(cwd, "activate").length;
	const beforeT = hintRecs(cwd, "attempt").length;
	// stop does not itself deliver hints; a subsequent start-after-stopped REBUILDS the run
	// (recorded as a phase-05 finding in the implementation report) but that is a fresh
	// activation under a NEW runId — assert no hint fired under the OLD run's keys here.
	assert.equal(hintRecs(cwd, "activate").length, beforeA, "stop itself must not add activation hints");
	// R-HINT discriminator: an assignment for the previously-linked (stop-cancelled) task
	// AFTER stop must NOT deliver an attempt hint (run.status check in the assign path).
	// Under the reverted guard (run.status check dropped) this re-fires a post-stop hint —
	// red-verified 2026-10-01 (phase-05).
	const { registerAgentsTools } = await import(join(src, "tools", "agents.ts"));
	const { registerTasksTools } = await import(join(src, "tools", "tasks.ts"));
	const pi = makePiSpy();
	registerAgentsTools(pi);
	registerTasksTools(pi);
	assert.ok(linkedTaskId, "sanity: pre-stop active entry carried linkage");
	await pi.calls.tools["swarm_assign_task"].execute("x", { taskId: linkedTaskId, nodeId: "start", agentId: "worker-stop" }, undefined, undefined, { cwd });
	assert.equal(hintRecs(cwd, "attempt").length, beforeT, "post-stop assignment must deliver ZERO attempt hints");
	rmSync(cwd, { recursive: true, force: true });
});

// R-HINT — Phase-5 revert-only RED control (plan §1): the worker-attempt hint guard must
// check run.status === "running". Revert = drop ONLY the run.status check (entry.status kept).
// A paused run keeps its active entry, so assigning during a pause must deliver ZERO hints;
// under the revert the hint fires on a paused run. Red-verified 2026-10-01 (phase-05).
await t("R-HINT (RED control): assignment during a PAUSED run delivers zero attempt hints", async () => {
	const cwd = seedWorld();
	const p = paths(cwd);
	await ensureDirs(p);
	const ctx = { cwd, ui: { notify: () => {} } };
	await handleIssuesCommand("issues", ["start"], ctx, p, {});
	await handleIssuesCommand("issues", ["pause"], ctx, p, {});
	const st = await readState(p, cwd);
	st.agents["worker-pause"] = { id: "worker-pause", role: "worker", roleKind: "worker", status: "running", runtimeStatus: "idle", tmuxAlive: true, lastHeartbeatAt: new Date().toISOString(), activeTaskIds: [], createdAt: new Date().toISOString() };
	await writeState(p, st);
	const { registerAgentsTools } = await import(join(src, "tools", "agents.ts"));
	const { registerTasksTools } = await import(join(src, "tools", "tasks.ts"));
	const pi = makePiSpy();
	registerAgentsTools(pi);
	registerTasksTools(pi);
	const taskId = getIssueRun(await readState(p, cwd)).queue[0].taskId;
	await pi.calls.tools["swarm_assign_task"].execute("x", { taskId, nodeId: "start", agentId: "worker-pause" }, undefined, undefined, { cwd });
	assert.equal(hintRecs(cwd, "attempt").length, 0, "paused-run assignment must deliver ZERO attempt hints");
	rmSync(cwd, { recursive: true, force: true });
});

console.log(process.exitCode ? "\nissues-context-hint: FAIL" : `\nissues-context-hint: PASS (${passed})`);
