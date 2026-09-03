// Focused unit test for the root-pane reject guard added to swarm_send_keys (issue 12 C6
// micro-fix). The guard is a principle-based equality check on the resolved tmux target, so it fires
// regardless of how the agentId is supplied (direct root id, or any ghost agent mis-stamped to
// the root's "unknown" sentinel).
//
// Strategy mirrors agent-lifecycle.test.mjs: build the real tool set with a mock `pi` whose tmux
// exec pushes send-keys subcommands into a `sentKeys` spy array. State lives under a temp scratch dir.
// No extraction refactor was done (per binding condition C1) — we drive the registered tool via the
// same registerTool capture pattern.
//
// Cases covered (per plan §5.2 + plan-review binding C2 for the undefined variant):
//   A. agentId="root"                          -> ROOT_PANE_REJECTED, spy untouched
//   B. ghost agent with tmuxTarget="unknown"            -> same as A (principle-based, not id-based)
//   C. worker w1 with tmuxTarget="sess:w1.0"             -> resolves, spy called once with that target
//   D. agentId="nope"                                  -> throws "Unknown swarm agent: nope" (preserved)
//   E. worker w2 with tmuxTarget=""                     -> falls through, helper throws "agent has no tmux pane target"
//   F. worker w3 with tmuxTarget=undefined (C2)         -> falls through, helper throws "agent has no tmux pane target"
//
// Run: node extensions/swarm/send-keys-guard.test.mjs
import { rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const mod = await import(join(here, "..", "index.ts"));
const factory = mod.default;

const scratch = join(tmpdir(), `swarm-sendkeys-guard-${process.pid}-${Date.now()}`);
rmSync(scratch, { recursive: true, force: true });
mkdirSync(join(scratch, ".pi", "swarm"), { recursive: true });

// Minimal SwarmState seed with the root record matching the ensureRoot invariant
// (tmuxTarget = "unknown"). Workers have real tmux targets; the ghost agent deliberately shares the
// root's "unknown" sentinel.
const swarmState = {
	version: 1,
	swarmId: "swarm-test-sendkeys-guard",
	tmuxSession: "test",
	createdAt: new Date().toISOString(),
	updatedAt: new Date().toISOString(),
	agents: {
		root: {
			id: "root",
			role: "Swarm root",
			roleKind: "root",
			capabilities: [],
			activeTaskIds: [],
			maxConcurrentTasks: 99,
			status: "running",
			runtimeStatus: "idle",
			health: "healthy",
			tmuxSession: "test",
			tmuxWindow: "root",
			tmuxTarget: "unknown", // canonical root sentinel per ensureRoot
			model: "m",
			provider: "p",
			cwd: scratch,
			mailbox: ".pi/swarm/mailboxes/root.jsonl",
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		},
		w1: {
			id: "w1",
			role: "worker",
			roleKind: "implementer",
			capabilities: [],
			activeTaskIds: [],
			maxConcurrentTasks: 1,
			status: "running",
			runtimeStatus: "idle",
			health: "healthy",
			tmuxSession: "test",
			tmuxWindow: "w1",
			tmuxTarget: "test:w1.0",
			model: "m",
			provider: "p",
			cwd: scratch,
			mailbox: ".pi/swarm/mailboxes/w1.jsonl",
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		},
		w2: {
			id: "w2",
			role: "worker",
			roleKind: "implementer",
			capabilities: [],
			activeTaskIds: [],
			maxConcurrentTasks: 1,
			status: "running",
			runtimeStatus: "idle",
			health: "healthy",
			tmuxSession: "test",
			tmuxWindow: "w2",
			tmuxTarget: "", // empty string — orthogonal to guard; falls through to helper
			model: "m",
			provider: "p",
			cwd: scratch,
			mailbox: ".pi/swarm/mailboxes/w2.jsonl",
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		},
		w3: {
			id: "w3",
			role: "worker",
			roleKind: "implementer",
			capabilities: [],
			activeTaskIds: [],
			maxConcurrentTasks: 1,
			status: "running",
			runtimeStatus: "idle",
			health: "healthy",
			tmuxSession: "test",
			tmuxWindow: "w3",
			// tmuxTarget undefined — covers binding condition C2. Persisted JSON omits the field;
			// the test loads the file fresh so JSON.parse gives undefined when the key is absent.
			model: "m",
			provider: "p",
			cwd: scratch,
			mailbox: ".pi/swarm/mailboxes/w3.jsonl",
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		},
		ghost: {
			id: "ghost",
			role: "ghost",
			roleKind: "worker",
			capabilities: [],
			activeTaskIds: [],
			maxConcurrentTasks: 1,
			status: "running",
			runtimeStatus: "idle",
			health: "healthy",
			tmuxSession: "test",
			tmuxWindow: "ghost",
			tmuxTarget: "unknown", // ghost mis-stamped to root sentinel — guard must catch this
			model: "m",
			provider: "p",
			cwd: scratch,
			mailbox: ".pi/swarm/mailboxes/ghost.jsonl",
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		},
	},
	messages: {},
	delivered: { root: [] },
};
writeFileSync(join(scratch, ".pi", "swarm", "swarm-state.json"), JSON.stringify(swarmState, null, 2) + "\n");

const tools = {};
const sentKeys = [];
const pi = {
	registerTool: (def) => { tools[def.name] = def; },
	registerCommand: () => {},
	on: () => {},
	sendMessage: () => {},
	exec: async (cmd, args) => {
		if (cmd !== "tmux") return { code: 1, stdout: "", stderr: "" };
		const sub = args[0];
		if (sub === "send-keys") { sentKeys.push(args.slice(1).join(" ")); return { code: 0, stdout: "", stderr: "" }; }
		// Allow other subcommands the factory may invoke (e.g. trace helpers) to be no-ops.
		return { code: 0, stdout: "", stderr: "" };
	},
};
factory(pi);

const call = async (name, params) => {
	const t = tools[name]; if (!t) throw new Error("no tool " + name);
	return t.execute("call", params, undefined, undefined, { cwd: scratch });
};

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log("  ok  ", n); } else { fail++; console.error("  FAIL", n); } };
const throws = async (n, p) => { try { await p; fail++; console.error("  FAIL", n, "(did not throw)"); } catch { pass++; console.log("  ok  ", n); } };

