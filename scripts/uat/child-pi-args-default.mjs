#!/usr/bin/env node
// === G3 lane: childPiArgs() default must load the swarm extension ===
// Task followup-g3-child-pi-args-default-20260926.
// RED: env-cleared childPiArgs() returns "--approve" only (no -e swarm/index.ts) — workers
//      spawn without swarm tools.
// GREEN: default includes the extension load; explicit PI_SWARM_CHILD_ARGS wins verbatim;
//      R10-1 counter at the REAL spawn exec line (agents.ts spawned command string).
// Usage: node scripts/uat/child-pi-args-default.mjs [--red]
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");
const swarmRoot = join(repo, "extensions", "swarm");
const taskRoot = join(repo, ".pi", "swarm", "tasks", "followup-g3-child-pi-args-default-20260926");
const RED = process.argv.includes("--red") || process.env.UAT_RED === "1";
const outDir = join(taskRoot, "artifacts", RED ? "red-lane" : "green-lane");
mkdirSync(outDir, { recursive: true });

let pass = 0,
	fail = 0;
const ok = (name, cond, detail = "") => {
	if (cond) {
		pass++;
		console.log(`  ok   ${name}`);
	} else {
		fail++;
		console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
	}
};

const scratch = mkdtempSync(join(tmpdir(), "g3-args-"));
mkdirSync(join(scratch, ".pi"), { recursive: true });
process.env.PI_SWARM_ROOT = scratch;

const { childPiArgs } = await import(join(swarmRoot, "src", "session.ts"));

console.log(RED ? "=== G3 RED lane (default has no extension load) ===" : "=== G3 GREEN lane (default loads swarm) ===");

// 1) deterministic unit boundary: env-cleared default
delete process.env.PI_SWARM_CHILD_ARGS;
const def = childPiArgs();
ok("default childPiArgs() includes an -e swarm extension load", /(^|\s)-e\s+\S*swarm\S*/.test(def), `actual="${def}"`);
ok("default childPiArgs() keeps --approve", def.includes("--approve"), `actual="${def}"`);

// 2) R10-1: the REAL spawn exec boundary — reconstruct the spawned command exactly as
//    agents.ts spawnAgent does (envPrefix + pi --model ... + childPiArgs()) and count
//    extension flags in the command string that would be exec'd into the pane.
const spawnCmdOf = (model, provider) =>
	`PI_SWARM_AGENT_ID='w1' PI_SWARM_ID='sw' PI_SWARM_DEFAULT_MODEL='${model}' PI_SWARM_DEFAULT_PROVIDER='${provider}' pi --model '${model}' --provider '${provider}' ${childPiArgs()}`;
const extFlagCount = (s) => (s.match(/(^|\s)-e\s+\S*swarm\S*/g) || []).length;
const spawnCmd = spawnCmdOf("glm-4.7", "ccs");
if (RED) {
	ok(
		"RED: spawned command has 0 swarm extension flags (workers get NO swarm tools)",
		extFlagCount(spawnCmd) === 0,
		`cmd=…${spawnCmd.split("pi ")[1]}`,
	);
} else {
	ok(
		"GREEN R10-1: spawned command carries exactly 1 swarm extension flag",
		extFlagCount(spawnCmd) === 1,
		`count=${extFlagCount(spawnCmd)}`,
	);
}

// 3) override wins verbatim
process.env.PI_SWARM_CHILD_ARGS = "--approve --no-extensions";
const overridden = childPiArgs();
ok("explicit PI_SWARM_CHILD_ARGS wins verbatim", overridden === "--approve --no-extensions", `actual="${overridden}"`);
const overCmd = spawnCmdOf("glm-4.7", "ccs");
ok("R10-1: overridden spawn command has 0 extension flags", extFlagCount(overCmd) === 0, `count=${extFlagCount(overCmd)}`);
delete process.env.PI_SWARM_CHILD_ARGS;

// 4) extension path resolves regardless of cwd (must not be a bare cwd-relative path that
//    breaks when the spawn cwd differs from the repo root) — assert the path token either
//    is absolute or is the canonical repo-relative form "extensions/swarm/index.ts".
const m = def.match(/(?:^|\s)-e\s+(\S+)/);
const extPath = m ? m[1].replace(/^['"]|['"]$/g, "") : null;
ok(
	"extension path is absolute or canonical repo-relative (cwd-independent)",
	extPath !== null && (extPath.startsWith("/") || /(^|\/)extensions\/swarm\/index\.ts$/.test(extPath)),
	`extPath=${extPath}`,
);

writeFileSync(
	join(outDir, "report.md"),
	`# G3 ${RED ? "RED" : "GREEN"} lane\n\npass=${pass} fail=${fail}\n\n- default childPiArgs(): "${def}"\n- spawn command ext flags: ${extFlagCount(spawnCmd)}\n- override: "${overridden}" → ext flags ${extFlagCount(overCmd)}\n- extPath: ${extPath}\n`,
);
writeFileSync(
	join(outDir, "evidence.json"),
	JSON.stringify({ mode: RED ? "red" : "green", default: def, spawnCmd, overridden, ts: new Date().toISOString() }, null, 2),
);
console.log(`\n[${RED ? "RED" : "GREEN"}] pass=${pass} fail=${fail} -> ${outDir}`);
process.exit(fail === 0 ? 0 : 1);
