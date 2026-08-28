// extensions/cron/cron.test.mjs — focused tests for scheduler math,
// persistence round-trip, and command parsing.
// Run: node extensions/cron/cron.test.mjs
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

let pass = 0;
let fail = 0;
const failures = [];
function ok(cond, label) {
	if (cond) { pass++; console.log(`  ok  ${label}`); }
	else { fail++; failures.push(label); console.error(`FAIL  ${label}`); }
}
function eq(a, b, label) {
	if (Object.is(a, b)) { pass++; console.log(`  ok  ${label}`); }
	else { fail++; failures.push(label); console.error(`FAIL  ${label}: got ${JSON.stringify(a)} want ${JSON.stringify(b)}`); }
}
function throws(fn, label, re) {
	let threw = false;
	try { fn(); } catch (e) { threw = true; if (re && !re.test(e?.message)) { fail++; failures.push(label); console.error(`FAIL  ${label}: wrong error: ${e?.message}`); return; } }
	if (threw) { pass++; console.log(`  ok  ${label}`); }
	else { fail++; failures.push(label); console.error(`FAIL  ${label}: did not throw`); }
}

const scheduler = await import(join(here, "src", "scheduler.ts"));
const store = await import(join(here, "src", "store.ts"));
const command = await import(join(here, "src", "command.ts"));

// ---------- scheduler math: interval parsing ----------
console.log("scheduler: parseEvery");
eq(scheduler.parseEvery("5s"), 5_000, "5s -> 5000");
eq(scheduler.parseEvery("10m"), 600_000, "10m -> 600000");
eq(scheduler.parseEvery("2h"), 7_200_000, "2h -> 7200000");
eq(scheduler.parseEvery("1s"), 1_000, "1s -> 1000");
throws(() => scheduler.parseEvery("0m"), "0m rejected");
throws(() => scheduler.parseEvery("1d"), "1d rejected");
throws(() => scheduler.parseEvery("2.5m"), "2.5m rejected");
throws(() => scheduler.parseEvery("abc"), "abc rejected");
throws(() => scheduler.parseEvery(""), "empty rejected");
throws(() => scheduler.parseEvery("5"), "missing unit rejected");
throws(() => scheduler.parseEvery("-3s"), "negative rejected");

// ---------- scheduler math: due-check ----------
console.log("scheduler: isDue");
const NOW = 1_000_000_000;
const mk = (over) => ({ id: "x", everyMs: over.everyMs ?? 60_000, prompt: "p", lastRunAt: over.lastRunAt ?? null, createdAt: NOW });
ok(scheduler.isDue(mk({ everyMs: 60_000, lastRunAt: null }), NOW), "due when lastRunAt missing");
ok(scheduler.isDue(mk({ everyMs: 60_000, lastRunAt: NOW - 60_000 }), NOW), "due when elapsed == interval");
ok(scheduler.isDue(mk({ everyMs: 60_000, lastRunAt: NOW - 90_000 }), NOW), "due when elapsed > interval");
ok(!scheduler.isDue(mk({ everyMs: 60_000, lastRunAt: NOW - 59_999 }), NOW), "not due when elapsed < interval");
ok(!scheduler.isDue(mk({ everyMs: 60_000, lastRunAt: NOW - 1 }), NOW), "not due just after run");
ok(!scheduler.isDue(mk({ everyMs: 0 }), NOW), "everyMs <= 0 never due");

// findDue filters
console.log("scheduler: findDue");
const jobs = [
	mk({ everyMs: 10_000, lastRunAt: null }),       // due
	mk({ everyMs: 60_000, lastRunAt: NOW - 30_000 }), // not due
	mk({ everyMs: 60_000, lastRunAt: NOW - 61_000 }), // due
];
eq(scheduler.findDue(jobs, NOW).length, 2, "findDue returns exactly the due jobs");
eq(scheduler.DEFAULT_TICK_MS, 30_000, "default tick is 30s");

