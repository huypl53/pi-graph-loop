#!/usr/bin/env node
// scripts/tests/runner-parallel-overlap.test.mjs — RED-first regression net for the
// parallelize-test-runner issue (task-202610041611-issue-parallelize-test-r).
//
// What it proves, at the REAL runner boundary (run-suites.mjs invoked as a child process,
// suites as real child processes — nothing mocked):
//
//   A1 (RED on sequential HEAD): two deliberately slow scratch suites finish in
//       < sum(their durations) − 500ms under `--parallel 2` — true concurrency, not
//       start-then-await serialization.
//   A2 (RED on sequential HEAD): peak concurrent suites under `--parallel 2` is 2
//       (bounded pool actually overlaps); under no flag (sequential) it is 1.
//   A3 (standing, pre- AND post-fix): output contract survives — PASS rows, footer
//       "2 passed, 0 failed", exit 0; a failing suite yields a FAIL row + exit 1.
//   A4 (post-fix, rework-strengthened): slot RE-USE — three suites at `--parallel 2` with
//       both initial slots deterministically held (hold-1 beyond --timeout, hold-2 until it
//       sees queued-fast's start marker); the queued third suite must START only after the
//       timeout freed hold-1's slot, RUN CONCURRENTLY with hold-2 (marker-proven overlap),
//       and PASS. Proves slot re-use, not just parallel start.
//   A5 (post-fix, rework-strengthened): serialization group honored — per-suite INTERVAL
//       probes (independent active-markers with locked start/end records): the two
//       same-group members' active intervals NEVER overlap each other, while the ungrouped
//       suite's interval DOES overlap a group member (aggregate peak==2 alone is vacuous
//       for group semantics).
//
// Determinism: marker files + a locked interval log replace timing sleeps wherever the
// mechanism allows; the only irreducible sleeps are hold-1 (must exceed --timeout for the
// kill path under test) and the A1/A2 overlap windows.
//
// Run: node scripts/tests/runner-parallel-overlap.test.mjs   (or `npm run test:runner`)
// Deterministic + offline (no network, no provider keys).
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, openSync, closeSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const runner = join(repoRoot, "scripts", "run-suites.mjs");

let pass = 0;
let failCount = 0;
const ok = (name, cond, info = "") => {
	if (cond) {
		pass++;
		console.log("  ok  ", name);
	} else {
		failCount++;
		console.error("  FAIL", name, info);
	}
};
// Loud structural failure (choreography broken): record a failed assertion and report.
const fail = (name, info = "") => {
	failCount++;
	console.error("  FAIL", name, info);
};

const SLOW_MS = 1500;
const RED_MARGIN = 500; // assertion A1: wall < slowA + slowB - RED_MARGIN

// --- shared suite-side helpers (injected into scratch suites) ---

// Locked read-modify-write on a JSON file (O_EXCL lock with bounded retry).
const LOCK_RW_SNIPPET = `
async function lockedRw(file, fn) {
	const lock = file + ".lock";
	const busy = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
	for (let attempt = 0; attempt < 2000; attempt++) {
		let fd = -1;
		try {
			fd = openSync(lock, "wx");
		} catch (err) {
			// EEXPECTED(err, "EEXIST"): O_EXCL lock — EEXIST means another suite/probe holder
			// owns the lock right now; backing off and retrying IS the locking protocol.
			// Any other error is a real failure and must surface.
			if (err?.code !== "EEXIST") throw err;
			busy(5);
			continue;
		}
		try {
			const cur = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined;
			const next = fn(cur);
			writeFileSync(file, JSON.stringify(next));
		} finally {
			closeSync(fd);
			unlinkSync(lock);
		}
		return;
	}
	throw new Error("lock timeout: " + file);
}
`;

// Peak-concurrency probe snippet: bump now/peak, hold, drop.
const PROBE_SNIPPET = `
import { readFileSync, writeFileSync, existsSync, openSync, closeSync, unlinkSync } from "node:fs";
const probe = process.env.RUNNER_PROBE_FILE;
if (!probe) {
	console.error("SKIP: RUNNER_PROBE_FILE not set (probe suites only run under the runner-overlap harness)");
	process.exit(0);
}
${LOCK_RW_SNIPPET}
await lockedRw(probe, (cur) => {
	const c = cur ?? { now: 0, peak: 0 };
	c.now += 1;
	c.peak = Math.max(c.peak, c.now);
	return c;
});
await new Promise((r) => setTimeout(r, Number(process.env.RUNNER_SLOW_MS)));
await lockedRw(probe, (cur) => {
	cur.now -= 1;
	return cur;
});
`;

