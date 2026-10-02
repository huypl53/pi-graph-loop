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
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");

const args = process.argv.slice(2);
const flag = (name) => {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : undefined;
};
const has = (name) => args.includes(name);
const dir = flag("--dir");
const timeoutMs = Number(flag("--timeout") || 300_000);
const catalogOut = flag("--catalog");
if (!dir) {
	console.error("usage: run-suites.mjs --dir <tests-dir> [--timeout ms] [--catalog <out.md>]");
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
const results = [];
for (const file of files) {
	const q = quarantine.get(file) ?? quarantine.get(`${dir}/${file.split("/").pop()}`);
	if (q) {
		results.push({ file, status: "QUARANTINED", ms: 0, signature: q.reason, trackedIn: q.trackedIn });
		continue;
	}
	const env = { ...process.env };
	if (isSwarmDir) {
		// P2-1 fix: FORCE root identity for swarm suites (match the old loop's
		// command-level prefix exactly) — `|| "root"` inherited ambient ids and
		// made identity-sensitive suites env-dependent (reviewer/tester probe).
		env.PI_SWARM_AGENT_ID = "root";
		env.PI_SWARM_IS_ROOT = "1";
	}
	const t0 = Date.now();
	const r = spawnSync(process.execPath, [join(repoRoot, file)], { env, timeout: timeoutMs, encoding: "utf8", cwd: repoRoot });
	const ms = Date.now() - t0;
	let status = "PASS";
	let signature = "";
	if (r.error?.code === "ETIMEDOUT" || (r.signal ?? "") === "SIGTERM") {
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
	results.push({ file, status, ms, signature });
}

const pad = (s, n) => (s.length >= n ? s : s + " ".repeat(n - s.length));
const order = { FAIL: 0, TIMEOUT: 1, PASS: 2, SKIP: 3, QUARANTINED: 4 };
results.sort((a, b) => order[a.status] - order[b.status] || a.file.localeCompare(b.file));
console.log("\n=== suite gate:", dir, "===");
for (const r of results) {
	const sig = r.signature ? ` — ${r.signature}` : "";
	console.log(`${pad(r.status, 12)} ${pad(String(r.ms), 7)}ms ${r.file}${r.status === "QUARANTINED" ? ` (tracked: ${r.trackedIn ?? "?"})` : sig}`);
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
process.exit(failed.length > 0 ? 1 : 0);