// ---------- missed-tick catch-up fires at most once ----------
console.log("scheduler: catch-up-once");
{
	// Simulate: job interval 60s, pi was down 5 intervals. On the first tick
	// after restart it must fire at most once; the second tick (immediately
	// after) must NOT refire because lastRunAt was stamped.
	const job = mk({ everyMs: 60_000, lastRunAt: NOW - 300_000 }); // 5 intervals missed
	const now1 = NOW;
	ok(scheduler.isDue(job, now1), "overdue job is due after downtime");
	job.lastRunAt = now1; // scheduler stamps after firing once
	const now2 = now1 + 1_000; // 1s later, well within the next interval
	ok(!scheduler.isDue(job, now2), "no second fire within the next interval (catch-up-once)");
}

// ---------- persistence round-trip ----------
console.log("store: round-trip");
{
	const dir = mkdtempSync(join(tmpdir(), "cron-test-"));
	try {
		const before = {
			id: "job-1",
			everyMs: 600_000,
			prompt: "Check things",
			lastRunAt: 1_710_000_000_000,
			createdAt: 1_709_000_000_000,
		};
		store.saveJobs(dir, [before]);
		ok(existsSync(store.jobsPath(dir)), "jobs.json written");
		const after = store.loadJobs(dir);
		eq(after.length, 1, "one job reloaded");
		const j = after[0];
		eq(j.id, before.id, "id survives");
		eq(j.everyMs, before.everyMs, "everyMs survives");
		eq(j.prompt, before.prompt, "prompt survives");
		eq(j.lastRunAt, before.lastRunAt, "lastRunAt survives");
		eq(j.createdAt, before.createdAt, "createdAt survives");

		// atomic write actually produced valid JSON on disk
		const raw = JSON.parse(readFileSync(store.jobsPath(dir), "utf8"));
		eq(raw.version, 1, "file has version 1");

		// add + remove round-trip
		const added = store.addJob(dir, 5_000, "hello");
		ok(added.id && added.everyMs === 5_000, "addJob returns the new job");
		eq(store.loadJobs(dir).length, 2, "addJob persisted");
		const removed = store.removeJobByIndex(dir, 1);
		ok(removed?.id === before.id, "removeByIndex(1) removes the first job");
		eq(store.loadJobs(dir).length, 1, "one job remains after remove");
		eq(store.loadJobs(dir)[0].id, added.id, "remaining job is the added one");
		const removedLast = store.removeLastJob(dir);
		ok(removedLast?.id === added.id, "removeLastJob removes the remaining job");
		eq(store.loadJobs(dir).length, 0, "store empty after removing all");
		ok(store.removeJobByIndex(dir, 1) === null, "remove out-of-range returns null");
		ok(store.removeLastJob(dir) === null, "removeLast on empty returns null");

		// corrupt file -> empty, not throw
		const { writeFileSync } = await import("node:fs");
		writeFileSync(store.jobsPath(dir), "{not json", "utf8");
		eq(store.loadJobs(dir).length, 0, "corrupt file loads as empty (best-effort)");
		// empty dir (no file) -> empty
		rmSync(dir, { recursive: true, force: true });
		const dir2 = mkdtempSync(join(tmpdir(), "cron-test-"));
		try { eq(store.loadJobs(dir2).length, 0, "missing file loads as empty"); } finally { rmSync(dir2, { recursive: true, force: true }); }
	} catch (e) {
		fail++;
		failures.push("store round-trip threw");
		console.error("FAIL store round-trip threw:", e);
		try { rmSync(dir, { recursive: true, force: true }); } catch {}
	}
}

