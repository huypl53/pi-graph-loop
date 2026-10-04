#!/usr/bin/env node
// admin-literal-removal.test.mjs — F8 red tests (task-redteam-fixnow)
//
// The swarm tool surface carried a hard-privileged id literal: `me === "admin"` at
// tools/gating.ts:98 and tools/messages.ts:554 granted the FULL registered swarm tool set and
// the root-only reconcile scope to anyone who set PI_SWARM_AGENT_ID=admin — an id that
// isRootAuthority (identity.ts:36-38) does not know and that has no registration path. That is
// a defense-in-depth inconsistency: the second gate (authority) rejects the id, but the first
// gate (tier gating) and the reconcile scope gate trusted it. Redteam finding F8
// (task-redteam-20261003), PoC /tmp/rt-guarda/5-admin-id.
//
// RED symptoms (pre-fix, observed against HEAD 6ff8ff8):
//   [1] PI_SWARM_AGENT_ID="admin" (no PI_SWARM_ADMIN_MODE) yields the FULL registered swarm
//       tool set via applySwarmToolGating — not the 5-tool worker allowlist.
//   [2] The same identity executes swarm_reconcile scope:"all" dryRun:true WITHOUT the
//       SCOPE_FORBIDDEN throw (messages.ts:554-556 grants isPrivileged).
// Controls that must pass both pre- and post-fix:
//   [3] isRootAuthority("admin") === false (already true).
//   [4] PI_SWARM_ADMIN_MODE=1 keeps the documented full-set recovery path ([5b] of
//       tool-gating.validate.mjs stays green).
//   [5] Static anti-resurrection pin: neither source file contains a standalone "admin"
//       string literal (the env key PI_SWARM_ADMIN_MODE must not match).
//
// Run: node extensions/swarm/tests/admin-literal-removal.test.mjs
import { rmSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "swarm-admin-literal-"));
// Registered worker lanes run with root env by default in the suite runner; this suite drives
// identities per-case, so the id is set explicitly below. Isolated scratch cwd keeps any
// reconcile traces out of the repo.
delete process.env.PI_SWARM_ADMIN_MODE;
delete process.env.PI_SWARM_IS_ROOT;

let pass = 0,
	fail = 0;
const ok = (n, c, extra = "") => {
	if (c) {
		pass++;
		console.log("  ok  ", n);
	} else {
		fail++;
		console.error("  FAIL", n, extra);
	}
};

// --- faithful mock pi (tool-gating.validate.mjs pattern) ---
const mod = await import(join(here, "..", "index.ts"));
const factory = mod.default;
if (typeof factory !== "function") throw new Error("no default export");

const toolDefs = new Map();
const activeTools = new Set();
const commands = [];
const pi = {
	registerTool: (def) => {
		toolDefs.set(def.name, def);
		activeTools.add(def.name);
	},
	registerCommand: (name) => commands.push(name),
	on: () => {},
	getActiveTools: () => [...activeTools],
	getAllTools: () => [...toolDefs.values()].map((d) => ({ name: d.name })),
	setActiveTools: (names) => {
		activeTools.clear();
		for (const n of names) activeTools.add(n);
	},
	exec: async () => ({ code: 1, stdout: "", stderr: "" }),
	sendMessage: () => {},
};
factory(pi);

const swarmRegistered = [...toolDefs.keys()].filter((n) => n.startsWith("swarm_"));
const swarmActive = () => [...activeTools].filter((n) => n.startsWith("swarm_"));

const { WORKER_TOOL_ALLOWLIST } = await import(join(here, "..", "src", "constants.ts"));
const { isRootAuthority } = await import(join(here, "..", "src", "identity.ts"));
const { applySwarmToolGating } = await import(join(here, "..", "src", "tools", "gating.ts"));

// ---------------------------------------------------------------------------
// [1] tier gating: PI_SWARM_AGENT_ID="admin" (admin-mode UNSET) -> worker-tier active set
// ---------------------------------------------------------------------------
console.log("\n[1] PI_SWARM_AGENT_ID=admin (no admin mode) -> worker-tier active set");
process.env.PI_SWARM_AGENT_ID = "admin";
delete process.env.PI_SWARM_ADMIN_MODE;
applySwarmToolGating(pi);
const adminActive = swarmActive().sort();
ok(
	"admin id does NOT get all registered swarm tools active",
	adminActive.length === WORKER_TOOL_ALLOWLIST.size,
	`got=${adminActive.length}/${swarmRegistered.length} active=[${adminActive.join(",")}]`,
);

