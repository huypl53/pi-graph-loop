#!/usr/bin/env node
/**
 * swarm-issues-advancement-mode — auto/manual issue advancement RED→GREEN.
 *
 * T1 manual no-advance · T2 exactly-once notice (both paths) · T3 resume-activates ·
 * T4 mode normalization · T5 invalid fail-fast · T6 auto byte-identical (standing battery) ·
 * T7 freeze unchanged · T8 completion in manual · T9 post-hold replay composition (real tick).
 *
 * Red-first: T1-T5+T9 observed RED before the resolver/seam/marker landed.
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
delete process.env.PI_SWARM_ISSUES_ADVANCEMENT; // lanes/suites must not inherit env surprises

const { paths, readState, writeState, ensureDirs } = await import(join(src, "state.ts"));
const { getIssueRun } = await import(join(src, "issues", "state.ts"));
const { handleIssuesCommand } = await import(join(src, "commands", "issues.ts"));
const { observeLinkedTaskLocked } = await import(join(src, "issues", "controller.ts"));
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

function seedWorld({ yml = null } = {}) {
	const cwd = mkdtempSync(join(tmpdir(), "issues-adv-"));
	for (const d of ["traces", "mailboxes", "tasks"]) mkdirSync(join(cwd, ".pi", "swarm", d), { recursive: true });
	mkdirSync(join(cwd, "docs"), { recursive: true });
	writeFileSync(join(cwd, "docs", "one.md"), "doc one\n");
	writeFileSync(join(cwd, "docs", "two.md"), "doc two\n");
	if (yml !== null) writeFileSync(join(cwd, ".pi", "swarm.yml"), yml);
	writeFileSync(
		join(cwd, ".pi", "swarm", "issues.yml"),
		"issues:\n  - id: fix-one\n    title: One\n    content: do one\n    docs:\n      - docs/one.md\n  - id: fix-two\n    title: Two\n    content: do two\n    docs:\n      - docs/two.md\n  - id: fix-three\n    title: Three\n    content: do three\n    docs:\n      - docs/one.md\n",
	);
	return cwd;
}

async function startRun(cwd) {
	const p = paths(cwd);
	await ensureDirs(p);
	await handleIssuesCommand("issues", ["start"], { cwd, ui: { notify: () => {} } }, p, {});
	return p;
}

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
	st.agents[id] = { id, name: id, status: "working", registeredAt: new Date().toISOString(), role: "worker", activeTaskIds: [`held-${id}`] };
	st.tasks = st.tasks ?? {};
	st.tasks[`held-${id}`] = { taskId: `held-${id}`, status: "in_progress", title: "held" };
}
function clearHolder(st, id = "worker-1") {
	if (st.agents?.[id]) {
		st.agents[id].activeTaskIds = [];
		st.agents[id].status = "idle";
	}
}

// === T5: resolver unit legs (config parsing incl. invalid values) ===
await t("T5: resolver — env > yml > default; invalid env/yml rejected with precise errors", async () => {
	const { resolveIssueAdvancement } = await import(join(src, "issues", "config.ts"));
	const cwd = seedWorld();
	// default
	assert.equal(resolveIssueAdvancement(cwd), "auto", "absent config → auto");
	// yml manual
	writeFileSync(join(cwd, ".pi", "swarm.yml"), 'issue-sequencer:\n  advancement: manual\n');
	assert.equal(resolveIssueAdvancement(cwd), "manual", "yml nested key → manual");
	// env beats yml
	process.env.PI_SWARM_ISSUES_ADVANCEMENT = "AUTO";
	assert.equal(resolveIssueAdvancement(cwd), "auto", "env beats yml");
	// case/space normalization
	process.env.PI_SWARM_ISSUES_ADVANCEMENT = "  Manual ";
	assert.equal(resolveIssueAdvancement(cwd), "manual", "env case/space normalized");
	// invalid env → precise error naming the env var
	process.env.PI_SWARM_ISSUES_ADVANCEMENT = "yolo";
	assert.throws(() => resolveIssueAdvancement(cwd), /PI_SWARM_ISSUES_ADVANCEMENT.*yolo/, "invalid env names the env var");
	delete process.env.PI_SWARM_ISSUES_ADVANCEMENT;
	// invalid yml → precise error naming the key path
	writeFileSync(join(cwd, ".pi", "swarm.yml"), 'issue-sequencer:\n  advancement: sometimes\n');
	assert.throws(() => resolveIssueAdvancement(cwd), /issue-sequencer\.advancement.*sometimes/, "invalid yml names the key path");
	rmSync(cwd, { recursive: true, force: true });
});

// === T1 + T2 (normal path): manual no-advance + exactly-once notice ===
await t("T1+T2: manual mode — terminal-done does NOT advance; waiting-manual set; ONE notice", async () => {
	const cwd = seedWorld();
	process.env.PI_SWARM_ISSUES_ADVANCEMENT = "manual";
	try {
		const p = await startRun(cwd);
		let st = await readState(p, cwd);
		let run = getIssueRun(st);
		finishLinkedTask(cwd, run.queue[0].taskId);
		// normal terminal-done observation (provenance-consistent linked task)
		const r = await observeLinkedTaskLocked(p, { cwd }, st, { taskId: run.queue[0].taskId, status: "done" }, { deliverMessageLocked });
		await writeState(p, st);
		run = getIssueRun(await readState(p, cwd));
		assert.equal(r.acted, true, "observation acted");
		assert.equal(run.queue[0].status, "done", "issue marked done");
		assert.equal(run.status, "running", "run still running (waiting-manual, NOT paused)");
		assert.equal(run.advancement, "waiting-manual", "waiting-manual marker set");
		assert.ok(!run.activeIssueId, "no active issue (no advance)");
		assert.equal(run.queue[1].status, "queued", "next issue NOT auto-activated");
		// exactly-once
		const waitRecs = (await mailboxRecs(cwd)).filter((r2) => String(r2.idempotencyKey || "").startsWith(`issues-manual-wait:`));
		assert.equal(waitRecs.length, 1, `exactly one wait notice (got ${waitRecs.length})`);
		assert.match(waitRecs[0].body, /\/swarm issues resume/, "notice names the resume command");
		// double observation → still exactly one
		const st2 = await readState(p, cwd);
		await observeLinkedTaskLocked(p, { cwd }, st2, { taskId: run.queue[0].taskId, status: "done" }, { deliverMessageLocked });
		const waitRecs2 = (await mailboxRecs(cwd)).filter((r2) => String(r2.idempotencyKey || "").startsWith(`issues-manual-wait:`));
		assert.equal(waitRecs2.length, 1, "replay: still exactly one notice");
	} finally {
		delete process.env.PI_SWARM_ISSUES_ADVANCEMENT;
		rmSync(cwd, { recursive: true, force: true });
	}
});

// === T3: resume-activates ===
await t("T3: manual wait → real resume activates the next issue and clears the marker", async () => {
	const cwd = seedWorld();
	process.env.PI_SWARM_ISSUES_ADVANCEMENT = "manual";
	try {
		const p = await startRun(cwd);
		let st = await readState(p, cwd);
		let run = getIssueRun(st);
		finishLinkedTask(cwd, run.queue[0].taskId);
		await observeLinkedTaskLocked(p, { cwd }, st, { taskId: run.queue[0].taskId, status: "done" }, { deliverMessageLocked });
		await writeState(p, st);
		// real command
		const ctx = { cwd, ui: { notify: () => {} } };
		await handleIssuesCommand("issues", ["resume"], ctx, p, {});
		run = getIssueRun(await readState(p, cwd));
		assert.equal(run.activeIssueId, "fix-two", "resume activated fix-two");
		assert.equal(run.queue[1].status, "active");
		assert.ok(!run.advancement, "waiting-manual marker cleared");
	} finally {
		delete process.env.PI_SWARM_ISSUES_ADVANCEMENT;
		rmSync(cwd, { recursive: true, force: true });
	}
});

// === T4: mode normalization on start ===
await t("T4: start normalizes mode — MANUAL env honored; yml manual honored; start records mode", async () => {
	process.env.PI_SWARM_ISSUES_ADVANCEMENT = "MANUAL";
	try {
		const cwd = seedWorld();
		const p = await startRun(cwd);
		const run = getIssueRun(await readState(p, cwd));
		assert.equal(run.advancementMode ?? "manual", "manual", "start records/normalizes manual mode");
		rmSync(cwd, { recursive: true, force: true });
	} finally {
		delete process.env.PI_SWARM_ISSUES_ADVANCEMENT;
	}
	const cwd2 = seedWorld({ yml: 'issue-sequencer:\n  advancement: manual\n' });
	const p2 = await startRun(cwd2);
	const run2 = getIssueRun(await readState(p2, cwd2));
	assert.equal(run2.advancementMode ?? "manual", "manual", "yml manual recorded by start");
	rmSync(cwd2, { recursive: true, force: true });
});

// === T5b: invalid value fails start ===
await t("T5b: start fails fast on invalid advancement value (no run mutation)", async () => {
	const cwd = seedWorld({ yml: 'issue-sequencer:\n  advancement: yolo\n' });
	const p = paths(cwd);
	await ensureDirs(p);
	const notes = [];
	await assert.rejects(
		() => handleIssuesCommand("issues", ["start"], { cwd, ui: { notify: (m, k) => notes.push({ m: String(m), k }) } }, p, {}),
		/issue-sequencer\.advancement.*yolo/,
		"start rejects invalid yml advancement",
	);
	const st = await readState(p, cwd);
	assert.notEqual(st.issueRun?.status, "running", "no run started on invalid config");
	rmSync(cwd, { recursive: true, force: true });
});

// === T9: post-hold replay composition through the REAL tick ===
await t("T9: manual-mode post-hold replay — real tick refuses advance, one notice, resume advances", async () => {
	const cwd = seedWorld();
	process.env.PI_SWARM_ISSUES_ADVANCEMENT = "manual";
	try {
		const p = await startRun(cwd);
		let st = await readState(p, cwd);
		seedHolder(st);
		await writeState(p, st);
		st = await readState(p, cwd);
		let run = getIssueRun(st);
		finishLinkedTask(cwd, run.queue[0].taskId);
		// hold leg through the REAL tick (holder blocks safe-idle)
		await runPumpMaintenancePhasesLocked({}, { cwd, isIdle: () => true }, p, st, Date.now(), "adv-hold");
		await writeState(p, st);
		st = await readState(p, cwd);
		run = getIssueRun(st);
		assert.equal(run.queue[0].status, "done", "hold leg: entry terminal while held");
		// release the hold, field shape: activeIssueId cleared
		clearHolder(st);
		run.activeIssueId = null;
		await writeState(p, st);
		// replay leg through the REAL tick — seam must refuse advance in manual mode
		st = await readState(p, cwd);
		await runPumpMaintenancePhasesLocked({}, { cwd, isIdle: () => true }, p, st, Date.now(), "adv-replay");
		await writeState(p, st);
		run = getIssueRun(await readState(p, cwd));
		assert.equal(run.queue[1].status, "queued", "manual replay: NO auto-advance");
		assert.equal(run.status, "running", "manual replay: run still running");
		assert.equal(run.advancement, "waiting-manual", "manual replay: waiting marker set");
		const waitRecs = (await mailboxRecs(cwd)).filter((r) => String(r.idempotencyKey || "").startsWith("issues-manual-wait:"));
		assert.equal(waitRecs.length, 1, "manual replay: exactly one wait notice");
		// resume activates
		await handleIssuesCommand("issues", ["resume"], { cwd, ui: { notify: () => {} } }, p, {});
		run = getIssueRun(await readState(p, cwd));
		assert.equal(run.activeIssueId, "fix-two", "resume activated after manual replay wait");
	} finally {
		delete process.env.PI_SWARM_ISSUES_ADVANCEMENT;
		rmSync(cwd, { recursive: true, force: true });
	}
});

// === T7: freeze unchanged in manual mode ===
await t("T7: manual mode — blocked observation still pauses run with branched notice", async () => {
	const cwd = seedWorld();
	process.env.PI_SWARM_ISSUES_ADVANCEMENT = "manual";
	try {
		const p = await startRun(cwd);
		const st = await readState(p, cwd);
		const run = getIssueRun(st);
		const tp = join(cwd, ".pi", "swarm", "tasks", run.queue[0].taskId, "task.json");
		const task = JSON.parse(readFileSync(tp, "utf8"));
		task.status = "blocked";
		for (const n of Object.values(task.nodes ?? {})) n.status = "blocked";
		writeFileSync(tp, JSON.stringify(task, null, 2) + "\n");
		await observeLinkedTaskLocked(p, { cwd }, st, { taskId: run.queue[0].taskId, status: "blocked" }, { deliverMessageLocked });
		await writeState(p, st);
		const run2 = getIssueRun(await readState(p, cwd));
		assert.equal(run2.status, "paused", "freeze unchanged: run paused");
		const term = (await mailboxRecs(cwd)).filter((r) => String(r.idempotencyKey || "").startsWith("issues-terminal:"));
		assert.equal(term.length, 1, "branched terminal notice delivered");
		assert.match(term[0].body, /abandon fix-one/, "b1-b2 branched text present");
	} finally {
		delete process.env.PI_SWARM_ISSUES_ADVANCEMENT;
		rmSync(cwd, { recursive: true, force: true });
	}
});

// === T8: completion in manual mode ===
await t("T8: manual mode — last issue done completes the run (no waiting marker)", async () => {
	const cwd = seedWorld();
	process.env.PI_SWARM_ISSUES_ADVANCEMENT = "manual";
	try {
		const p = await startRun(cwd);
		let st = await readState(p, cwd);
		let run = getIssueRun(st);
		// only the ACTIVE entry carries a taskId; drive each issue through observe→resume
		while (true) {
			st = await readState(p, cwd);
			run = getIssueRun(st);
			const active = run.queue.find((q) => q.status === "active");
			if (!active) break;
			finishLinkedTask(cwd, active.taskId);
			st = await readState(p, cwd);
			await observeLinkedTaskLocked(p, { cwd }, st, { taskId: active.taskId, status: "done" }, { deliverMessageLocked });
			await writeState(p, st);
			run = getIssueRun(await readState(p, cwd));
			if (run.status !== "running") break;
			if (!run.queue.some((q) => q.status === "queued")) break;
			await handleIssuesCommand("issues", ["resume"], { cwd, ui: { notify: () => {} } }, p, {});
		}
		const final = getIssueRun(await readState(p, cwd));
		assert.equal(final.status, "complete", "run completed in manual mode");
		assert.ok(!final.advancement, "no waiting marker on completion");
		const comp = (await mailboxRecs(cwd)).filter((r) => String(r.idempotencyKey || "").startsWith("issues-complete:"));
		assert.equal(comp.length, 1, "completion notice fired once");
	} finally {
		delete process.env.PI_SWARM_ISSUES_ADVANCEMENT;
		rmSync(cwd, { recursive: true, force: true });
	}
});

// === T6: auto byte-identical (standing; deep coverage = existing battery) ===
await t("T6: auto default — terminal-done + safe idle advances as today (env unset)", async () => {
	const cwd = seedWorld();
	const p = await startRun(cwd);
	let st = await readState(p, cwd);
	let run = getIssueRun(st);
	finishLinkedTask(cwd, run.queue[0].taskId);
	await observeLinkedTaskLocked(p, { cwd }, st, { taskId: run.queue[0].taskId, status: "done" }, { deliverMessageLocked });
	await writeState(p, st);
	run = getIssueRun(await readState(p, cwd));
	assert.equal(run.activeIssueId, "fix-two", "auto: advanced to fix-two");
	assert.ok(!run.advancement, "auto: no waiting marker");
	const waitRecs = (await mailboxRecs(cwd)).filter((r) => String(r.idempotencyKey || "").startsWith("issues-manual-wait:"));
	assert.equal(waitRecs.length, 0, "auto: no manual-wait notice");
	rmSync(cwd, { recursive: true, force: true });
});

console.log(process.exitCode ? "\nissues-advancement-mode: FAIL" : `\nissues-advancement-mode: PASS (${passed})`);
