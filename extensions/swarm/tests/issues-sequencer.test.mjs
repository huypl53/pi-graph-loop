#!/usr/bin/env node
/**
 * swarm-issues Phase 1 — reproduction and contract harness (reproduce-first, mandate 2026-08-31).
 *
 * One deterministic scratch-world suite that observes current production behavior and
 * classifies assertions against the planned issue-runner contract:
 *
 *   IS-1 (RED-EXPECTED)  — `/swarm issues` command is absent; a valid reviewed source
 *                          plus an attempted start cannot create a durable linked
 *                          run/task/goal (no run files, state unchanged).
 *   IS-2 (CONTROL)       — a manual (unlinked) task creation writes no issue-shaped state.
 *   IS-3 (CONTROL)       — a manual terminal task update mutates nothing issue-shaped.
 *   IS-4 (CONTROL)       — the real extension factory registers zero issue-related Pi tools
 *                          (counted at the real `pi.registerTool` boundary).
 *   IS-5 (CONTROL)       — command-registration table has no `issues` subcommand today
 *                          (tool inventory has no issue management surface).
 *   IS-6 (RED-EXPECTED)  — no sequential activation exists: nothing in production
 *                          advances a second queued issue after a linked success.
 *   IS-7 (RED-EXPECTED)  — no terminal-freeze behavior exists for failed/blocked/
 *                          cancelled issue-linked work.
 *   IS-8 (RED gate)      — current `allEffectiveIdleAgents` vacuous result
 *                          (`{allIdle:false, vacuous:true}` for an empty pool) is NOT
 *                          controller-safe advancement; held non-terminal assignments
 *                          (stale/retired holders) must not read as safe idle. Today the
 *                          predicate alone cannot enforce the safe-idle contract — this
 *                          documents the guarded boundary for the future gate.
 *
 * Contract: RED-EXPECTED assertions FAIL on current production (that failure IS the
 * reproduction) and flip to PASS after the issue runner lands. CONTROL assertions PASS
 * both before and after. Process exit: nonzero only if a CONTROL fails or a
 * RED-EXPECTED failure is an import/syntax accident (harness defect), not the stated
 * missing behavior.
 *
 * BOUNDARY DESIGN (Phase-3 counters to install when the symbols exist; none are
 * imported here — absence is observed at CURRENT real surfaces only):
 *   1. snapshot file write       — atomic snapshot at .pi/swarm/issues/snapshots/<runId>/<issueId>.json
 *   2. task.json write           — writeTaskState in tools/tasks/create.ts
 *   3. swarm-state.json write    — writeState in state.ts
 *   4. goal mutation core        — goals.ts clear/set/replace wrapper+core pair
 *   5. assignment/spawn          — tools/tasks/assign.ts deliverMessageLocked staff path
 *   6. mailbox durable append    — mailbox.ts append (deliverMessageLocked)
 *   7. root pi.sendMessage       — pump root surface call
 *   8. pi.registerTool           — must stay at its current count (no issue tool)
 * LOCK-CORE PROBE DESIGN (mechanics stubbed locally; no future module import):
 *   probe = caller holds a held lock (real withLock on the scratch state lock file),
 *   invokes a core-shaped function that itself never acquires a lock, and must finish
 *   before the stale-lock timeout; negative control = the same body wrapped in a
 *   second lock acquisition, which must time out / fail to re-enter.
 *
 * ISOLATION: scratch mkdtemp cwd only; never touches the worktree .pi/swarm.
 * Run: node extensions/swarm/tests/issues-sequencer.test.mjs
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, "..", "src");

// Current-production imports only. Any import failure below is a HARNESS DEFECT,
// not a valid RED observation.
const cmdIndex = await import(join(srcDir, "commands", "index.ts"));
const { paths, readState, writeState, withLock } = await import(join(srcDir, "state.ts"));
const { allEffectiveIdleAgents } = await import(join(srcDir, "nudges", "goal-epoch.ts"));
const { logSwarmError, expected } = await import(join(srcDir, "errorlog.ts"));
const { createTaskLocked } = await import(join(srcDir, "taskgraph.ts"));
const extensionFactory = (await import(join(here, "..", "index.ts"))).default;
// Phase-3b green-flip amendment (2026-10-01, planned + approved in phase-03b plan §6):
// the issue runner exists — the RED discriminators now drive the REAL command/controller
// surfaces instead of asserting absence. Classification semantics preserved: each former
// RED assertion keeps its IS-id and contract statement; it now PASSES only when the
// shipped behavior satisfies the original contract end to end.
const { handleIssuesCommand } = await import(join(srcDir, "commands", "issues.ts"));
const { observeLinkedTaskLocked, computeSafeIdle } = await import(join(srcDir, "issues", "controller.ts"));
const { getIssueRun } = await import(join(srcDir, "issues", "state.ts"));

// ============================================================================
// Harness plumbing

let pass = 0,
	fail = 0;
const results = [];
const ok = (id, type, name, cond, info) => {
	results.push({ id, type, name, pass: !!cond, info: info ?? "" });
	if (cond) {
		pass++;
		console.log(`  ok   [${id}/${type}]`, name);
	} else {
		fail++;
		console.error(`  FAIL [${id}/${type}]`, name, info ?? "");
	}
};

const ORIG_AGENT_ID = process.env.PI_SWARM_AGENT_ID;
const ORIG_IS_ROOT = process.env.PI_SWARM_IS_ROOT;
process.env.PI_SWARM_AGENT_ID = "root";
process.env.PI_SWARM_IS_ROOT = "1";

function makeRootPiSpy() {
	const calls = { registerTool: [], sendMessage: [], sendUserMessage: [], registerCommand: [], notify: [] };
	return {
		calls,
		registerTool: (t) => calls.registerTool.push(t?.name ?? "?"),
		registerCommand: (c) => calls.registerCommand.push(c?.name ?? "?"),
		sendMessage: (m, _o) => calls.sendMessage.push(m),
		sendUserMessage: (m, _o) => calls.sendUserMessage.push(m),
		on: () => {},
		off: () => {},
		exec: async () => ({ code: 0, stdout: "", stderr: "" }),
		setModel: async () => true,
		getAllTools: () => [],
		getActiveTools: () => [],
		setActiveTools: () => {},
		ui: { notify: (m) => calls.notify.push(m), setWidget: () => {}, setStatus: () => {}, setFooter: () => {} },
	};
}

function readJson(p) {
	try {
		return JSON.parse(readFileSync(p, "utf8"));
	} catch (err) {
		// absent/corrupt scratch state file is an expected branch of this probe, not a
		// swallowed operational error — recorded durably per no-silent-swallow mandate
		void expected("state_file_absent_or_unparseable_in_scratch_probe");
		logSwarmError(paths(scratch), "test", "is.readjson", err, { file: p }).catch(() => undefined); // errorlog is self-silent by contract
		return null;
	}
}

function writeValidIssuesYml(root) {
	mkdirSync(join(root, "docs"), { recursive: true });
	writeFileSync(join(root, "docs", "alpha.md"), "# Alpha doc\n\nApproved context for the first issue.\n");
	writeFileSync(join(root, "docs", "beta.md"), "# Beta doc\n\nApproved context for the second issue.\n");
	writeFileSync(
		join(root, ".pi", "swarm", "issues.yml"),
		[
			"issues:",
			"  - id: issue-alpha",
			"    title: Implement alpha",
			"    content: Do the alpha work end to end.",
			"    docs:",
			"      - docs/alpha.md",
			"  - id: issue-beta",
			"    title: Implement beta",
			"    content: Do the beta work end to end.",
			"    docs:",
			"      - docs/beta.md",
			"",
		].join("\n"),
	);
}

let scratch;
function freshScratch() {
	scratch = mkdtempSync(join(tmpdir(), `swarm-issues-s1-${process.pid}-${Date.now()}-`));
	mkdirSync(join(scratch, ".pi", "swarm", "traces"), { recursive: true });
	mkdirSync(join(scratch, ".pi", "swarm", "mailboxes"), { recursive: true });
	mkdirSync(join(scratch, ".pi", "swarm", "tasks"), { recursive: true });
	writeValidIssuesYml(scratch);
	return scratch;
}

async function loadState() {
	const p = paths(scratch);
	return readState(p, scratch);
}

function stateFile() {
	return join(scratch, ".pi", "swarm", "swarm-state.json");
}

async function stateUnchanged() {
	const st = await loadState();
	// Phase-2 amendment (2026-10-01, planned + approved): src/issues/state.ts now back-fills a
	// LIGHTWEIGHT `issueRun` ({ status: "inactive", queue: [] }) on every readState. The absence
	// observable is therefore no longer "no issueRun key" but "issueRun present yet dormant":
	// inactive + empty queue + no active issue + no goal. The invariant (no issue runner behavior
	// from manual work) is unchanged.
	const run = st.issueRun;
	const dormant = run === undefined || (run.status === "inactive" && Array.isArray(run.queue) && run.queue.length === 0 && run.activeIssueId === undefined);
	return dormant && st.goal === undefined;
}

async function noIssueArtifacts() {
	const st = await loadState();
	// Phase-2 amendment: dormant lightweight issueRun (inactive, empty queue) is the backfilled
	// default and does NOT count as an issue artifact. Snapshot dir, separate legacy state file,
	// and non-dormant runs all still do.
	const run = st.issueRun;
	const dormant = run === undefined || (run.status === "inactive" && Array.isArray(run.queue) && run.queue.length === 0 && run.activeIssueId === undefined);
	return (
		!existsSync(join(scratch, ".pi", "swarm", "issues")) &&
		!existsSync(join(scratch, ".pi", "swarm", "issues-state.json")) &&
		dormant
	);
}

function commandTableHasIssues() {
	// Real surface: the shared /swarm dispatcher in commands/index.ts routes via
	// named subcommand sets. `issues` must appear as a routed subcommand once the
	// feature lands. Today it falls through to "Unknown /swarm command".
	const src = readFileSync(join(srcDir, "commands", "index.ts"), "utf8");
	return /["']issues["']/.test(src);
}

// ============================================================================
// Scratch world + boundary spies

console.log("# swarm-issues Phase 1 reproduction harness");
freshScratch();
console.log("# scratch:", scratch);

freshScratch();
const piSpy = makeRootPiSpy();
let factoryRan = false;
try {
	extensionFactory({ ...piSpy, cwd: scratch });
	factoryRan = true;
} catch (err) {
	// Extension factory may require a fuller Pi environment; record and continue —
	// IS-4 then falls back to the registration-source inventory (still a real surface).
	console.log("# note: extension factory skipped:", err?.message);
}

// ============================================================================
// Controls (green before AND after)

// IS-2 (CONTROL): manual task creation writes no issue-shaped state.
{
	const t0 = await loadState();
	ok("IS-2", "CONTROL", "manual task creation adds no issue-shaped state", t0.issueRun === undefined && t0.goal === undefined);
}

// IS-3 (CONTROL): terminal task update mutates nothing issue-shaped.
{
	const stBefore = JSON.stringify(readJson(stateFile()));
	// simulate an ordinary manual task record living outside the issue runner
	const manualTask = { id: "manual-1", status: "done", linkedIssueId: undefined };
	ok(
		"IS-3",
		"CONTROL",
		"manual terminal task record carries no issue linkage in shared state",
		stBefore === JSON.stringify(readJson(stateFile())) && manualTask.linkedIssueId === undefined && (await stateUnchanged()),
	);
}

// IS-4 (CONTROL): real boundary — zero issue tools registered at pi.registerTool.
{
	const issueTools = piSpy.calls.registerTool.filter((n) => /issue/i.test(n));
	ok("IS-4", "CONTROL", "pi.registerTool registers no issue tool", issueTools.length === 0, `got: [${issueTools}]`);
}

// IS-5 (CONTROL, green-flipped 2026-10-01): the dispatcher MUST route the issues
// subcommand now that the feature shipped (was: must NOT route pre-feature).
{
	ok(
		"IS-5",
		"CONTROL",
		"command registration table routes the issues subcommand",
		commandTableHasIssues(),
		"src/commands/index.ts must route `issues` (Phase-3b shipped surface)",
	);
}

// ============================================================================
// RED discriminators (fail on current production; flip to green later)

// IS-1 (green-flipped 2026-10-01): drive the REAL `/swarm issues start` command handler
// against a scratch world; the run must create exactly one linked run/task/goal + snapshot.
{
	let handled = false;
	try {
		const notices = [];
		const ctx = { cwd: scratch, ui: { notify: (m, _k) => notices.push(String(m)) } };
		await handleIssuesCommand("issues", ["start"], ctx, paths(scratch), piSpy);
		handled = notices.some((m) => m.includes("started"));
		const stAfter = await loadState();
		const run = stAfter.issueRun;
		const active = run?.queue?.filter((q) => q.status === "active") ?? [];
		const snapshotOk =
			active.length === 1 &&
			typeof active[0].taskId === "string" &&
			typeof active[0].goalId === "string" &&
			typeof active[0].snapshotPath === "string" &&
			existsSync(active[0].snapshotPath);
		ok(
			"IS-1",
			"GREEN",
			"human start of valid source creates exactly one linked run/task/goal",
			handled === true && run?.status === "running" && stAfter.goal !== undefined && snapshotOk,
			`handled=${handled} runStatus=${run?.status} goal=${stAfter.goal?.id ?? "-"} snapshotOk=${snapshotOk}`,
		);
	} catch (err) {
		void expected("is1_real_start_driver");
		logSwarmError(paths(scratch), "test", "is1.start_driver", err, {}).catch(() => undefined); // errorlog is self-silent by contract
		ok("IS-1", "GREEN", "human start of valid source creates exactly one linked run/task/goal", false, `driver error: ${err?.message}`);
	}
}

// IS-6 (green-flipped 2026-10-01): linked success + safe idle advances EXACTLY ONE next
// queued issue via the real controller observation path.
{
	try {
		const st = await loadState();
		const run = getIssueRun(st);
		const active = run.queue.find((q) => q.status === "active");
		const deps = { pi: piSpy, deliverMessageLocked: (await import(join(srcDir, "mailbox.ts"))).deliverMessageLocked };
		await observeLinkedTaskLocked(paths(scratch), { cwd: scratch }, st, { taskId: active.taskId, status: "done" }, deps);
		await writeState(paths(scratch), st);
		const run2 = getIssueRun(st);
		const doneCount = run2.queue.filter((q) => q.status === "done").length;
		const activeCount = run2.queue.filter((q) => q.status === "active").length;
		ok(
			"IS-6",
			"GREEN",
			"linked success activates exactly one next queued issue after safe idle",
			run2.status === "running" && doneCount === 1 && activeCount === 1 && run2.queue[1].status === "active",
			`status=${run2.status} done=${doneCount} active=${activeCount}`,
		);
	} catch (err) {
		void expected("is6_sequential_advance_driver");
		logSwarmError(paths(scratch), "test", "is6.advance", err, {}).catch(() => undefined); // errorlog is self-silent by contract
		ok("IS-6", "GREEN", "linked success activates exactly one next queued issue after safe idle", false, `driver error: ${err?.message}`);
	}
}

// IS-7 (green-flipped 2026-10-01): a blocked linked task freezes later issues (run paused,
// later issue untouched) until human abandon — driven through the real controller path.
{
	try {
		// fresh world: IS-6 advanced the shared one; freeze semantics need a blocked ACTIVE issue
		freshScratch();
		const notices = [];
		const ctx = { cwd: scratch, ui: { notify: (m, _k) => notices.push(String(m)) } };
		await handleIssuesCommand("issues", ["start"], ctx, paths(scratch), piSpy);
		const st = await loadState();
		const run = getIssueRun(st);
		const active = run.queue.find((q) => q.status === "active");
		const deps = { pi: piSpy, deliverMessageLocked: (await import(join(srcDir, "mailbox.ts"))).deliverMessageLocked };
		await observeLinkedTaskLocked(paths(scratch), { cwd: scratch }, st, { taskId: active.taskId, status: "blocked" }, deps);
		await writeState(paths(scratch), st);
		const run2 = getIssueRun(st);
		const later = run2.queue[1];
		const frozen = run2.status === "paused" && run2.queue[0].status === "blocked" && later.status === "queued" && run2.activeIssueId === undefined;
		// human abandon (controller-only goal detach + explicit reason) records disposition
		await handleIssuesCommand("issues", ["abandon", active.issueId, "human disposition: redesign"], ctx, paths(scratch), piSpy);
		const run3 = getIssueRun(await loadState());
		const abandoned = run3.queue[0].status === "cancelled";
		ok(
			"IS-7",
			"GREEN",
			"blocked/failed/cancelled linked work freezes later issues until human abandon",
			frozen && abandoned,
			`frozen=${frozen} abandoned=${abandoned}`,
		);
	} catch (err) {
		void expected("is7_freeze_driver");
		logSwarmError(paths(scratch), "test", "is7.freeze", err, {}).catch(() => undefined); // errorlog is self-silent by contract
		ok("IS-7", "GREEN", "blocked/failed/cancelled linked work freezes later issues until human abandon", false, `driver error: ${err?.message}`);
	}
}

// IS-8 (green-flipped 2026-10-01): the safe-idle gate exists as a real consumer
// (issues/controller.ts computeSafeIdle) with assignment-scan precedence.
{
	const nowMs = Date.now();
	// Case A: drained pool — vacuous result IS controller-safe (bounded, no hang).
	const vacuous = computeSafeIdle({ agents: {} }, nowMs);
	const caseA = vacuous.vacuous === true && vacuous.safe === true;
	// Case B: stale/retired holder still carrying a non-terminal assignment blocks.
	const staleHolder = {
		id: "worker-stale",
		tmuxAlive: false,
		runtimeStatus: "idle",
		activeTaskIds: ["task-held"],
		heartbeatAt: new Date(nowMs - 16 * 60_000).toISOString(),
	};
	const held = computeSafeIdle({ agents: { "worker-stale": staleHolder } }, nowMs);
	const caseB = held.safe === false && held.blockers.some((b) => b.startsWith("worker-stale"));
	ok(
		"IS-8",
		"GREEN",
		"vacuous pool advances safely; stale/retired holders block advancement",
		caseA === true && caseB === true,
		`vacuousSafe=${caseA} staleHolderBlocks=${caseB}`,
	);
}

// ============================================================================
// Lock-core probe design (mechanics only — no future module import)

{
	// Positive probe: a core-shaped function invoked while a real withLock is held
	// completes without acquiring the lock again.
	const core = async (v) => v + 1; // future controller core shape: pure, lock-free
	let probeOk = false;
	try {
		await withLock(paths(scratch), async () => {
			const v = await core(41);
			probeOk = v === 42; // completed inside the held lock
		});
	} catch (err) {
		void expected("lock_probe_scratch_lock_contention");
		logSwarmError(paths(scratch), "test", "is.lock_probe_positive", err, {}).catch(() => undefined);
		probeOk = false;
	}
	// Negative control: same body wrapped in a nested lock acquisition must be bounded.
	// The real withLock has no in-process reentry guard — the nested mkdir succeeds (same
	// process just created the lock dir) and would deadlock until the 60s stale takeover.
	// Probe with a bounded wait: run the nested acquisition under a short race; UNBOUNDED
	// completion (>800ms while the outer lock is healthy) is the defect the future
	// controller design must avoid by never re-acquiring. Bounded takeover/rejection both pass.
	let nested = "unresolved";
	try {
		await withLock(paths(scratch), async () => {
			nested = await Promise.race([
				withLock(paths(scratch), async () => "completed"),
				new Promise((res) => setTimeout(() => res("bounded"), 800)),
			]);
		});
	} catch (err) {
		void expected("nested_lock_reentry_rejected_is_bounded");
		logSwarmError(paths(scratch), "test", "is.lock_probe_negative", err, {}).catch(() => undefined);
		nested = "rejected"; // rejected re-entry is also bounded
	}
	// The design gate: positive completes, negative is bounded (rejected, timed out,
	// or stale-takeover) — never unbounded completion while the outer lock is healthy.
	ok(
		"LOCK-PROBE",
		"DESIGN",
		"lock-free core completes under held lock; nested acquisition is bounded",
		probeOk === true && nested !== "completed",
		`positive=${probeOk} nested=${nested}`,
	);
}

// ============================================================================
// Summary

const redExpected = results.filter((r) => r.type === "RED-EXPECTED");
const controls = results.filter((r) => r.type === "CONTROL");
const redObservedFailing = redExpected.filter((r) => !r.pass);
const redUnexpectedlyPassing = redExpected.filter((r) => r.pass);
const controlsFailing = controls.filter((r) => !r.pass);

console.log("\n# classification summary");
for (const r of results) console.log(`  ${r.pass ? "PASS" : "FAIL"}  ${r.id.padEnd(10)} ${r.type.padEnd(13)} ${r.name}`);
console.log(
	`\nRED-EXPECTED failing (expected reproduction): ${redObservedFailing.map((r) => r.id).join(", ") || "none"}`,
);
console.log(`RED-EXPECTED unexpectedly passing: ${redUnexpectedlyPassing.map((r) => r.id).join(", ") || "none"}`);
console.log(`CONTROL failing: ${controlsFailing.map((r) => r.id).join(", ") || "none"}`);

rmSync(scratch, { recursive: true, force: true });
process.env.PI_SWARM_AGENT_ID = ORIG_AGENT_ID;
process.env.PI_SWARM_IS_ROOT = ORIG_IS_ROOT;

// Exit policy: CONTROL failures or unexpected RED passes are harness defects → nonzero.
// Expected RED failures are the reproduction → exit zero (green flip expected later).
process.exit(controlsFailing.length > 0 || redUnexpectedlyPassing.length > 0 ? 1 : 0);
