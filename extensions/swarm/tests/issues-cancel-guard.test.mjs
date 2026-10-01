#!/usr/bin/env node
/**
 * swarm-issues-b1-b2 — linked-task cancel guard + terminal notice disposition matrix.
 *
 * Incident seed: my-daily-pi run-mup15r16-epimos — worker delivered the linked task's work
 * via commit 159512b but the task was never marked done; root cancelled the ACTIVE linked
 * task at 04:35:33 → run silently froze and the terminal notice recommended a command
 * (abandon) that would have been refused from that state.
 *
 * RED-first (both observed before the fixes, evidence in the implementation report):
 *   RED(a) cancelTask on the ACTIVE linked task of a running run succeeds today;
 *   RED(b) terminal notice recommends abandon from a cancelled-entry state where abandon refuses.
 *
 * Matrix (end-to-end, every named command driven from seeded state):
 *   blocked/failed entry → notice names abandon <id> <reason> then resume (both succeed);
 *   cancelled entry      → notice names resume (succeeds).
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "..", "src");
process.env.PI_SWARM_AGENT_ID = "root";
process.env.PI_SWARM_IS_ROOT = "1";

const { paths, readState, writeState, ensureDirs } = await import(join(src, "state.ts"));
const { expected } = await import(join(src, "errorlog.ts"));
const { getIssueRun } = await import(join(src, "issues", "state.ts"));
const { handleIssuesCommand } = await import(join(src, "commands", "issues.ts"));
const { observeLinkedTaskLocked } = await import(join(src, "issues", "controller.ts"));
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

function makeCtx() {
	const notes = [];
	return { cwd: "", ui: { notify: (m, k) => notes.push({ msg: String(m), kind: k }) }, __notes: notes };
}
const noteText = (ctx) => ctx.__notes.map((n) => n.msg).join("\n");

async function seedLinkedWorld() {
	const cwd = mkdtempSync(join(tmpdir(), "issues-cancel-"));
	for (const d of ["traces", "mailboxes", "tasks"]) mkdirSync(join(cwd, ".pi", "swarm", d), { recursive: true });
	mkdirSync(join(cwd, "docs"), { recursive: true });
	writeFileSync(join(cwd, "docs", "one.md"), "doc one\n");
	writeFileSync(join(cwd, "docs", "two.md"), "doc two\n");
	writeFileSync(
		join(cwd, ".pi", "swarm", "issues.yml"),
		"issues:\n  - id: fix-cron\n    title: Fix Cron Store\n    content: cron store works\n    docs:\n      - docs/one.md\n  - id: fix-locator\n    title: Fix Locator\n    content: locator works\n    docs:\n      - docs/two.md\n",
	);
	const p = paths(cwd);
	await ensureDirs(p);
	const ctx = makeCtx();
	ctx.cwd = cwd;
	await handleIssuesCommand("issues", ["start"], ctx, p, {});
	const st = await readState(p, cwd);
	const run = getIssueRun(st);
	return { cwd, p, st, ctx, run };
}

function makePi() {
	const calls = { tools: {} };
	return {
		calls,
		on: () => {}, off: () => {},
		registerTool: (t) => { calls.tools[t.name] = t; },
		registerCommand: () => {},
		sendMessage: () => {}, sendUserMessage: () => {},
		exec: async () => ({ code: 0, stdout: "", stderr: "" }),
		setModel: async () => true,
		getAllTools: () => [], getActiveTools: () => [], setActiveTools: () => {},
		ui: { notify: () => {}, setWidget: () => {}, setStatus: () => {}, setFooter: () => {} },
	};
}

const mailboxRecs = (cwd) => {
	try {
		const dir = join(cwd, ".pi", "swarm", "mailboxes");
		return readdirSyncSafe(dir).flatMap((f) =>
			readFileSync(join(dir, f), "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l)),
		);
	} catch {
		return [];
	}
};
function readdirSyncSafe(dir) {
	try {
		return readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
	} catch (err) {
		void expected("mailbox_dir_absent");
		return [];
	}
}

// === RED (a): cancelTask on the ACTIVE linked task of a running run ===
await t("RED(a) GREEN-after: swarm_update_task cancelTask REFUSES the active linked task of a running run", async () => {
	const { cwd, p } = await seedLinkedWorld();
	const pi = makePi();
	const { registerTasksTools } = await import(join(src, "tools", "tasks.ts"));
	registerTasksTools(pi);
	const st = await readState(p, cwd);
	const taskId = getIssueRun(st).queue[0].taskId;
	await assert.rejects(
		() => pi.calls.tools["swarm_update_task"].execute("x", { taskId, nodeId: "start", cancelTask: true, force: true }, undefined, undefined, { cwd }),
		/LINKED_TASK_CANCEL_REFUSED/,
		"active linked task cancel must be refused with guidance",
	);
	// run untouched
	const st2 = await readState(p, cwd);
	assert.equal(getIssueRun(st2).status, "running");
	assert.equal(getIssueRun(st2).queue[0].status, "active");
	rmSync(cwd, { recursive: true, force: true });
});

await t("guard: refusal text directs to node-done completion AND /swarm issues disposition", async () => {
	const { cwd, p } = await seedLinkedWorld();
	const pi = makePi();
	const { registerTasksTools } = await import(join(src, "tools", "tasks.ts"));
	registerTasksTools(pi);
	const st = await readState(p, cwd);
	const taskId = getIssueRun(st).queue[0].taskId;
	try {
		await pi.calls.tools["swarm_update_task"].execute("x", { taskId, nodeId: "start", cancelTask: true, force: true }, undefined, undefined, { cwd });
		assert.fail("expected rejection");
	} catch (err) {
		const msg = String(err instanceof Error ? err.message : err);
		assert.match(msg, /node done|swarm_update_task/);
		assert.match(msg, /\/swarm issues/);
		assert.match(msg, /force:true/);
	}
	rmSync(cwd, { recursive: true, force: true });
});

await t("guard: non-linked task cancels unchanged (linkage-scoped, force path byte-identical)", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "issues-cancel-"));
	for (const d of ["traces", "mailboxes", "tasks"]) mkdirSync(join(cwd, ".pi", "swarm", d), { recursive: true });
	const p = paths(cwd);
	await ensureDirs(p);
	const pi = makePi();
	const { registerTasksTools } = await import(join(src, "tools", "tasks.ts"));
	registerTasksTools(pi);
	const created = await pi.calls.tools["swarm_create_task"].execute("x", { title: "plain", goal: "work" }, undefined, undefined, { cwd });
	const text = typeof created === "string" ? created : JSON.stringify(created);
	const taskId = String(text).match(/task-[a-z0-9-]+/)?.[0];
	const r = await pi.calls.tools["swarm_update_task"].execute("x", { taskId, nodeId: "plan", cancelTask: true, force: true }, undefined, undefined, { cwd });
	const out = typeof r === "string" ? r : JSON.stringify(r);
	assert.doesNotMatch(out, /LINKED_TASK_CANCEL_REFUSED/, "non-linked cancel must proceed");
	const st = await readState(p, cwd);
	assert.equal(st.tasks?.[taskId]?.status ?? "absent-or-cancelled", "absent-or-cancelled"); // no linkage side effects
	rmSync(cwd, { recursive: true, force: true });
});

// === RED (b) + matrix: terminal notice names the command that actually succeeds ===
async function observeStatus(status) {
	const w = await seedLinkedWorld();
	await observeLinkedTaskLocked(w.p, { cwd: w.cwd }, w.st, { taskId: w.run.queue[0].taskId, status }, { deliverMessageLocked });
	await writeState(w.p, w.st);
	return w;
}

await t("matrix(blocked): notice names abandon then resume; both commands SUCCEED from seeded state", async () => {
	const { cwd, ctx } = await observeStatus("blocked");
	const recs = mailboxRecs(cwd).filter((r) => String(r.idempotencyKey || "").startsWith("issues-terminal:"));
	assert.equal(recs.length, 1);
	assert.match(recs[0].body, /abandon fix-cron/, "notice must name abandon with the issue id");
	assert.match(recs[0].body, /resume/, "notice must name resume");
	// drive the named commands for real
	ctx.cwd = cwd;
	await handleIssuesCommand("issues", ["abandon", "fix-cron", "incident disposition"], ctx, paths(cwd), {});
	assert.doesNotMatch(noteText(ctx), /abandon refused/);
	await handleIssuesCommand("issues", ["resume"], ctx, paths(cwd), {});
	const st = await readState(paths(cwd), cwd);
	const run = getIssueRun(st);
	assert.equal(run.queue[0].status, "cancelled");
	assert.equal(run.queue[1].status, "active", "resume advanced the next issue");
	rmSync(cwd, { recursive: true, force: true });
});

await t("matrix(cancelled): notice names resume (NOT abandon); resume SUCCEEDS from seeded state", async () => {
	const { cwd, ctx } = await observeStatus("cancelled");
	const recs = mailboxRecs(cwd).filter((r) => String(r.idempotencyKey || "").startsWith("issues-terminal:"));
	assert.equal(recs.length, 1);
	assert.match(recs[0].body, /resume/, "notice must name resume");
	assert.doesNotMatch(recs[0].body, /abandon/, "abandon is refused from cancelled state — notice must not recommend it");
	// prove abandon would refuse (the incident), then drive resume for real
	ctx.cwd = cwd;
	await handleIssuesCommand("issues", ["abandon", "fix-cron", "would-be-refused"], ctx, paths(cwd), {});
	assert.match(noteText(ctx), /abandon refused/);
	await handleIssuesCommand("issues", ["resume"], ctx, paths(cwd), {});
	const st = await readState(paths(cwd), cwd);
	assert.equal(getIssueRun(st).queue[1].status, "active", "resume advanced the next issue");
	rmSync(cwd, { recursive: true, force: true });
});

await t("matrix(failed): notice names abandon then resume; both SUCCEED", async () => {
	const { cwd, ctx } = await observeStatus("failed");
	const recs = mailboxRecs(cwd).filter((r) => String(r.idempotencyKey || "").startsWith("issues-terminal:"));
	assert.match(recs[0].body, /abandon fix-cron/);
	assert.match(recs[0].body, /resume/);
	ctx.cwd = cwd;
	await handleIssuesCommand("issues", ["abandon", "fix-cron", "failed disposition"], ctx, paths(cwd), {});
	assert.doesNotMatch(noteText(ctx), /abandon refused/);
	await handleIssuesCommand("issues", ["resume"], ctx, paths(cwd), {});
	assert.equal(getIssueRun(await readState(paths(cwd), cwd)).queue[1].status, "active");
	rmSync(cwd, { recursive: true, force: true });
});

console.log(process.exitCode ? "\nissues-cancel-guard: FAIL" : `\nissues-cancel-guard: PASS (${passed})`);