console.log("\n[A] reject when agentId resolves to root record (tmuxTarget === 'unknown')");
{
	sentKeys.length = 0;
	let caught;
	try {
		await call("swarm_send_keys", { agentId: "root", keys: "C-c" });
	} catch (e) {
		caught = e;
	}
	ok("A: throws an Error", caught instanceof Error);
	ok("A: error message starts with ROOT_PANE_REJECTED:", typeof caught?.message === "string" && caught.message.startsWith("ROOT_PANE_REJECTED:"));
	ok("A: error names the offending target", typeof caught?.message === "string" && caught.message.includes("unknown"));
	ok("A: error names the offending agentId", typeof caught?.message === "string" && caught.message.includes("agentId=root"));
	ok("A: send-keys spy NEVER invoked", sentKeys.length === 0);
}

console.log("\n[B] reject when ANY agent's resolved target equals the root target (ghost-agent variant)");
{
	sentKeys.length = 0;
	let caught;
	try {
		await call("swarm_send_keys", { agentId: "ghost", keys: "C-c" });
	} catch (e) {
		caught = e;
	}
	ok("B: throws ROOT_PANE_REJECTED (principle-based, NOT id-based)", caught instanceof Error && caught.message.startsWith("ROOT_PANE_REJECTED:"));
	ok("B: error names ghost agentId", caught?.message?.includes("agentId=ghost"));
	ok("B: send-keys spy NEVER invoked", sentKeys.length === 0);
}

console.log("\n[C] worker -> worker happy path is unchanged (tmux.exec called with the expected target)");
{
	sentKeys.length = 0;
	const r = await call("swarm_send_keys", { agentId: "w1", keys: "C-c" });
	ok("C: resolve returns a textResult", r?.content?.[0]?.text?.includes("w1"));
	ok("C: send-keys invoked exactly once", sentKeys.length === 1);
	ok("C: send-keys target is the worker's tmuxTarget", sentKeys[0]?.includes("-t test:w1.0") && sentKeys[0]?.includes("C-c"));
}

console.log("\n[D] unknown agentId still throws the existing 'Unknown swarm agent' error");
{
	sentKeys.length = 0;
	let caught;
	try {
		await call("swarm_send_keys", { agentId: "nope", keys: "C-c" });
	} catch (e) {
		caught = e;
	}
	ok("D: throws 'Unknown swarm agent: nope'", caught instanceof Error && caught.message === "Unknown swarm agent: nope");
	ok("D: send-keys spy NEVER invoked", sentKeys.length === 0);
}

console.log("\n[E] worker with empty tmuxTarget falls through to helper's existing error (preserved)");
{
	sentKeys.length = 0;
	let caught;
	try {
		await call("swarm_send_keys", { agentId: "w2", keys: "C-c" });
	} catch (e) {
		caught = e;
	}
	ok("E: throws 'agent has no tmux pane target' (helper error, NOT the new guard)", caught instanceof Error && caught.message === "agent has no tmux pane target");
	ok("E: send-keys spy NEVER invoked (helper refused before tmux call)", sentKeys.length === 0);
}

console.log("\n[F] worker with tmuxTarget=undefined also falls through (binding condition C2 coverage)");
{
	sentKeys.length = 0;
	let caught;
	try {
		await call("swarm_send_keys", { agentId: "w3", keys: "C-c" });
	} catch (e) {
		caught = e;
	}
	ok("F: throws 'agent has no tmux pane target' (helper error, NOT the new guard)", caught instanceof Error && caught.message === "agent has no tmux pane target");
	ok("F: send-keys spy NEVER invoked", sentKeys.length === 0);
}

console.log(`\n${fail === 0 ? "SEND-KEYS GUARD PASS" : "SEND-KEYS GUARD FAIL"} (${pass} passed, ${fail} failed)`);
rmSync(scratch, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
