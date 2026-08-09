// Corruption-resilience tests for the swarm state loaders in src/state.ts.
//
// readState must self-heal (backup + default) so the extension never crashes on a bad
// swarm-state.json; the typed readers (readTaskState et al.) must back up and throw a clear
// error so guarded callers (reconcile task_skip, etc.) can skip the unreadable file. Normal
// valid parses are unaffected.
//
// Run: node extensions/swarm/state-corruption.test.mjs
import { rmSync, writeFileSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const { readState, readTaskState, paths, ensureDirs } = await import(join(here, "src", "state.ts"));

const scratch = join(tmpdir(), `swarm-corrupt-${process.pid}-${Date.now()}`);
rmSync(scratch, { recursive: true, force: true });

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log("  ok  ", n); } else { fail++; console.error("  FAIL", n); } };
const throws = async (n, p, predicate) => {
	try { await p(); fail++; console.error("  FAIL", n, "(did not throw)"); }
	catch (err) {
		const msg = String(err?.message || err);
		if (!predicate || predicate(msg)) { pass++; console.log("  ok  ", n); }
		else { fail++; console.error("  FAIL", n, `(wrong error: ${msg})`); }
	}
};

const p = paths(scratch);
await ensureDirs(p);
const GARBAGE = "{ this is :: not valid json }}}";

// --- [1] readState recovers from corrupt swarm-state.json with a fresh default ---
console.log("\n[1] readState recovers from corrupt swarm-state.json");
{
	writeFileSync(p.state, GARBAGE, "utf8");
	const st = await readState(p, scratch);
	ok("returns a SwarmState object", typeof st === "object" && st !== null);
	ok("swarmId is set (valid default)", typeof st.swarmId === "string" && /^swarm-/.test(st.swarmId));
	ok("cwd points at scratch", st.cwd === scratch);
	ok("agents/delivered/messages back-filled to objects",
		st.agents && st.delivered && st.messages && typeof st.agents === "object");
	ok("corrupt state backed up to .corrupt.bak", existsSync(`${p.state}.corrupt.bak`));
	ok("backup holds the original garbage", readFileSync(`${p.state}.corrupt.bak`, "utf8") === GARBAGE);
	// recovery traced for post-mortem
	const events = readFileSync(p.events, "utf8");
	ok("state.corrupt_recovered traced with the file path", /state\.corrupt_recovered/.test(events) && events.includes(p.state));
}

// --- [2] readTaskState throws a clear error on corrupt task.json (does not crash) ---
console.log("\n[2] readTaskState throws a clear error on corrupt task.json");
{
	const tp = join(p.tasksDir, "task-bad", "task.json");
	mkdirSync(dirname(tp), { recursive: true });
	writeFileSync(tp, GARBAGE, "utf8");
	await throws(
		"readTaskState throws on corrupt JSON",
		() => readTaskState(tp),
		(msg) => msg.startsWith("Failed to parse ") && msg.includes(tp) && msg.includes(".corrupt.bak"),
	);
	ok("corrupt task.json backed up to .corrupt.bak", existsSync(`${tp}.corrupt.bak`));
	ok("original task.json path no longer exists (renamed)", !existsSync(tp));
}

// --- [3] Normal valid parses still work unchanged ---
console.log("\n[3] normal valid parses still work");
{
	// readState: fresh dir creates + persists the default, second read parses it back.
	const fresh = join(scratch, "fresh");
	const fp = paths(fresh);
	const created = await readState(fp, fresh);
	ok("readState creates a default when no state exists", typeof created.swarmId === "string" && existsSync(fp.state));
	const again = await readState(fp, fresh);
	ok("readState parses a valid file back (same swarmId)", again.swarmId === created.swarmId);

	// readState: hand-written valid state is parsed and back-filled (not treated as corrupt).
	const validState = { version: created.version, swarmId: "swarm-handwritten", cwd: fresh, tmuxSession: "s", agents: {}, delivered: {}, messages: {}, createdAt: "t", updatedAt: "t" };
	writeFileSync(fp.state, JSON.stringify(validState), "utf8");
	const parsed = await readState(fp, fresh);
	ok("readState parses hand-written valid state", parsed.swarmId === "swarm-handwritten");
	ok("readState back-fills orchestratorPumpSessions", parsed.orchestratorPumpSessions && typeof parsed.orchestratorPumpSessions === "object");
	ok("no spurious .corrupt.bak for valid state", !existsSync(`${fp.state}.corrupt.bak`));

	// readTaskState: valid task.json parses and normalizes nodes.
	const goodTaskPath = join(p.tasksDir, "task-good", "task.json");
	mkdirSync(dirname(goodTaskPath), { recursive: true });
	writeFileSync(goodTaskPath, JSON.stringify({ taskId: "task-good", status: "in_progress", nodes: { n1: { id: "n1", status: "pending", role: "worker", dependsOn: [] } } }), "utf8");
	const task = await readTaskState(goodTaskPath);
	ok("readTaskState parses valid task.json", task.taskId === "task-good");
	ok("readTaskState normalizes edges/sharedContext defaults", Array.isArray(task.edges) && task.sharedContext);
}

console.log(`\n${pass} pass, ${fail} fail`);
if (fail > 0) process.exit(1);
console.log("CORRUPTION PASS");