// ---------- command parsing ----------
console.log("command: parseArgs");
{
	const p = command.parseArgs(`add --every 5m "Check swarm now"`);
	eq(p.subcommand, "add", "subcommand add");
	eq(p.rest[0], "--every", "flag token");
	eq(p.rest[1], "5m", "value token");
	eq(p.rest[2], "Check swarm now", "quoted prompt as one token");

	const p2 = command.parseArgs(`remove last`);
	eq(p2.subcommand, "remove", "subcommand remove");
	eq(p2.rest[0], "last", "last token");

	const p3 = command.parseArgs(`  list  `);
	eq(p3.subcommand, "list", "whitespace trimmed");

	const p4 = command.parseArgs(``);
	eq(p4.subcommand, "", "empty input");

	const p5 = command.parseArgs(`add --every 10s Multi word prompt without quotes`);
	eq(p5.rest.slice(2).join(" "), "Multi word prompt without quotes", "unquoted prompt preserved");
}

// ---------- command handlers (with fake ctx) ----------
console.log("command: handlers");
{
	const dir = mkdtempSync(join(tmpdir(), "cron-cmd-"));
	const notes = [];
	const fakeCtx = {
		cwd: dir,
		ui: { notify: (m, t) => notes.push({ m: String(m), t }) },
	};
	try {
		// valid add
		await command.handleCron(`add --every 1m "Check swarm"`, fakeCtx);
		eq(store.loadJobs(dir).length, 1, "add persisted one job");
		ok(notes.at(-1).t === "info", "add notifies info");

		// list shows ordinal + preview
		await command.handleCron(`list`, fakeCtx);
		ok(notes.at(-1).m.includes("#1"), "list shows #1");

		// remove by ordinal
		await command.handleCron(`remove 1`, fakeCtx);
		eq(store.loadJobs(dir).length, 0, "remove by ordinal works");
		ok(notes.at(-1).t === "info", "remove notifies info");

		// remove last
		await command.handleCron(`add --every 5s "A"`, fakeCtx);
		await command.handleCron(`add --every 5s "B"`, fakeCtx);
		await command.handleCron(`remove last`, fakeCtx);
		const afterRemoveLast = store.loadJobs(dir);
		eq(afterRemoveLast.length, 1, "remove last leaves one");
		eq(afterRemoveLast[0].prompt, "A", "remove last removes the most recent (B)");

		// error: invalid interval
		await command.handleCron(`add --every 1d "X"`, fakeCtx);
		ok(notes.at(-1).t === "warning", "invalid interval warns");
		ok(notes.at(-1).m.includes("invalid --every"), "invalid interval message is clear");

		// error: missing prompt
		await command.handleCron(`add --every 5s`, fakeCtx);
		ok(notes.at(-1).t === "warning", "missing prompt warns");
		ok(notes.at(-1).m.toLowerCase().includes("prompt"), "missing prompt message mentions prompt");

		// error: missing --every
		await command.handleCron(`add "no flag"`, fakeCtx);
		ok(notes.at(-1).t === "warning", "missing --every warns");

		// error: unknown subcommand
		await command.handleCron(`frobnicate`, fakeCtx);
		ok(notes.at(-1).t === "warning", "unknown subcommand warns");

		// error: remove nonexistent ordinal
		await command.handleCron(`remove 99`, fakeCtx);
		ok(notes.at(-1).t === "warning", "remove nonexistent warns");

		// error: remove with no arg
		await command.handleCron(`remove`, fakeCtx);
		ok(notes.at(-1).t === "warning", "remove without arg warns");

		// empty input shows usage
		await command.handleCron(``, fakeCtx);
		ok(notes.at(-1).m.includes("Usage"), "empty input shows usage");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

// ---------- factory smoke (register command + hooks) ----------
console.log("index: factory smoke");
{
	const mod = await import(join(here, "index.ts"));
	const cmds = [];
	const hooks = {};
	const pi = {
		registerCommand: (name, opts) => { cmds.push(name); },
		on: (ev) => { hooks[ev] = true; },
	};
	mod.default(pi);
	ok(cmds.includes("cron"), "/cron command registered");
	ok(hooks["session_start"], "session_start hook registered");
	ok(hooks["session_shutdown"], "session_shutdown hook registered");
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
	console.error("FAILED:", failures);
	process.exit(1);
}
console.log("CRON TESTS PASS");