// Interval-log snippet: record start/end markers for THIS suite into a shared JSONL.
// env: RUNNER_INTERVAL_LOG (shared file); the suite NAME is baked into the snippet body
// (each scratch suite gets its own literal — no per-suite env plumbing).
const INTERVAL_SNIPPET = (suiteName) => `
import { readFileSync, writeFileSync, existsSync, openSync, closeSync, unlinkSync, appendFileSync } from "node:fs";
const ilog = process.env.RUNNER_INTERVAL_LOG;
const sname = ${JSON.stringify(suiteName)};
if (!ilog) {
	console.error("SKIP: RUNNER_INTERVAL_LOG not set (probe suites only run under the runner-overlap harness)");
	process.exit(0);
}
${LOCK_RW_SNIPPET}
async function mark(phase) {
	const line = JSON.stringify({ suite: sname, phase, ts: Date.now() }) + "\\n";
	for (let attempt = 0; attempt < 2000; attempt++) {
		let fd = -1;
		try {
			fd = openSync(ilog + ".lock", "wx");
		} catch (err) {
			// EEXPECTED(err, "EEXIST"): O_EXCL lock on the shared interval log — EEXIST means
			// another suite is appending right now; back off and retry (locking protocol).
			// Any other error is a real failure and must surface.
			if (err?.code !== "EEXIST") throw err;
			await new Promise((r) => setTimeout(r, 3));
			continue;
		}
		try {
			appendFileSync(ilog, line);
		} finally {
			closeSync(fd);
			unlinkSync(ilog + ".lock");
		}
		return;
	}
	throw new Error("interval log lock timeout");
}
await mark("start");
`;

const INTERVAL_END_SNIPPET = `
	await mark("end");
`;

// Wait-for-marker snippet: poll until the BAKED marker path exists (or deadline), then
// continue. The path is baked per suite (env is shared across a run's suites, so per-suite
// markers must be literals, not env).
const WAIT_MARKER_SNIPPET = (markerPath) => `
const waited = await (async () => {
	const deadline = Date.now() + Number(process.env.RUNNER_WAIT_DEADLINE_MS);
	while (Date.now() < deadline && !existsSync(${JSON.stringify(markerPath)})) {
		await new Promise((r) => setTimeout(r, 20));
	}
	return existsSync(${JSON.stringify(markerPath)});
})();
if (!waited) console.error("WAIT_MARKER_TIMEOUT " + ${JSON.stringify(markerPath)});
`;

function buildSuite({ name, probe = false, interval = false, sleepMs = null, waitMarker = null, writeMarker = null, exitCode = 0 }) {
	let body = "";
	if (interval) body += INTERVAL_SNIPPET(name);
	if (probe) body += PROBE_SNIPPET.replace("Number(process.env.RUNNER_SLOW_MS)", String(sleepMs ?? SLOW_MS));
	if (waitMarker) body += WAIT_MARKER_SNIPPET(waitMarker);
	if (sleepMs !== null && !probe)
		body += `await new Promise((r) => setTimeout(r, ${sleepMs}));
`;
	if (writeMarker)
		body += `writeFileSync(${JSON.stringify(writeMarker)}, "1");
`;
	if (interval) body += INTERVAL_END_SNIPPET;
	body += `process.exit(${exitCode});
`;
	// Interval mode carries its own imports; probe mode too.
	return body;
}

function writeSuite(testsDir, name, opts) {
	// Bake the BARE suite name (no extension) as the interval-log marker key.
	const bare = name.replace(/\.test\.mjs$/, "");
	writeFileSync(join(testsDir, name), buildSuite({ name: bare, ...opts }));
}

function runRunner({ dir, extraArgs = [], timeoutMs = 60_000, env }) {
	return spawnSync(process.execPath, [runner, "--dir", dir, ...extraArgs], {
		cwd: repoRoot,
		encoding: "utf8",
		timeout: timeoutMs,
		env,
	});
}

function readPeak(probeFile) {
	if (!existsSync(probeFile)) return { now: 0, peak: 0 };
	return JSON.parse(readFileSync(probeFile, "utf8"));
}

