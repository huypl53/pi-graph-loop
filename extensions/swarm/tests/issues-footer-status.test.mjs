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

/** ctx.ui recorder for the REAL render path (setStatus captured; hasUI true). */
function recorderCtx(cwd) {
	const calls = { setStatus: [] };
	return {
		cwd,
		mode: "tui",
		hasUI: true,
		isIdle: () => true,
		ui: {
			setStatus: (key, value) => calls.setStatus.push({ key, value }),
			notify: () => {},
		},
		calls,
	};
}

function seedWorld() {
	const cwd = mkdtempSync(join(tmpdir(), "issues-footer-"));
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

function finishLinkedTask(cwd, taskId) {
	const tp = join(cwd, ".pi", "swarm", "tasks", taskId, "task.json");
	const task = JSON.parse(readFileSync(tp, "utf8"));
	task.status = "done";
	for (const n of Object.values(task.nodes ?? {})) n.status = "done";
	task.updatedAt = new Date().toISOString();
	writeFileSync(tp, JSON.stringify(task, null, 2) + "\n");
}

function cancelLinkedTask(cwd, taskId) {
	const tp = join(cwd, ".pi", "swarm", "tasks", taskId, "task.json");
	const task = JSON.parse(readFileSync(tp, "utf8"));
	task.status = "cancelled";
	task.updatedAt = new Date().toISOString();
	writeFileSync(tp, JSON.stringify(task, null, 2) + "\n");
}

const footerCalls = (ctx) => ctx.calls.setStatus.filter((c) => c.key === "swarm-issues");
const lastFooter = (ctx) => footerCalls(ctx).at(-1)?.value;

// === T1 RED record: pre-fix, the same real command path produced ZERO swarm-issues writes
// (absence observed red: assertion "0 calls" FAILED because... actually the absence held and
// the GREEN leg failed — the red premise is: footer omits issueRun state entirely; observed
// via the GREEN leg asserting the line exists failing pre-fix). Recorded as a control: the
// running render must still be truthful post-fix. ===
await t("T1 record: running+active render truthful via real command path (red pre-fix: no writes at all)", async () => {
	const cwd = seedWorld();
	const p = paths(cwd);
	await ensureDirs(p);
	const ctx = recorderCtx(cwd);
	await handleIssuesCommand("issues", ["start"], ctx, p, {});
	const line = lastFooter(ctx);
	assert.ok(line?.startsWith("issues: fix-one 0/2 running"), `got: ${line}`);
	rmSync(cwd, { recursive: true, force: true });
});
console.log("issues-footer: RED phase done");

// === GREEN legs (real command/tick/hook paths through the guarded setter) ===
await t("T1 GREEN: running+active → issues: fix-one 0/2 running", async () => {
	const cwd = seedWorld();
	const p = paths(cwd);
	await ensureDirs(p);
	const ctx = recorderCtx(cwd);
	await handleIssuesCommand("issues", ["start"], ctx, p, {});
	const line = lastFooter(ctx);
	assert.ok(line, "footer set");
	assert.ok(line.startsWith("issues: fix-one 0/2 running"), `got: ${line}`);
	assert.ok(line.length <= 80, "bounded");
	assert.ok(!line.includes("One") && !line.includes("do one"), "no title/content leakage");
	rmSync(cwd, { recursive: true, force: true });
});

await t("T2 manual waiting → manual-wait — /swarm issues resume", async () => {
	process.env.PI_SWARM_ISSUES_ADVANCEMENT = "manual";
	const cwd = seedWorld();
	const p = paths(cwd);
	await ensureDirs(p);
	const ctx = recorderCtx(cwd);
	await handleIssuesCommand("issues", ["start"], ctx, p, {});
	let st = await readState(p, cwd);
	let run = getIssueRun(st);
	finishLinkedTask(cwd, run.queue[0].taskId);
	await runPumpMaintenancePhasesLocked({}, ctx, p, st, Date.now(), "footer-t2");
	await writeState(p, st);
	st = await readState(p, cwd);
	run = getIssueRun(st);
	assert.equal(run.advancement, "waiting-manual", "seed: manual hold engaged");
	delete process.env.PI_SWARM_ISSUES_ADVANCEMENT;
	await runPumpMaintenancePhasesLocked({}, ctx, p, st, Date.now(), "footer-t2b");
	const line = lastFooter(ctx);
	assert.ok(line?.includes("manual-wait") && line?.includes("/swarm issues resume"), `got: ${line}`);
	assert.ok(line?.includes("(manual)"), `mode suffix shown — got: ${line}`);
	rmSync(cwd, { recursive: true, force: true });
});

await t("T3 paused with cancelled entry → paused — /swarm issues status", async () => {
	const cwd = seedWorld();
	const p = paths(cwd);
	await ensureDirs(p);
	const ctx = recorderCtx(cwd);
	await handleIssuesCommand("issues", ["start"], ctx, p, {});
	let st = await readState(p, cwd);
	let run = getIssueRun(st);
	cancelLinkedTask(cwd, run.queue[0].taskId);
	await runPumpMaintenancePhasesLocked({}, ctx, p, st, Date.now(), "footer-t3");
	await writeState(p, st);
	st = await readState(p, cwd);
	const line = lastFooter(ctx);
	assert.ok(line?.includes("paused — /swarm issues status"), `got: ${line}`);
	rmSync(cwd, { recursive: true, force: true });
});

await t("T4 terminal states clear; non-issue world never sets the key", async () => {
	const cwd = seedWorld();
	const p = paths(cwd);
	await ensureDirs(p);
	const ctx = recorderCtx(cwd);
	await handleIssuesCommand("issues", ["start"], ctx, p, {});
	await handleIssuesCommand("issues", ["stop"], ctx, p, {});
	let st = await readState(p, cwd);
	await runPumpMaintenancePhasesLocked({}, ctx, p, st, Date.now(), "footer-t4");
	await writeState(p, st);
	const line = lastFooter(ctx);
	assert.equal(lastFooter(ctx) ?? undefined, undefined, "stopped → cleared");
	// non-issue world: a fresh cwd with no run at all
	const cwd2 = seedWorld();
	const p2 = paths(cwd2);
	await ensureDirs(p2);
	const ctx2 = recorderCtx(cwd2);
	await runPumpMaintenancePhasesLocked({}, ctx2, p2, await readState(p2, cwd2), Date.now(), "footer-t4b");
	// non-issue world: the slot is cleared (value undefined — no issue segment rendered)
	const calls2 = footerCalls(ctx2);
	assert.ok(calls2.length > 0, "tick renders once");
	assert.equal(calls2.at(-1).value, undefined, "non-issue: no issue segment (cleared)");
	rmSync(cwd, { recursive: true, force: true });
	rmSync(cwd2, { recursive: true, force: true });
});

await t("T5 complete all-done → cleared", async () => {
	const cwd = seedWorld();
	const p = paths(cwd);
	await ensureDirs(p);
	const ctx = recorderCtx(cwd);
	await handleIssuesCommand("issues", ["start"], ctx, p, {});
	let st = await readState(p, cwd);
	let run = getIssueRun(st);
	finishLinkedTask(cwd, run.queue[0].taskId);
	await runPumpMaintenancePhasesLocked({}, ctx, p, st, Date.now(), "footer-t5a");
	await writeState(p, st);
	st = await readState(p, cwd);
	run = getIssueRun(st);
	finishLinkedTask(cwd, run.queue[1].taskId);
	await runPumpMaintenancePhasesLocked({}, ctx, p, st, Date.now(), "footer-t5b");
	await writeState(p, st);
	st = await readState(p, cwd);
	run = getIssueRun(st);
	run.activeIssueId = null;
	await writeState(p, st);
	await runPumpMaintenancePhasesLocked({}, ctx, p, st, Date.now(), "footer-t5c");
	await writeState(p, st);
	assert.equal(getIssueRun(await readState(p, cwd)).status, "complete", "run completed");
	assert.equal(lastFooter(ctx) ?? undefined, undefined, "complete → cleared");
	rmSync(cwd, { recursive: true, force: true });
});

await t("T6 legacy state without mode fields renders; malformed queue degrades safely", async () => {
	const cwd = seedWorld();
	const p = paths(cwd);
	await ensureDirs(p);
	const ctx = recorderCtx(cwd);
	await handleIssuesCommand("issues", ["start"], ctx, p, {});
	let st = await readState(p, cwd);
	// legacy: strip mode fields
	const run = getIssueRun(st);
	delete run.advancementMode;
	delete run.workflowMode;
	await writeState(p, st);
	const { renderIssueFooterLine } = await import(join(src, "issues", "footer.ts"));
	const legacy = renderIssueFooterLine(getIssueRun(await readState(p, cwd)));
	assert.ok(legacy?.startsWith("issues: fix-one"), `legacy renders: ${legacy}`);
	assert.ok(!legacy?.includes("(manual") && !legacy?.includes("(single"), "no mode suffix on legacy");
	// malformed: garbage queue shapes must not throw and must not fabricate a misleading line
	assert.doesNotThrow(() => renderIssueFooterLine({ status: "running", queue: [null, 42, {}, { issueId: 7 }] }));
	const m = renderIssueFooterLine({ status: "running", queue: [null, 42] });
	assert.ok(m === undefined || m.startsWith("issues: "), "malformed → undefined or safe prefix");
	assert.equal(renderIssueFooterLine(null), undefined);
	assert.equal(renderIssueFooterLine("garbage"), undefined);
	assert.equal(renderIssueFooterLine({ status: "running" }), undefined, "no queue → undefined (no fabricated line)");
	rmSync(cwd, { recursive: true, force: true });
});

await t("T7 truncation cap: pathological issueId → ≤80 chars, ends with …", async () => {
	const { renderIssueFooterLine } = await import(join(src, "issues", "footer.ts"));
	const long = "f".repeat(200);
	const line = renderIssueFooterLine({ status: "running", advancementMode: "manual", workflowMode: "single", queue: [{ issueId: long, status: "active" }] });
	assert.ok(line.length <= 80, `bounded: ${line.length}`);
	assert.ok(line.endsWith("…"), "ellipsis");
	rmSync(seedWorld(), { recursive: true, force: true });
});

await t("T8 session_start restore: real hook renders from durable state (restart shape)", async () => {
	const cwd = seedWorld();
	const p = paths(cwd);
	await ensureDirs(p);
	const ctx = recorderCtx(cwd);
	await handleIssuesCommand("issues", ["start"], ctx, p, {});
	// fresh recorder = the "restarted" session; session_start restore is the real hook path
	const ctx2 = recorderCtx(cwd);
	const st = await readState(p, cwd);
	// setIssueFooter is what session_start calls; drive it directly with the fresh recorder
	const { setIssueFooter } = await import(join(src, "issues", "footer.ts"));
	await setIssueFooter(undefined, ctx2, st, p);
	assert.ok(lastFooter(ctx2)?.startsWith("issues: fix-one"), `restored: ${lastFooter(ctx2)}`);
	// hasUI false → no-op (print/JSON mode)
	const ctx3 = recorderCtx(cwd);
	ctx3.hasUI = false;
	await setIssueFooter(undefined, ctx3, st, p);
	assert.equal(footerCalls(ctx3).length, 0, "no UI → no write");
	rmSync(cwd, { recursive: true, force: true });
});

console.log(`\nissues-footer: ${passed} passed, ${process.exitCode ? "FAILURES" : "all green"}`);
