#!/usr/bin/env node
/**
 * terminal-manager-pin-guard.test.mjs
 *
 * Driver-test fallback for test-hermeticity-pin-unpinned-lanes (2026-10-04).
 *
 * Asserts that every mock-llm lane that spawns a real `pi` subprocess with root
 * identity pins `PI_SWARM_TERMINAL_MANAGER=tmux` in the env passed to
 * `spawnSync`/`spawn`. The pin is precedence #1 in `getTerminalDriver`, so it
 * overrides any global `~/.pi/agent/swarm.yml` `terminalManager: herdr` setting.
 *
 * This is a STATIC check (reads the source files, does not execute the lanes).
 * It proves the pin is present at the real `spawnSync`/`spawn` boundary. The
 * behavioral check is the `swarm-yml-pool` RED-first pattern already proven in
 * 49241ad.
 *
 * Run: node extensions/mock-llm/tests/terminal-manager-pin-guard.test.mjs
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

// Category A: spawn-based lanes that MUST have the pin.
const SPAWN_BASED_LANES = [
	"errorlog-evidence-failure.test.mjs",
	"goal-max-nudges.test.mjs",
	"guest-tool-denial.test.mjs",
	"issues-cancel-guard.test.mjs",
	"issues-feature-dev.test.mjs",
	"qualification-gate-create.test.mjs",
	"qualification-gate-human-discuss.test.mjs",
	"r18-scratch-startup.test.mjs",
	"r25-unacked-worker-notify.test.mjs",
	"root-register-scaffold.test.mjs",
	"swarm-issues-sequential.test.mjs",
	"task-role-staffing-hint.test.mjs",
];

// Category B: in-process lanes that MUST have the exempt comment.
const IN_PROCESS_LANES = [
	"assignment-body-contract.test.mjs",
	"assignment-stale-replyto-redirect.test.mjs",
	"issues-manual-advance.test.mjs",
	"messaging-uat.test.mjs",
	"nudge-closure-race.test.mjs",
];

let pass = 0,
	fail = 0;
const ok = (name, cond, info) => {
	if (cond) {
		pass++;
		console.log("  ok  ", name);
	} else {
		fail++;
		console.error("  FAIL", name, info ?? "");
	}
};

// --- Category A: pin must be present ---
for (const lane of SPAWN_BASED_LANES) {
	const path = join(here, lane);
	const src = readFileSync(path, "utf8");
	ok(
		`${lane}: pins PI_SWARM_TERMINAL_MANAGER=tmux`,
		src.includes('PI_SWARM_TERMINAL_MANAGER: "tmux"') || src.includes('PI_SWARM_TERMINAL_MANAGER = "tmux"'),
		"missing pin in env object",
	);
	ok(
		`${lane}: has explanatory comment`,
		src.includes("test-hermeticity-pin-unpinned-lanes"),
		"missing comment block",
	);
}

// --- Category B: exempt comment must be present, pin must be absent ---
for (const lane of IN_PROCESS_LANES) {
	const path = join(here, lane);
	const src = readFileSync(path, "utf8");
	ok(
		`${lane}: has in-process exempt comment`,
		src.includes("No PI_SWARM_TERMINAL_MANAGER pin needed"),
		"missing exempt comment",
	);
	ok(
		`${lane}: does NOT pin (in-process only)`,
		!src.includes('PI_SWARM_TERMINAL_MANAGER: "tmux"') && !src.includes('PI_SWARM_TERMINAL_MANAGER = "tmux"'),
		"unexpected pin in in-process lane",
	);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
