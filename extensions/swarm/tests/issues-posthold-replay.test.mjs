#!/usr/bin/env node
/**
 * swarm-issues-b3-posthold — post-hold tick orphan RED→GREEN.
 *
 * Incident seed: my-daily-pi run-mup15r16-epimos @ 2026-10-01T04:50:25.835Z
 * (trace issues.safe_idle_hold, then silence): run.status=running, activeIssueId=null,
 * a done queue entry exists, all workers stopped — the pump tick never replays
 * observeLinkedTaskLocked's post-hold branch because its entry guard requires activeIssueId.
 *
 * RED-first: driven through the REAL runPumpMaintenancePhasesLocked (production path only),
 * asserting today: no advance, no notice, no nudge.
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "..", "src");
process.env.PI_SWARM_AGENT_ID = "root";
process.env.PI_SWARM_IS_ROOT = "1";

const { paths, readState, writeState, ensureDirs } = await import(join(src, "state.ts"));
const { getIssueRun } = await import(join(src, "issues", "state.ts"));
const { handleIssuesCommand } = await import(join(src, "commands", "issues.ts"));
const { runPumpMaintenancePhasesLocked } = await import(join(src, "surface", "pump-phases.ts"));
const { deliverMessageLocked } = await import(join(src, "mailbox.ts"));

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

function seedWorld() {
	const cwd = mkdtempSync(join(tmpdir(), "issues-posthold-"));
	for (const d of ["traces", "mailboxes", "tasks"]) mkdirSync(join(cwd, ".pi", "swarm", d), { recursive: true });
	mkdirSync(join(cwd, "docs"), { recursive: true });
	writeFileSync(join(cwd, "docs", "one.md"), "doc one\n");
	writeFileSync(join(cwd, "docs", "two.md"), "doc two\n");
	writeFileSync(
		join(cwd, ".pi", "swarm", "issues.yml"),
		"issues:\n  - id: fix-one\n    title: One\n    content: do one\n    docs:\n      - docs/one.md\n  - id: fix-two\n    title: Two\n    content: do two\n    docs:\n      - docs/two.md\n",
	);
	return cwd;
}

/** Flip the linked task.json of the active issue to all-done on disk (production shape). */
function finishLinkedTask(cwd, taskId) {
	const tp = join(cwd, ".pi", "swarm", "tasks", taskId, "task.json");
	const task = JSON.parse(readFileSync(tp, "utf8"));
	task.status = "done";
	for (const n of Object.values(task.nodes ?? {})) n.status = "done";
	task.updatedAt = new Date().toISOString();
	writeFileSync(tp, JSON.stringify(task, null, 2) + "\n");
}