// ---------------------------------------------------------------------------
// [2] execution authority: swarm_reconcile scope:"all" as the admin id throws SCOPE_FORBIDDEN
// ---------------------------------------------------------------------------
console.log("\n[2] swarm_reconcile scope:all as PI_SWARM_AGENT_ID=admin throws SCOPE_FORBIDDEN");
{
	// Seed a minimal swarm-state so paths()/readState inside the tool don't hit a missing dir
	// mid-privilege-check (the throw must come from the scope gate, not from I/O).
	const stateDir = join(scratch, ".pi", "swarm");
	rmSync(stateDir, { recursive: true, force: true });
	const tools = {};
	const pi2 = {
		registerTool: (def) => {
			tools[def.name] = def;
		},
		registerCommand: () => {},
		on: () => {},
		exec: async () => ({ code: 1, stdout: "", stderr: "" }),
		sendMessage: () => {},
	};
	factory(pi2);
	let threw = null;
	try {
		await tools["swarm_reconcile"].execute("call", { scope: "all", dryRun: true }, undefined, undefined, { cwd: scratch });
	} catch (err) {
		threw = err;
	}
	ok(
		"reconcile scope:all is refused for the admin id",
		threw !== null && String(threw.message).includes("SCOPE_FORBIDDEN"),
		threw ? `unexpected error: ${String(threw.message).slice(0, 120)}` : "no throw — privilege check passed",
	);
}

// ---------------------------------------------------------------------------
// [3] CONTROL: isRootAuthority("admin") is false (authority gate already root-only)
// ---------------------------------------------------------------------------
console.log("\n[3] CONTROL isRootAuthority");
ok("isRootAuthority('admin') === false", isRootAuthority("admin") === false);
ok("isRootAuthority('root') === true", isRootAuthority("root") === true);

// ---------------------------------------------------------------------------
// [4] CONTROL: PI_SWARM_ADMIN_MODE=1 recovery path retained (full registered set)
// ---------------------------------------------------------------------------
console.log("\n[4] CONTROL PI_SWARM_ADMIN_MODE=1 recovery path");
process.env.PI_SWARM_AGENT_ID = "worker";
process.env.PI_SWARM_ADMIN_MODE = "1";
applySwarmToolGating(pi);
ok(
	"admin-mode env still yields the full registered swarm set",
	swarmActive().length === swarmRegistered.length,
	`${swarmActive().length}/${swarmRegistered.length}`,
);
delete process.env.PI_SWARM_ADMIN_MODE;
applySwarmToolGating(pi);
ok(
	"worker id back on the worker allowlist after admin mode cleared",
	swarmActive().length === WORKER_TOOL_ALLOWLIST.size,
	`${swarmActive().length}/${WORKER_TOOL_ALLOWLIST.size}`,
);

// ---------------------------------------------------------------------------
// [5] STATIC anti-resurrection pin: no standalone 'admin' literal in the gated sources
// ---------------------------------------------------------------------------
console.log("\n[5] STATIC: no hard-privileged 'admin' literal remains");
const gateSrc = readFileSync(join(here, "..", "src", "tools", "gating.ts"), "utf8");
const msgsSrc = readFileSync(join(here, "..", "src", "tools", "messages.ts"), "utf8");
const adminLiteral = /["']admin["']/;
ok("tools/gating.ts has no standalone 'admin' literal", !adminLiteral.test(gateSrc));
ok("tools/messages.ts has no standalone 'admin' literal", !adminLiteral.test(msgsSrc));
ok("PI_SWARM_ADMIN_MODE env key survives in both (recovery path documented)", gateSrc.includes("PI_SWARM_ADMIN_MODE") && msgsSrc.includes("PI_SWARM_ADMIN_MODE"));

rmSync(scratch, { recursive: true, force: true });
console.log(`\nResults: ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
