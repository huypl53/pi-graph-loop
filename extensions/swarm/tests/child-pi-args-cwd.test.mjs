#!/usr/bin/env node
/**
 * REPRODUCE TEST:
 * childPiArgs() must return an absolute, cwd-independent path for -e <path>
 * so that workers spawned in any workspace directory (outside pi-graph-agents repo)
 * can find and load the swarm extension without crashing on startup.
 */
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { childPiArgs } from "../src/session.ts";

let pass = 0;
let fail = 0;
function ok(name, cond, msg) {
	if (cond) {
		pass++;
		console.log(`  ok   ${name}`);
	} else {
		fail++;
		console.error(`  FAIL ${name} - ${msg || ""}`);
	}
}

console.log("=== Reproduce: childPiArgs() cwd independence ===");

delete process.env.PI_SWARM_CHILD_ARGS;
const args = childPiArgs();

// Extract the path passed to -e
const m = args.match(/(?:^|\s)-e\s+(\S+)/);
ok("childPiArgs() contains -e <path>", Boolean(m), `actual args: "${args}"`);

const rawPath = m ? m[1].replace(/^['"]|['"]$/g, "") : "";

// Check 1: The extension path must be absolute
ok("extension path is absolute", rawPath.startsWith("/"), `expected absolute path, got: "${rawPath}"`);

// Check 2: When evaluated from an external working directory (like tmpdir or a different project),
// the path must resolve to an existing file
const externalCwd = tmpdir();
const resolvedFromExternalCwd = resolve(externalCwd, rawPath);
ok(
	"extension path resolves to an existing file from an external cwd",
	existsSync(resolvedFromExternalCwd),
	`path "${resolvedFromExternalCwd}" does not exist`,
);

// Check 3: Explicit override still wins verbatim
process.env.PI_SWARM_CHILD_ARGS = "--approve --no-extensions";
ok(
	"explicit PI_SWARM_CHILD_ARGS wins verbatim",
	childPiArgs() === "--approve --no-extensions",
	`expected verbatim override`,
);
delete process.env.PI_SWARM_CHILD_ARGS;

console.log(`\nResults: ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