function readIntervals(ilog) {
	if (!existsSync(ilog)) return [];
	return readFileSync(ilog, "utf8")
		.split("\n")
		.filter((l) => l.trim())
		.map((l) => JSON.parse(l));
}

function intervalsOf(events, suite) {
	const starts = events.filter((e) => e.suite === suite && e.phase === "start").map((e) => e.ts);
	const ends = events.filter((e) => e.suite === suite && e.phase === "end").map((e) => e.ts);
	// Killed suites never record "end" — the interval is still real up to the kill.
	if (!starts.length) return null;
	return { start: Math.min(...starts), end: ends.length ? Math.max(...ends) : null };
}

// ===== A1 + A2: overlap + peak concurrency under --parallel 2 =====
{
	const scratch = mkdtempSync(join(tmpdir(), "runner-overlap-par-"));
	mkdirSync(join(scratch, "tests"), { recursive: true });
	const testsDir = join(scratch, "tests");
	const probe = join(scratch, "probe.json");
	writeSuite(testsDir, "slow-a.test.mjs", { probe: true });
	writeSuite(testsDir, "slow-b.test.mjs", { probe: true });

	const t0 = Date.now();
	const r = runRunner({
		dir: testsDir,
		extraArgs: ["--parallel", "2"],
		env: { ...process.env, RUNNER_PROBE_FILE: probe },
	});
	const wall = Date.now() - t0;
	const sum = 2 * SLOW_MS;

	ok(
		`A1 RED-target: parallel wall ${wall}ms < sum ${sum}ms - ${RED_MARGIN}ms (two slow suites overlap)`,
		r.status === 0 && wall < sum - RED_MARGIN,
		`exit=${r.status} wall=${wall} stdout=${(r.stdout || "").slice(-200)}`,
	);
	const pk = readPeak(probe);
	ok(`A2 RED-target: peak concurrency under --parallel 2 is 2 (got ${pk.peak})`, pk.peak === 2, `probe=${JSON.stringify(pk)}`);
	ok(
		"A3 contract (parallel): PASS rows + footer + exit 0",
		/pass\s+\d+\s+ms .*slow-a\.test\.mjs/i.test(r.stdout || "") &&
			/pass\s+\d+\s+ms .*slow-b\.test\.mjs/i.test(r.stdout || "") &&
			/2 passed, 0 failed/.test(r.stdout || "") &&
			r.status === 0,
		(r.stdout || "").slice(-300),
	);
	rmSync(scratch, { recursive: true, force: true });
}

// ===== A2b: sequential leg — peak stays 1 (contract: no flag = old behavior) =====
{
	const scratch = mkdtempSync(join(tmpdir(), "runner-overlap-seq-"));
	mkdirSync(join(scratch, "tests"), { recursive: true });
	const testsDir = join(scratch, "tests");
	const probe = join(scratch, "probe.json");
	writeSuite(testsDir, "slow-a.test.mjs", { probe: true });
	writeSuite(testsDir, "slow-b.test.mjs", { probe: true });
	const t0 = Date.now();
	const r = runRunner({ dir: testsDir, env: { ...process.env, RUNNER_PROBE_FILE: probe } });
	const wall = Date.now() - t0;
	const pk = readPeak(probe);
	ok("A2b sequential (no flag): peak concurrency is 1", pk.peak === 1, `probe=${JSON.stringify(pk)}`);
	ok("A2b sequential: wall >= sum (no overlap on the default path)", r.status === 0 && wall >= 2 * SLOW_MS - 100, `wall=${wall}`);
	rmSync(scratch, { recursive: true, force: true });
}

// ===== A3b: gate contract under parallel — failing suite → FAIL row + exit 1 =====
{
	const scratch = mkdtempSync(join(tmpdir(), "runner-overlap-fail-"));
	mkdirSync(join(scratch, "tests"), { recursive: true });
	const testsDir = join(scratch, "tests");
	writeSuite(testsDir, "slow-a.test.mjs", { sleepMs: SLOW_MS });
	writeSuite(testsDir, "bozo.test.mjs", { sleepMs: 50, exitCode: 1 });
	const r = runRunner({ dir: testsDir, extraArgs: ["--parallel", "2"] });
	ok(
		"A3b gate contract: failing suite → FAIL row + exit 1 under parallel",
		r.status === 1 && /FAIL\s+\d+\s+ms .*bozo\.test\.mjs/.test(r.stdout || "") && /1 failed/.test(r.stdout || ""),
		`exit=${r.status} tail=${(r.stdout || "").slice(-200)}`,
	);
	rmSync(scratch, { recursive: true, force: true });
}

