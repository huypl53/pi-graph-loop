// Red-then-green test: ensureGlobalPoolScaffold must emit a real pool.global_scaffold_created
// trace to the project's events.jsonl and must NOT produce the
// `TypeError: traceFn is not a function` error (previously routed to a bogus path).
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const SRC = new URL("../src/", import.meta.url).pathname;

function makeHome() {
	return mkdtempSync(join(tmpdir(), "tracefn-home-"));
}

function runInProject(projectCwd, home) {
	// HOME-isolated: global swarm.yml absent in fresh HOME -> global scaffold path taken.
	return spawnSync(
		process.execPath,
		["--experimental-strip-types", "-e", `
import { ensureGlobalPoolScaffold } from ${JSON.stringify(join(SRC, "pool-scaffold.ts"))};
import { paths as statePaths } from ${JSON.stringify(join(SRC, "state.ts"))};
const p = statePaths(process.cwd());
await ensureGlobalPoolScaffold({ p });
console.log("DONE");
`],
		{ cwd: projectCwd, env: { ...process.env, HOME: home }, encoding: "utf8" },
	);
}

let failed = 0;
function check(name, cond, detail) {
	if (cond) console.log(`ok - ${name}`);
	else {
		failed++;
		console.log(`FAIL - ${name}\n  ${detail}`);
	}
}

const home = makeHome();
const projectCwd = mkdtempSync(join(tmpdir(), "tracefn-proj-"));
// .pi must exist so project state dirs resolve naturally
import { mkdirSync } from "node:fs";
mkdirSync(join(projectCwd, ".pi", "swarm"), { recursive: true });

const r = runInProject(projectCwd, home);
check("script ran", r.status === 0, `status=${r.status} stdout=${r.stdout} stderr=${r.stderr}`);

// Scaffold should be written to HOME
const globalYml = join(home, ".pi", "agent", "swarm.yml");
check("global scaffold written", existsSync(globalYml), globalYml + " missing");

// Test 1: pool.global_scaffold_created trace in project events.jsonl
const eventsPath = join(projectCwd, ".pi", "swarm", "traces", "events.jsonl");
let events = "";
try { events = readFileSync(eventsPath, "utf8"); } catch {}
const hasEvent = events.includes("pool.global_scaffold_created");
check("trace event pool.global_scaffold_created in project events.jsonl", hasEvent,
	`no event in ${eventsPath}; contents: ${events.slice(0, 500)}`);

// Test 2: no traceFn TypeError in project errors.jsonl
const errorsPath = join(projectCwd, ".pi", "swarm", "traces", "errors.jsonl");
let errors = "";
try { errors = readFileSync(errorsPath, "utf8"); } catch {}
check("no traceFn TypeError in project errors.jsonl", !errors.includes("traceFn is not a function"),
	errors.slice(0, 500));

rmSync(home, { recursive: true, force: true });
rmSync(projectCwd, { recursive: true, force: true });

console.log(failed === 0 ? "ALL PASS" : `${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
