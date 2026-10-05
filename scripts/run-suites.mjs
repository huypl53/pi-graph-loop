#!/usr/bin/env node
// scripts/run-suites.mjs — honest per-suite sweep gate (testgate-vacuous-loop).
//
// Replaces the vacuous `for … || true` loops in package.json test:swarm/test:mockllm:
// every suite runs with its own exit code; the runner aggregates and EXITS NON-ZERO when any
// non-quarantined suite fails or times out. Output lists every suite with PASS/FAIL/TIMEOUT/
// QUARANTINED + duration + first error-signature line.
//
// Env contract preserved from the old loop: swarm suites get PI_SWARM_AGENT_ID=root +
// PI_SWARM_IS_ROOT=1 injected by default (per-suite overrides still win — suites set their own
// env at import time); mock-llm suites run with the ambient env. Timeouts stay at 300s per suite.
//
// Quarantine: scripts/suite-quarantine.json — checked-in inventory of explicitly excluded
// suites ({ file, reason, trackedIn }). Quarantined suites are NOT run and do NOT affect the
// gate; they are listed in the output on every run.
//
// Parallel mode (parallelize-test-runner): `--parallel N` runs up to N suites concurrently
// through a bounded worker pool. Suites contending on shared runtime resources are pinned to
// named serialization groups (max 1 running at a time within a group) so parallelism cannot
// create cross-suite flakiness — see SERIALIZATION_GROUPS below and the "Parallel runner +
// serialization groups" section in docs/swarm/contributor-guide.md. Without the flag the
// runner behaves exactly as before (sequential spawnSync loop, byte-identical output).
//
// Isolation under parallel: every suite gets a fresh env copy (as before) plus its own
// TMPDIR (os.tmpdir() inside the suite resolves to a per-suite directory), so tmpdir-default
// state cannot collide across concurrent suites. HOME is never touched by the runner —
// suites that pin HOME keep doing so. No suite in either test tree binds a TCP port.
import { spawnSync, spawn } from "node:child_process";
import { readdirSync, readFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { join, dirname, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");

// ---------------------------------------------------------------------------
// Serialization groups — suites contending on shared runtime resources.
// One suite per group runs at a time; different groups and ungrouped suites run fully
// parallel. Matching is by repo-relative path substring (the `file` strings this runner
// prints). A group entry matching zero files in the current --dir is inert.
//
// Adding a suite that touches the LIVE herdr daemon, repo-root .pi state, or a fixed tmux
// session name? It MUST join a group here — reviewer-checked (contributor-guide).
// ---------------------------------------------------------------------------
const SERIALIZATION_GROUPS = {
	// Suites that write into the REPO's own .pi / tmux-snapshots at runtime (fixed paths,
	// module top-level mkdirs, repo-cwd child pi sessions):
	"repo-pi-state": [
		"extensions/mock-llm/tests/r18-scratch-startup.test.mjs",
		"extensions/swarm/tests/ct-phase2-probes.test.mjs",
		"extensions/mock-llm/tests/agent-lifecycle-uat.test.mjs",
		"extensions/mock-llm/tests/messaging-uat.test.mjs",
		"extensions/swarm/tests/uat-goal-nudge.test.mjs",
	],
	// Lanes that can drive the live terminal daemons (real tmux window creation through
	// PI_SWARM_TMUX_OK + $TMUX inheritance; guard rail for any future spawn lane):
	"live-terminal": ["extensions/mock-llm/tests/swarm-yml-pool.test.mjs", "extensions/mock-llm/tests/terminal-manager-pin-demo.test.mjs"],
};

// Test-only group override (runner-parallel-overlap.test.mjs): replaces the built-in table
// when set. JSON map of group name → filename substrings. Never set in production.
function serializationGroupsForTests() {
	if (!process.env.RUNNER_SERIALIZATION_GROUPS) return undefined;
	try {
		return JSON.parse(process.env.RUNNER_SERIALIZATION_GROUPS);
	} catch (err) {
		console.error(`run-suites: ignoring invalid RUNNER_SERIALIZATION_GROUPS (${err?.message || err})`);
		return undefined;
	}
}

const args = process.argv.slice(2);
const flag = (name) => {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : undefined;
};
const has = (name) => args.includes(name);
const dir = flag("--dir");
const timeoutMs = Number(flag("--timeout") || 300_000);
const catalogOut = flag("--catalog");
const parallelRaw = flag("--parallel");
let parallelN = parallelRaw === undefined ? 0 : Number(parallelRaw);
// Set by the SIGINT/SIGTERM shutdown handler; the final exit code must honor the interrupt
// (130) even when the normal completion path (footer + exit) resolves first — the shutdown
// setTimeout(130) backstop alone always loses that race on the parallel path.
let sigintSeen = false;
if (parallelRaw !== undefined && (!Number.isFinite(parallelN) || parallelN < 1)) {
	console.error("run-suites: --parallel N requires an integer >= 1");
	process.exit(2);
}
parallelN = Math.min(Math.max(Math.floor(parallelN || 0), 0), 16);
if (parallelN > 8) {
	console.error(`run-suites: --parallel ${parallelN} exceeds the recommended bound (8); suites spawn real pi/tmux children — use <= 8`);
}
if (!dir) {
	console.error("usage: run-suites.mjs --dir <tests-dir> [--timeout ms] [--catalog <out.md>] [--parallel N]");
	process.exit(2);
}

const quarantinePath = join(scriptDir, "suite-quarantine.json");
const quarantine = new Map();
if (existsSync(quarantinePath)) {
	for (const entry of JSON.parse(readFileSync(quarantinePath, "utf8"))) {
		quarantine.set(entry.file, entry);
	}
}

const absDir = resolve(repoRoot, dir);
const files = readdirSync(absDir)
	.filter((f) => f.endsWith(".test.mjs") || f.endsWith(".validate.mjs"))
	.sort()
	.map((f) => relative(repoRoot, join(absDir, f)));

const isSwarmDir = dir.includes("extensions/swarm");

function groupOf(file) {
	const table = serializationGroupsForTests() ?? SERIALIZATION_GROUPS;
	for (const [group, needles] of Object.entries(table)) {
		if (needles.some((needle) => file.includes(needle) || `${dir}/${file.split("/").pop()}`.includes(needle))) return group;
	}
	return null;
}

function suiteEnv(file) {
	const env = { ...process.env };
	if (isSwarmDir) {
		// P2-1 fix: FORCE root identity for swarm suites (match the old loop's
		// command-level prefix exactly) — `|| "root"` inherited ambient ids and
		// made identity-sensitive suites env-dependent (reviewer/tester probe).
		env.PI_SWARM_AGENT_ID = "root";
		env.PI_SWARM_IS_ROOT = "1";
	}
	return env;
}

function classify(r, ms) {
	let status = "PASS";
	let signature = "";
	if (r.error?.code === "ETIMEDOUT" || r.killed || (r.signal ?? "") === "SIGTERM" || (r.signal ?? "") === "SIGKILL") {
		status = "TIMEOUT";
		signature = `timed out after ${timeoutMs}ms`;
	} else if (r.status !== 0) {
		status = "FAIL";
		const errLine = `${r.stderr || ""}${r.stdout || ""}`
			.split("\n")
			.map((l) => l.trim())
			.filter((l) => /FAIL|Error|error:/i.test(l))
			.find((l) => l.length > 0);
		signature = (errLine || `exit ${r.status}`).slice(0, 200);
	} else {
		// P2-1 (round2 review): an env-conditional suite that clean-SKIPs (exit 0, zero
		// assertions) must not render as an ordinary PASS — parse the suite's "SKIP:" stdout
		// marker and surface it. SKIP still exits 0 (not a gate failure), it is just honest.
		const skipLine = `${r.stdout || ""}`
			.split("\n")
			.map((l) => l.trim())
			.find((l) => l.startsWith("SKIP:"));
		if (skipLine) {
			status = "SKIP";
			signature = skipLine.slice(0, 200);
		}
	}
	return { status, signature };
}

const results = [];

// ---- sequential path: byte-identical to the pre-parallel runner ----
if (parallelN <= 1) {
	if (parallelN === 1) console.error(`run-suites: mode: sequential (--parallel 1)`);
	for (const file of files) {
		const q = quarantine.get(file) ?? quarantine.get(`${dir}/${file.split("/").pop()}`);
		if (q) {
			results.push({ file, status: "QUARANTINED", ms: 0, signature: q.reason, trackedIn: q.trackedIn });
			continue;
		}
		const env = suiteEnv(file);
		const t0 = Date.now();
		const r = spawnSync(process.execPath, [join(repoRoot, file)], { env, timeout: timeoutMs, encoding: "utf8", cwd: repoRoot });
		const ms = Date.now() - t0;
		const { status, signature } = classify(r, ms);
		results.push({ file, status, ms, signature });
	}
} else {
	// ---- bounded parallel pool with serialization-group lanes ----
	console.error(`run-suites: mode: parallel(${parallelN}) — groups: ${Object.keys(SERIALIZATION_GROUPS).join(", ") || "none"}`);
	const groupTable = serializationGroupsForTests() ?? SERIALIZATION_GROUPS;
	const pending = files.map((file) => ({ file, group: groupOf(file) }));
	const busyGroups = new Set();
	const running = new Set(); // { file, child, timer, tmpdir, resolve }
	const runningByFile = new Map();

	function launchOne(entry) {
		const { file, group } = entry;
		if (group) busyGroups.add(group);
		// Per-suite TMPDIR: os.tmpdir() inside the suite resolves to an isolated directory,
		// so default-tmpdir state cannot collide across concurrent suites.
		const suiteTmp = mkdtempSync(join(tmpdir(), "run-suites-tmp-"));
		const env = { ...suiteEnv(file), TMPDIR: suiteTmp };
		const child = spawn(process.execPath, [join(repoRoot, file)], {
			env,
			cwd: repoRoot,
			stdio: ["ignore", "pipe", "pipe"],
			// Own process group so the runner-enforced timeout / shutdown can kill the
			// suite AND its pi children with one process-group signal.
			detached: true,
		});
		let stdout = "";
		let stderr = "";
		let settled = false;
		const rec = { file, group, child, tmpdir: suiteTmp, stdoutTail: () => stdout, stderrTail: () => stderr, settledRef: () => settled };
		const timer = setTimeout(() => {
			// Runner-enforced timeout: kill the whole process group (pi children of the
			// suite die too — no orphaned TUI lanes left behind).
			try {
				if (child.pid) process.kill(-child.pid, "SIGKILL");
			} catch (err) {
				if (err?.code !== "ESRCH") console.error(`run-suites: timeout kill failed for ${file}: ${err?.message || err}`);
			}
		}, timeoutMs);
		child.on("error", (err) => {
			if (!settled) {
				settled = true;
				clearTimeout(timer);
				console.error(`run-suites: spawn failed for ${file}: ${err?.message || err}`);
				finish(rec, { status: "FAIL", ms: Date.now() - t0Of(child), signature: `spawn error: ${err?.message || err}` });
			}
		});
		const t0 = Date.now();
		const t0Of = () => t0;
		child.stdout.on("data", (d) => {
			stdout = (stdout + d).split("\n").slice(-400).join("\n");
		});
		child.stderr.on("data", (d) => {
			stderr = (stderr + d).split("\n").slice(-400).join("\n");
		});
		child.on("close", (code, signal) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			const ms = Date.now() - t0;
			let status;
			let signature;
			if (signal === "SIGKILL" || signal === "SIGTERM") {
				status = "TIMEOUT";
				signature = `timed out after ${timeoutMs}ms`;
			} else if (code !== 0) {
				status = "FAIL";
				const errLine = `${stderr || ""}${stdout || ""}`
					.split("\n")
					.map((l) => l.trim())
					.filter((l) => /FAIL|Error|error:/i.test(l))
					.find((l) => l.length > 0);
				signature = (errLine || `exit ${code}`).slice(0, 200);
			} else {
				const skipLine = `${stdout || ""}`
					.split("\n")
					.map((l) => l.trim())
					.find((l) => l.startsWith("SKIP:"));
				if (skipLine) {
					status = "SKIP";
					signature = skipLine.slice(0, 200);
				} else {
					status = "PASS";
					signature = "";
				}
			}
			finish(rec, { status, ms, signature });
		});
		running.add(rec);
		runningByFile.set(file, rec);
	}

	function finish(rec, { status, ms, signature }) {
		running.delete(rec);
		runningByFile.delete(rec.file);
		if (rec.group) busyGroups.delete(rec.group);
		results.push({ file: rec.file, status, ms, signature });
		rmSync(rec.tmpdir, { recursive: true, force: true });
		pump();
	}

	function shutdown(signal) {
		if (sigintSeen) return;
		sigintSeen = true;
		console.error(`\nrun-suites: received ${signal} — killing ${running.size} running suite(s) and their children`);
		for (const rec of running) {
			try {
				if (rec.child.pid) process.kill(-rec.child.pid, signal === "SIGTERM" ? "SIGTERM" : "SIGKILL");
			} catch (err) {
				if (err?.code !== "ESRCH") console.error(`run-suites: shutdown kill failed for ${rec.file}: ${err?.message || err}`);
			}
		}
		// Give children a beat to die, then exit non-zero (results so far are incomplete —
		// the gate must not report success).
		setTimeout(() => process.exit(130), 500);
	}
	process.on("SIGINT", () => shutdown("SIGINT"));
	process.on("SIGTERM", () => shutdown("SIGTERM"));

	function pump() {
		// Deterministic start order: first (alphabetically) pending suite whose group lane
		// is free. Groups have <= 5 members, so a linear scan cannot starve a lane.
		while (running.size < parallelN) {
			const idx = pending.findIndex((e) => !e.group || !busyGroups.has(e.group));
			if (idx < 0) break;
			const [entry] = pending.splice(idx, 1);
			launchOne(entry);
		}
	}

	// Quarantined suites short-circuit (no spawn), then start the pool.
	for (const file of files) {
		const q = quarantine.get(file) ?? quarantine.get(`${dir}/${file.split("/").pop()}`);
		if (q) results.push({ file, status: "QUARANTINED", ms: 0, signature: q.reason, trackedIn: q.trackedIn });
	}
	const runQueue = pending.splice(0, pending.length).filter((e) => {
		const q = quarantine.get(e.file) ?? quarantine.get(`${dir}/${e.file.split("/").pop()}`);
		return !q;
	});
	pending.push(...runQueue);
	pump();
	await new Promise((resolveAll) => {
		const check = setInterval(() => {
			if (pending.length === 0 && running.size === 0) {
				clearInterval(check);
				resolveAll();
			}
		}, 50);
	});
}

const pad = (s, n) => (s.length >= n ? s : s + " ".repeat(n - s.length));
const order = { FAIL: 0, TIMEOUT: 1, PASS: 2, SKIP: 3, QUARANTINED: 4 };
results.sort((a, b) => order[a.status] - order[b.status] || a.file.localeCompare(b.file));
console.log("\n=== suite gate:", dir, "===");
for (const r of results) {
	const sig = r.signature ? ` — ${r.signature}` : "";
	console.log(
		`${pad(r.status, 12)} ${pad(String(r.ms), 7)}ms ${r.file}${r.status === "QUARANTINED" ? ` (tracked: ${r.trackedIn ?? "?"})` : sig}`,
	);
}
const failed = results.filter((r) => r.status === "FAIL" || r.status === "TIMEOUT");
const quarantined = results.filter((r) => r.status === "QUARANTINED");
const skipped = results.filter((r) => r.status === "SKIP");
console.log(
	`\n${results.length - failed.length - quarantined.length - skipped.length} passed, ${failed.length} failed, ${skipped.length} skipped (env-conditional), ${quarantined.length} quarantined`,
);
if (skipped.length > 0) console.log(`skipped (env absent, zero assertions run): ${skipped.map((r) => r.file.split("/").pop()).join(", ")}`);
if (quarantined.length > 0) console.log(`quarantined (excluded from gate): ${quarantined.map((r) => r.file).join(", ")}`);
if (catalogOut) {
	const lines = [
		`# Baseline suite catalog — ${dir}`,
		"",
		`Generated by scripts/run-suites.mjs --catalog on ${new Date().toISOString()}.`,
		"",
		"| status | ms | suite | signature |",
		"|---|---|---|---|",
		...results.map((r) => `| ${r.status} | ${r.ms} | ${r.file} | ${String(r.signature).replace(/\|/g, "\\|").slice(0, 160) || "—"} |`),
	];
	const { mkdirSync, writeFileSync } = await import("node:fs");
	mkdirSync(dirname(catalogOut), { recursive: true });
	writeFileSync(catalogOut, lines.join("\n") + "\n");
	console.log(`catalog written: ${catalogOut}`);
}
process.exit(sigintSeen ? 130 : failed.length > 0 ? 1 : 0);