// ===== A4 (rework-strengthened): slot RE-USE — two legs =====
// Constraint discovered while strengthening: the runner's --timeout applies to EVERY suite,
// so NO suite can outlive it — a hold cannot both span the timeout AND overlap the queued
// suite (it gets killed at T too). Slot re-use is therefore proven in two complementary,
// fully marker-driven legs (no timing races):
//
//   A4-timeout: three suites at --parallel 2, --timeout T. Both initial slots are held by
//     suites that never finish on their own (aa-hold-1 sleeps past T; ab-hold-2 waits for
//     zz-queued's start marker on a long deadline) — the runner kills BOTH at T (two
//     TIMEOUT rows) and zz-queued (sorts last) starts only at/after T and PASSes. Proves
//     timeout-freed slots are re-used for queued work.
//
//   A4-reuse: the stronger semantic, choreographed entirely by markers. The test spawns the
//     runner ASYNC and releases holds mid-run: aa-hold-1 + ab-hold-2 take both slots and
//     wait on release markers; once the interval log shows BOTH holds active (both slots
//     occupied), the test writes release-1 → aa-hold-1 exits → its slot frees; zz-queued
//     (sorts last) starts in that freed slot WHILE ab-hold-2 still holds the other; the
//     test then writes release-2. Assert: zz-queued's interval OVERLAPS ab-hold-2's
//     interval (re-use concurrent with a resident slot) and aggregate peak never exceeds 2.

// --- A4-timeout leg ---
{
	const scratch = mkdtempSync(join(tmpdir(), "runner-overlap-reuse-"));
	mkdirSync(join(scratch, "tests"), { recursive: true });
	const testsDir = join(scratch, "tests");
	const ilog = join(scratch, "intervals.jsonl");
	const queuedStartMarker = join(scratch, "queued-started.marker");
	const TIMEOUT_MS = 2000;
	const suiteEnv = {
		...process.env,
		RUNNER_INTERVAL_LOG: ilog,
		RUNNER_WAIT_DEADLINE_MS: "60000",
		RUNNER_WAIT_MARKER: queuedStartMarker,
	};
	// Alphabetical: aa-hold-1 (slot 1, killed at T), ab-hold-2 (slot 2, killed at T),
	// zz-queued (queued; starts only when the pool re-uses a freed slot).
	writeSuite(testsDir, "aa-hold-1.test.mjs", { interval: true, sleepMs: 60_000 });
	writeSuite(testsDir, "ab-hold-2.test.mjs", { interval: true, waitMarker: queuedStartMarker });
	writeSuite(testsDir, "zz-queued.test.mjs", { interval: true, writeMarker: queuedStartMarker, sleepMs: 300 });
	const t0 = Date.now();
	const r = runRunner({ dir: testsDir, extraArgs: ["--parallel", "2", "--timeout", String(TIMEOUT_MS)], env: suiteEnv });
	const events = readIntervals(ilog);
	const ivQueued = intervalsOf(events, "zz-queued");
	const ivHold1 = intervalsOf(events, "aa-hold-1");
	ok(
		"A4-timeout a: queued third suite STARTED at/after the timeout horizon (T - 300ms skew) and PASSed",
		!!ivQueued && ivQueued.start >= t0 + TIMEOUT_MS - 300 && /pass\s+\d+\s+ms .*zz-queued\.test\.mjs/i.test(r.stdout || ""),
		`queued=${JSON.stringify(ivQueued)} t0=+${ivQueued ? ivQueued.start - t0 : "?"}ms exit=${r.status}`,
	);
	ok(
		"A4-timeout b: both slot holders were killed at the timeout (two TIMEOUT rows; hold-1 left no end marker)",
		r.status === 1 &&
			/TIMEOUT\s+\d+\s+ms .*aa-hold-1\.test\.mjs/.test(r.stdout || "") &&
			/TIMEOUT\s+\d+\s+ms .*ab-hold-2\.test\.mjs/.test(r.stdout || "") &&
			!events.some((e) => e.suite === "aa-hold-1" && e.phase === "end"),
		`exit=${r.status} tail=${(r.stdout || "").slice(-300)}`,
	);
	ok(
		"A4-timeout c: both holds were resident BEFORE the queued suite started (slots were genuinely occupied)",
		!!ivHold1 && !!ivQueued && ivHold1.start < ivQueued.start,
		`hold1=${JSON.stringify(ivHold1)} queued=${JSON.stringify(ivQueued)}`,
	);
	rmSync(scratch, { recursive: true, force: true });
}

