#!/usr/bin/env node
/** Regression checks for the H1 live-lane seeder's disposable-project guard. */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
const seeder = join(here, "seed-live-fixture.mjs");
const temp = mkdtempSync(join(tmpdir(), `h1-seeder-guard-${process.pid}-`));
const runRoot = join(repo, ".pi/swarm-uat/runs", `h1-seeder-guard-test-${process.pid}`);
const safeProject = join(runRoot, "project");
let pass = 0;
let fail = 0;
const ok = (name, condition, details = "") => {
	if (condition) {
		pass++;
		console.log(`  ok   ${name}`);
	} else {
		fail++;
		console.error(`  FAIL ${name} ${details}`);
	}
};
const run = (cwd, args) => spawnSync(process.execPath, [seeder, ...args], { cwd, encoding: "utf8", timeout: 30_000 });

try {
	// Missing target must fail before writing state into the caller's current directory.
	const noArgCwd = join(temp, "no-arg");
	mkdirSync(noArgCwd);
	const missing = run(noArgCwd, ["seed"]);
	ok("missing target is rejected", missing.status === 2, `${missing.status}: ${missing.stderr}`);
	ok("missing target does not create cwd swarm state", !existsSync(join(noArgCwd, ".pi/swarm/swarm-state.json")));

	// Explicit repo root and an arbitrary external path are both outside the disposable run root.
	const repoRoot = run(repo, ["seed", repo]);
	ok("repository root is rejected", repoRoot.status === 2, `${repoRoot.status}: ${repoRoot.stderr}`);
	const outside = join(temp, "outside-project");
	mkdirSync(outside);
	const external = run(repo, ["seed", outside]);
	ok("external project is rejected", external.status === 2, `${external.status}: ${external.stderr}`);
	ok("external rejection does not create state", !existsSync(join(outside, ".pi/swarm/swarm-state.json")));

	// Even a path lexically below the safe root must not escape through a symlinked project leaf.
	mkdirSync(runRoot, { recursive: true });
	symlinkSync(outside, join(runRoot, "linked-project"), "dir");
	const linked = run(repo, ["seed", join(runRoot, "linked-project")]);
	ok("symlink project target is rejected", linked.status === 2, `${linked.status}: ${linked.stderr}`);
	ok("symlink rejection does not write through to its destination", !existsSync(join(outside, ".pi/swarm/swarm-state.json")));

	// The documented disposable path remains usable.
	const safe = runRoot;
	mkdirSync(safe, { recursive: true });
	const valid = run(repo, ["seed", safeProject]);
	ok(
		"safe UAT project seeds successfully",
		valid.status === 0 && existsSync(join(safeProject, ".pi/swarm/swarm-state.json")),
		valid.stderr || valid.stdout,
	);
	if (existsSync(join(safeProject, ".pi/swarm/swarm-state.json"))) {
		const state = JSON.parse(readFileSync(join(safeProject, ".pi/swarm/swarm-state.json"), "utf8"));
		ok(
			"safe project contains the expected assignment and nudge records",
			!!state.messages?.["msg-assign-d1"] && !!state.messages?.["msg-nudge-d1"],
		);
	}
} finally {
	rmSync(temp, { recursive: true, force: true });
	rmSync(runRoot, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
