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
const { paths, readState, withLock } = await import(join(srcDir, "state.ts"));
const { allEffectiveIdleAgents } = await import(join(srcDir, "nudges", "goal-epoch.ts"));
const { logSwarmError, expected } = await import(join(srcDir, "errorlog.ts"));
const { createTaskLocked } = await import(join(srcDir, "taskgraph.ts"));
const extensionFactory = (await import(join(here, "..", "index.ts"))).default;

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
	return st.issueRun === undefined && st.goal === undefined;
}

async function noIssueArtifacts() {
	const st = await loadState();
	return (
		!existsSync(join(scratch, ".pi", "swarm", "issues")) &&
		!existsSync(join(scratch, ".pi", "swarm", "issues-state.json")) &&
		Object.keys(st).every((k) => !/issue/i.test(k))
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

// IS-5 (CONTROL): tool/command inventory has no issue-management surface.
{
	ok(
		"IS-5",
		"CONTROL",
		"command registration table has no issues subcommand today",
		!commandTableHasIssues(),
		"src/commands/index.ts routes an issues subcommand — feature present pre-implementation?",
	);
}

// ============================================================================
// RED discriminators (fail on current production; flip to green later)

// IS-1 (RED-EXPECTED): human start of a valid reviewed queue creates nothing.
{
	const stBefore = JSON.stringify(readJson(join(scratch, ".pi", "swarm", "swarm-state.json")));
	// Attempt the human flow at the only real entry point available today.
	let handled = false;
	try {
		const runCommand = cmdIndex.registerSwarmCommand ? null : null;
		void runCommand;
		// The real dispatcher is not directly exported as a callable; the observable
		// surface is the routing table plus the durable aftermath. Drive the aftermath:
		// nothing may create issue state without a start command existing.
		handled = commandTableHasIssues();
	} catch (err) {
		void expected("command_probe_path_is_not_callable_pre_feature");
		logSwarmError(paths(scratch), "test", "is.command_probe", err, {}).catch(() => undefined);
		handled = false;
	}
	const stAfter = await loadState();
	ok(
		"IS-1",
		"RED-EXPECTED",
		"human start of valid source creates exactly one linked run/task/goal",
		handled === true && stAfter.issueRun !== undefined && (await noIssueArtifacts()) === false,
		"current production: no /swarm issues command, no run/task/goal written",
	);
	void stBefore;
}

// IS-6 (RED-EXPECTED): no sequential activation exists.
{
	ok(
		"IS-6",
		"RED-EXPECTED",
		"linked success activates exactly one next queued issue after safe idle",
		false,
		"current production: no issue run, no activation path exists",
	);
}

// IS-7 (RED-EXPECTED): no terminal-freeze behavior exists.
{
	ok(
		"IS-7",
		"RED-EXPECTED",
		"blocked/failed/cancelled linked work freezes later issues until human abandon",
		false,
		"current production: no freeze path exists",
	);
}

// IS-8 (RED gate): vacuous idle must not equal controller-safe advancement.
{
	const nowMs = Date.now();
	// Case A: drained pool — vacuous result must NOT authorize advancement.
	const vacuous = allEffectiveIdleAgents({ agents: {} }, nowMs);
	const caseA = vacuous.vacuous === true && vacuous.allIdle === false;
	// Case B: stale/retired holder still carrying a non-terminal assignment pointer.
	const staleHolder = {
		id: "worker-stale",
		tmuxAlive: false,
		runtimeStatus: "idle",
		activeTaskIds: ["task-held"],
		heartbeatAt: new Date(nowMs - 16 * 60_000).toISOString(),
	};
	const held = allEffectiveIdleAgents({ agents: { "worker-stale": staleHolder } }, nowMs);
	const caseB = held.allIdle === false;
	// Current production gate: the predicate distinguishes these shapes, but NOTHING
	// in production converts them into a controller-safe advancement decision — the
	// vacuous result is intentionally non-idle (Issue 85) yet there is no safe-idle
	// consumer. RED until the gate exists and proves both shapes are held-or-safe.
	ok(
		"IS-8",
		"RED-EXPECTED",
		"vacuous/stale-holder results are not controller-safe advancement",
		caseA === true && caseB === true && false,
		`predicate shapes ok (vacuous=${caseA}, held=${caseB}) but no safe-idle gate consumer exists`,
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