// --- A4-reuse leg (marker-choreographed, async runner) ---
{
	const scratch = mkdtempSync(join(tmpdir(), "runner-overlap-reuse2-"));
	mkdirSync(join(scratch, "tests"), { recursive: true });
	const testsDir = join(scratch, "tests");
	const ilog = join(scratch, "intervals.jsonl");
	const release1 = join(scratch, "release-1.marker");
	const release2 = join(scratch, "release-2.marker");
	const suiteEnv = {
		...process.env,
		RUNNER_INTERVAL_LOG: ilog,
		RUNNER_WAIT_DEADLINE_MS: "30000",
	};
	// Each hold waits on ITS OWN release marker, baked into its body: hold-1 → release-1,
	// hold-2 → release-2. Choreography: verify both slots occupied from the interval log,
	// free slot 1, wait for the queued suite to start, THEN free slot 2.
	writeSuite(testsDir, "aa-hold-1.test.mjs", { interval: true, waitMarker: release1 });
	writeSuite(testsDir, "ab-hold-2.test.mjs", { interval: true, waitMarker: release2 });
	writeSuite(testsDir, "zz-queued.test.mjs", { interval: true, sleepMs: 300 });
	const child = spawn(process.execPath, [runner, "--dir", testsDir, "--parallel", "2"], {
		cwd: repoRoot,
		env: suiteEnv,
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	child.stdout.on("data", (d) => (stdout += d));
	child.stderr.on("data", (d) => (stdout += d));

	// Choreography (marker-driven, bounded by a 30s watchdog):
	async function waitFor(pred, what) {
		const deadline = Date.now() + 30_000;
		while (Date.now() < deadline) {
			if (pred()) return true;
			await new Promise((r2) => setTimeout(r2, 25));
		}
		console.error(`CHOREO TIMEOUT: ${what}`);
		return false;
	}
	const bothActive = await waitFor(() => {
		const ev = readIntervals(ilog);
		const h1 = intervalsOf(ev, "aa-hold-1");
		const h2 = intervalsOf(ev, "ab-hold-2");
		return !!(h1 && h2); // both started; ends not required yet
	}, "both holds active");
	// Load-bearing prelude: without both slots verifiably occupied (awaited), the re-use
	// claim would be vacuous (release-1 could free a slot never proven held). Abort the
	// leg loudly rather than proceed on an unproven prelude.
	if (!bothActive) {
		fail(
			"A4-reuse choreography: both holds FAILED to activate before release-1",
			`events=${JSON.stringify(readIntervals(ilog)).slice(0, 400)}`,
		);
	}
	if (bothActive) {
		writeFileSync(release1, "1"); // free slot 1 → zz-queued may start
	}
	const queuedStarted = bothActive
		? await waitFor(() => readIntervals(ilog).some((e) => e.suite === "zz-queued" && e.phase === "start"), "zz-queued start")
		: false;
	if (bothActive && !queuedStarted) {
		fail(
			"A4-reuse choreography: zz-queued never started after release-1",
			`events=${JSON.stringify(readIntervals(ilog)).slice(0, 400)}`,
		);
	}
	const choreographyOk = bothActive && queuedStarted;
	if (!choreographyOk) {
		// Broken prelude: kill the runner so scratch suites cannot leak, and skip the
		// dependent assertions (they'd record misleading failures on an unproven prelude).
		try {
			process.kill(-child.pid, "SIGKILL");
		} catch (err) {
			// EEXPECTED(err, "ESRCH"): the runner process group is already gone (choreography
			// watchdog fired after the child exited on its own). Anything else surfaces.
			if (err?.code !== "ESRCH") throw err;
		}
	}
	// Give queued a beat to be verifiably INSIDE its interval while hold-2 still waits.
	await new Promise((r2) => setTimeout(r2, 300));
	const beforeRelease2 = Date.now();
	if (choreographyOk) {
		writeFileSync(release2, "1"); // then free slot 2
	}
	const exitCode = await new Promise((res) => {
		const t = setTimeout(() => res(null), 30_000);
		child.on("close", (code) => {
			clearTimeout(t);
			res(code);
		});
	});

	const events = readIntervals(ilog);
	const ivQueued = intervalsOf(events, "zz-queued");
	const ivHold2 = intervalsOf(events, "ab-hold-2");
	ok(
		"A4-reuse choreography: both holds activated (awaited, load-bearing), queued started after release-1",
		bothActive === true && queuedStarted === true,
		`bothActive=${bothActive} queuedStarted=${queuedStarted}`,
	);
	if (choreographyOk) {
		ok(
			"A4-reuse CORE: queued started while hold-2 was STILL resident (release-2 written only after) — freed slot re-used against a held slot",
			!!ivQueued && ivQueued.start < beforeRelease2 && !!ivHold2,
			`queued=${JSON.stringify(ivQueued)} hold2=${JSON.stringify(ivHold2)} beforeRelease2=${beforeRelease2}`,
		);
		ok(
			"A4-reuse overlap: queued's recorded interval OVERLAPPED ab-hold-2's recorded interval",
			!!ivQueued && !!ivHold2 && ivHold2.end !== null && ivQueued.start < ivHold2.end && ivHold2.start < ivQueued.end,
			`queued=${JSON.stringify(ivQueued)} hold2=${JSON.stringify(ivHold2)}`,
		);
		const starts = events.filter((e) => e.phase === "start");
		const ends = events.filter((e) => e.phase === "end");
		ok(
			"A4-reuse bound: exactly 3 suites ran, all PASSed, exit 0 (pool width never exceeded by design assertions A1/A2)",
			exitCode === 0 && starts.length === 3 && ends.length === 3 && /3 passed, 0 failed/.test(stdout || ""),
			`exit=${exitCode} starts=${starts.length} ends=${ends.length} tail=${(stdout || "").slice(-200)}`,
		);
	}
	rmSync(scratch, { recursive: true, force: true });
}

// ===== A5 (rework-strengthened): serialization group honored — INTERVAL semantics =====
// Three suites: ga-one + ga-two in a group (max-1-at-a-time lane), zz-free ungrouped.
// Interval assertions (stronger than aggregate peak):
//   i)  ga-one's and ga-two's active intervals NEVER overlap each other;
//   ii) zz-free's interval DOES overlap a group member's interval (the group lane did not
//       serialize the whole run — group members still share the pool with outsiders);
//   iii) each group member recorded exactly one start and one end (no lost markers).
{
	const scratch = mkdtempSync(join(tmpdir(), "runner-overlap-group-"));
	mkdirSync(join(scratch, "tests"), { recursive: true });
	const testsDir = join(scratch, "tests");
	const ilog = join(scratch, "intervals.jsonl");
	writeSuite(testsDir, "ga-one.test.mjs", { interval: true, sleepMs: SLOW_MS });
	writeSuite(testsDir, "ga-two.test.mjs", { interval: true, sleepMs: SLOW_MS });
	writeSuite(testsDir, "zz-free.test.mjs", { interval: true, sleepMs: SLOW_MS });
	// Group config rides env for the scratch dir (runner reads RUNNER_SERIALIZATION_GROUPS
	// as a JSON map of group → filename substrings; production groups are the built-in table).
	const r = spawnSync(process.execPath, [runner, "--dir", testsDir, "--parallel", "2"], {
		cwd: repoRoot,
		encoding: "utf8",
		timeout: 60_000,
		env: {
			...process.env,
			RUNNER_INTERVAL_LOG: ilog,
			RUNNER_SERIALIZATION_GROUPS: JSON.stringify({ "test-group": ["ga-one", "ga-two"] }),
		},
	});
	const events = readIntervals(ilog);
	const iv1 = intervalsOf(events, "ga-one");
	const iv2 = intervalsOf(events, "ga-two");
	const ivFree = intervalsOf(events, "zz-free");

	// Per-suite interval needs the suite NAME — the snippet reads RUNNER_SUITE_NAME, but all
	// suites share one env here. The runner does not set it, so derive the name from the
	// interval-log ORDER is fragile; instead give each suite its own name via a distinct
	// mechanism: name is baked per suite by the writeSuite wrapper below.
	ok(
		"A5 harness: interval log captured all three suites",
		[iv1, iv2, ivFree].every(Boolean) || events.length >= 6,
		`events=${JSON.stringify(events).slice(0, 400)}`,
	);

	if (iv1 && iv2) {
		const disjoint = iv1.end <= iv2.start || iv2.end <= iv1.start;
		ok(
			"A5i group members' intervals NEVER overlap (max-1-at-a-time lane)",
			disjoint,
			`ga-one=${JSON.stringify(iv1)} ga-two=${JSON.stringify(iv2)}`,
		);
	}
	if (ivFree && (iv1 || iv2)) {
		const overlaps = (a, b) => a && b && a.start < b.end && b.start < a.end;
		const overlappedSomeone = overlaps(ivFree, iv1) || overlaps(ivFree, iv2);
		ok(
			"A5ii ungrouped suite's interval OVERLAPS a group member (group lane still shares the pool)",
			overlappedSomeone,
			`zz-free=${JSON.stringify(ivFree)} ga-one=${JSON.stringify(iv1)} ga-two=${JSON.stringify(iv2)}`,
		);
	}
	const markerCounts = {};
	for (const e of events) markerCounts[`${e.suite}:${e.phase}`] = (markerCounts[`${e.suite}:${e.phase}`] ?? 0) + 1;
	ok(
		"A5iii each suite recorded exactly one start + one end marker",
		Object.values(markerCounts).every((n) => n === 1) && Object.keys(markerCounts).length === 6 && r.status === 0,
		`counts=${JSON.stringify(markerCounts)}`,
	);
	rmSync(scratch, { recursive: true, force: true });
}

// ===== A6 (round-2 item 3): SIGINT/SIGTERM process-group cleanup =====
// Contract under test (implementation report + round-2 directive): mid-run SIGINT/SIGTERM →
// (i) runner exits 130, (ii) no orphaned scratch suites survive the runner (process-group
// kill), (iii) partial results table still printed, (iv) stderr banner names the signal and
// the suites killed.
// RED→GREEN history (2026-10-04/05, evidence in fix-report): the exit-130 assertion was
// authored FIRST and observed RED against the unfixed runner — shutdown()'s setTimeout(130)
// always lost the race to the normal completion path (child close handlers → TIMEOUT rows →
// footer → process.exit(1) ≤50ms after the group kill; the 130 timer needed 500ms). Root
// approved the ~4-line fix (sigintSeen hoisted to module scope; final exit
// sigintSeen ? 130 : failed?1:0); A6e has been GREEN since and remains the regression net.
// The orphan check is non-vacuous: negative control (SIGKILL the runner, bypassing handlers)
// leaves orphans PRESENT.
// Round-3: refactored into runInterruptLeg(signal, fullMatrix) so the MINIMAL SIGTERM leg
// (root-scoped: banner + exit 130 + zero orphans only — the kill-signal forwarding is the
// only runner difference, and the exit-override machinery is signal-agnostic, already proven
// by the SIGINT matrix) reuses the exact same choreography without duplicating it.
async function runInterruptLeg(SIGNAL, fullMatrix) {
	const scratch = mkdtempSync(join(tmpdir(), `runner-${SIGNAL.toLowerCase()}-`));
	mkdirSync(join(scratch, "tests"), { recursive: true });
	const testsDir = join(scratch, "tests");
	const probe = join(scratch, "probe.json");
	// Both suites poll the probe (locked RMW) every 25ms until their 20s deadline — they stay
	// alive until the runner's shutdown kill removes them, giving the signal a real target.
	const suiteBody = `
import { readFileSync, writeFileSync, existsSync, openSync, closeSync, unlinkSync } from "node:fs";
const probe = process.env.RUNNER_PROBE_FILE;
if (!probe) {
	console.error("SKIP: RUNNER_PROBE_FILE not set (probe suites only run under the runner-overlap harness)");
	process.exit(0);
}
${LOCK_RW_SNIPPET}
const deadline = Date.now() + 20000;
while (Date.now() < deadline) {
	await lockedRw(probe, (c) => {
		const v = c ?? { now: 0, peak: 0 };
		v.now += 1;
		v.peak = Math.max(v.peak, v.now);
		return v;
	});
	await new Promise((r) => setTimeout(r, 25));
	await lockedRw(probe, (c) => {
		c.now -= 1;
		return c;
	});
}
process.exit(0);
`;
	writeFileSync(join(testsDir, "sig-a.test.mjs"), suiteBody);
	writeFileSync(join(testsDir, "sig-b.test.mjs"), suiteBody);

	const child = spawn(process.execPath, [runner, "--dir", testsDir, "--parallel", "2"], {
		cwd: repoRoot,
		env: { ...process.env, RUNNER_PROBE_FILE: probe },
		stdio: ["ignore", "pipe", "pipe"],
	});
	let out = "";
	child.stdout.on("data", (d) => (out += d));
	child.stderr.on("data", (d) => (out += d));

	// Wait until BOTH suites are observably running (probe peak === 2) before signalling —
	// the kill must land mid-run, not during startup.
	let peak = 0;
	const waitDeadline = Date.now() + 15000;
	while (Date.now() < waitDeadline) {
		try {
			peak = JSON.parse(readFileSync(probe, "utf8")).peak;
		} catch (err) {
			// EEXPECTED(err, "ENOENT|SyntaxError"): the probe file may not exist yet (suites
			// create it on their first locked RMW) and the test reads WITHOUT the lock, so a
			// torn mid-write read (SyntaxError) is also possible. Both are retried on the next
			// 25ms poll — anything else is a real failure and must surface.
			if (err?.code !== "ENOENT" && !(err instanceof SyntaxError)) throw err;
			peak = 0;
		}
		if (peak === 2) break;
		await new Promise((r) => setTimeout(r, 25));
	}
	child.kill(SIGNAL);
	const exitCode = await new Promise((res) => {
		const t = setTimeout(() => res(null), 15000);
		child.on("close", (code) => {
			clearTimeout(t);
			res(code);
		});
	});

	// Give the OS a beat to reap the group, then check for orphans by exact path match.
	await new Promise((r) => setTimeout(r, 300));
	let orphanPids = "";
	try {
		orphanPids = spawnSync("pgrep", ["-f", testsDir], { encoding: "utf8" }).stdout || "";
	} catch (err) {
		// EEXPECTED(err, "ENOENT"): pgrep binary missing. This is NOT treated as "no orphans"
		// — a broken orphan check must not pass silently, so the sentinel forces A6b to fail
		// loudly instead. Any other spawnSync error surfaces.
		if (err?.code !== "ENOENT") throw err;
		orphanPids = "PGREP-UNAVAILABLE";
	}
	const tag = fullMatrix ? "A6" : "A7";
	// Reviewer finding (e2d2f9e follow-up): the peak precondition must hold for BOTH legs —
	// a signal fired before suites start yields banner "killing 0" + exit 130 + no orphans
	// and would otherwise pass A7 vacuously. Fail this leg loudly instead.
	ok(`${tag}a mid-run ${SIGNAL} lands on both suites (probe peak === 2 before signal)`, peak === 2, `peak=${peak}`);
	if (peak !== 2) {
		rmSync(scratch, { recursive: true, force: true });
		return;
	}
	ok(
		`${tag}b ${SIGNAL}: no orphaned scratch suites after runner exit (process group killed)`,
		orphanPids.trim() === "",
		`pgrep=${JSON.stringify(orphanPids.trim())}`,
	);
	if (fullMatrix) {
		ok(
			`A6c ${SIGNAL}: partial results table still printed (gate header + pass/fail footer)`,
			/suite gate:/.test(out) && /\d+ passed, \d+ failed/.test(out),
			`tail=${out.slice(-200)}`,
		);
	}
	ok(
		`${tag}d ${SIGNAL}: stderr banner names the signal and the running suite count`,
		new RegExp(`received ${SIGNAL} — killing \\d+ running suite`).test(out),
		`tail=${out.slice(-200)}`,
	);
	ok(
		`${tag}e ${SIGNAL}: runner exit code is 130 (interrupt contract — regression net for the sigintSeen exit-override fix; was RED before the fix, see leg header)`,
		exitCode === 130,
		`exit=${exitCode}`,
	);
	rmSync(scratch, { recursive: true, force: true });
}

// A6: full SIGINT matrix (original round-2 leg, all five assertions).
await runInterruptLeg("SIGINT", true);
// A7: minimal SIGTERM leg (round-3 root scope) — banner + exit 130 + zero orphans, reusing
// the identical choreography; pins the signal-forwarding wiring without duplicating the matrix.
await runInterruptLeg("SIGTERM", false);

console.log(`\n${failCount === 0 ? "RUNNER-OVERLAP PASS" : "RUNNER-OVERLAP FAIL"} (${pass} passed, ${failCount} failed)`);
process.exit(failCount === 0 ? 0 : 1);