async function mailboxRecs(cwd) {
	const { readdir } = await import("node:fs/promises");
	const dir = join(cwd, ".pi", "swarm", "mailboxes");
	try {
		const files = (await readdir(dir)).filter((f) => f.endsWith(".jsonl"));
		return files.flatMap((f) =>
			readFileSync(join(dir, f), "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l)),
		);
	} catch (err) {
		if (err?.code === "ENOENT") return [];
		throw err;
	}
}

function seedHolder(st, id = "worker-1") {
	st.agents = st.agents ?? {};
	st.agents[id] = {
		id,
		name: id,
		status: "working",
		registeredAt: new Date().toISOString(),
		role: "worker",
		activeTaskIds: [`held-${id}`],
	};
	st.tasks = st.tasks ?? {};
	st.tasks[`held-${id}`] = { taskId: `held-${id}`, status: "in_progress", title: "held" };
}

function clearHolder(st, id = "worker-1") {
	if (st.agents?.[id]) {
		st.agents[id].activeTaskIds = [];
		st.agents[id].status = "idle";
	}
}

/**
 * Field shape from the incident: a real assignment holder BLOCKS safe-idle while the linked
 * task goes terminal (computeSafeIdle reads agent records, not ctx.isIdle), then the hold
 * releases (holder goes idle) leaving run running + activeIssueId=null + done entry.
 */
async function shapePostholdOrphan({ keepHolder = false } = {}) {
	const cwd = seedWorld();
	const p = paths(cwd);
	await ensureDirs(p);
	await handleIssuesCommand("issues", ["start"], { cwd, ui: { notify: () => {} } }, p, {});
	let st = await readState(p, cwd);
	seedHolder(st);
	await writeState(p, st);
	st = await readState(p, cwd);
	let run = getIssueRun(st);
	finishLinkedTask(cwd, run.queue[0].taskId);
	// hold leg: safe-idle genuinely blocked by the holder while the task goes terminal
	await runPumpMaintenancePhasesLocked({}, { cwd, isIdle: () => true }, p, st, Date.now(), "posthold-hold");
	await writeState(p, st);
	st = await readState(p, cwd);
	run = getIssueRun(st);
	assert.equal(run.queue[0].status, "done", "hold leg: entry went terminal while held");
	assert.notEqual(run.activeIssueId, null, "hold leg: safe_idle_hold keeps the run un-advanced");
	if (!keepHolder) clearHolder(st);
	// field shape: hold released with activeIssueId cleared (the 04:50:25 orphan)
	run.activeIssueId = null;
	await writeState(p, st);
	st = await readState(p, cwd);
	return { cwd, p, st };
}

const tick = (p, st, cwd, idle = true) =>
	runPumpMaintenancePhasesLocked({}, { cwd, isIdle: () => idle }, p, st, Date.now(), "posthold");

// === RED: the orphan field shape is a permanent tick no-op today ===
// RED control (revert-only): unlinked done entry (taskId stripped) must NOT advance — the
// tick routes through observeLinkedTaskLocked, whose provenance/idle guards refuse anything
// that is not the real linked post-hold shape. Guards the new branch against over-advancing.
await t("RED control: unlinked done entry (no taskId) does NOT advance", async () => {
	const { cwd, p } = await shapePostholdOrphan();
	const st = await readState(p, cwd);
	st.issueRun.queue[0].taskId = undefined;
	await writeState(p, st);
	const before = await mailboxRecs(cwd);
	const st2 = await readState(p, cwd);
	await tick(p, st2, cwd);
	await writeState(p, st2);
	const run = getIssueRun(await readState(p, cwd));
	assert.equal(run.queue[1].status, "queued", "unlinked: no advance");
	const after = await mailboxRecs(cwd);
	assert.deepEqual(after.map((r) => r.idempotencyKey), before.map((r) => r.idempotencyKey), "unlinked: no notice");
	rmSync(cwd, { recursive: true, force: true });
});

// === GREEN legs ===
await t("GREEN: tick replays post-hold — next issue activates exactly once (advance + hint once)", async () => {
	const { cwd, p, st } = await shapePostholdOrphan();
	await tick(p, st, cwd);
	await writeState(p, st);
	let run = getIssueRun(await readState(p, cwd));
	assert.equal(run.status, "running");
	assert.equal(run.activeIssueId, "fix-two", "post-hold replay activated fix-two");
	assert.equal(run.queue[0].status, "done");
	assert.equal(run.queue[1].status, "active");
	// exactly-once under double-tick
	const hintCount1 = (await mailboxRecs(cwd)).filter((r) => String(r.idempotencyKey || "").startsWith("issues-hint:activate:")).length;
	await tick(p, st, cwd);
	await writeState(p, st);
	run = getIssueRun(await readState(p, cwd));
	assert.equal(run.activeIssueId, "fix-two", "double-tick: no duplicate advance");
	const hintCount2 = (await mailboxRecs(cwd)).filter((r) => String(r.idempotencyKey || "").startsWith("issues-hint:activate:")).length;
	assert.equal(hintCount2, hintCount1, "double-tick: no duplicate activation hint");
	rmSync(cwd, { recursive: true, force: true });
});

await t("GREEN: paused run with orphan shape is a byte-no-op (pause still needs human resume)", async () => {
	const { cwd, p } = await shapePostholdOrphan();
	const st = await readState(p, cwd);
	st.issueRun.status = "paused";
	await writeState(p, st);
	const before = readFileSync(paths(cwd).state, "utf8");
	const st2 = await readState(p, cwd);
	await tick(p, st2, cwd);
	const after = readFileSync(paths(cwd).state, "utf8");
	assert.equal(after, before, "paused run: tick must not mutate durable state");
	const run = getIssueRun(await readState(p, cwd));
	assert.equal(run.queue[1].status, "queued", "paused: no advance");
	rmSync(cwd, { recursive: true, force: true });
});

await t("GREEN: non-issue swarm is a no-op (no issueRun)", async () => {
	const cwd = seedWorld();
	const p = paths(cwd);
	await ensureDirs(p);
	const st = await readState(p, cwd);
	await tick(p, st, cwd);
	assert.equal(st.issueRun ?? null, null, "tick must not fabricate an issueRun");
	rmSync(cwd, { recursive: true, force: true });
});

await t("GREEN: held-still-held — real assignment holder blocks the replay (safe-idle intact)", async () => {
	const { cwd, p } = await shapePostholdOrphan({ keepHolder: true });
	const st = await readState(p, cwd);
	// seed a real assignment holder record (non-terminal task held by a live agent)
	const st2 = await readState(p, cwd);
	await tick(p, st2, cwd);
	await writeState(p, st2);
	const run = getIssueRun(await readState(p, cwd));
	assert.equal(run.queue[1].status, "queued", "held: no premature advance");
	assert.ok(!run.activeIssueId, "held: still orphaned until idle clears");
	rmSync(cwd, { recursive: true, force: true });
});

console.log(process.exitCode ? "\nissues-posthold-replay: FAIL" : `\nissues-posthold-replay: PASS (${passed})`);
