#!/usr/bin/env node
/**
 * Regression: swarm_reconcile supports result pagination via offset.
 *
 * Reproduction before the fix: seed three old queued messages, call the real tool with
 * offset=2, and observe that all three old actions are returned again with no nextOffset.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const scratch = join(tmpdir(), `swarm-reconcile-offset-${process.pid}-${Date.now()}`);
rmSync(scratch, { recursive: true, force: true });
mkdirSync(join(scratch, ".pi/swarm/mailboxes"), { recursive: true });
mkdirSync(join(scratch, ".pi/swarm/traces"), { recursive: true });

process.env.PI_SWARM_AGENT_ID = "root";
const { default: factory } = await import(join(here, "..", "index.ts"));

const old = new Date(Date.now() - 60_000).toISOString();
const messages = Object.fromEntries(["msg-old-1", "msg-old-2", "msg-new-3"].map((id) => [id, {
	id,
	from: "root",
	to: "worker-1",
	status: "queued",
	createdAt: old,
	updatedAt: old,
	attempts: 0,
	requiresAck: true,
}]));
writeFileSync(join(scratch, ".pi/swarm/swarm-state.json"), JSON.stringify({
	version: 1,
	swarmId: "swarm-offset-test",
	cwd: scratch,
	tmuxSession: "none",
	agents: {},
	delivered: { "worker-1": [] },
	messages,
	createdAt: old,
	updatedAt: old,
}, null, 2));

const tools = {};
factory({
	registerTool: (tool) => { tools[tool.name] = tool; },
	registerCommand: () => {},
	on: () => {},
	exec: async () => ({ code: 1, stdout: "", stderr: "" }),
	sendMessage: () => {},
});

let pass = 0;
let fail = 0;
const ok = (name, condition, detail) => {
	if (condition) { pass++; console.log("  ok  ", name); }
	else { fail++; console.error("  FAIL", name, detail ?? ""); }
};

const tool = tools.swarm_reconcile;
const result = await tool.execute("offset-call", { dryRun: true, offset: 2 }, undefined, undefined, { cwd: scratch });
const details = result.details || {};

ok("offset=2 skips the first two reconciliation actions", details.actions?.length === 1, details.actions);
ok("the returned action starts at the requested offset", details.actions?.[0]?.messageId === "msg-new-3", details.actions);
ok("totalCount preserves the full action count", details.totalCount === 3, details);
ok("offset is echoed in result metadata", details.offset === 2, details);
ok("nextOffset advances by the returned page", details.nextOffset === 3, details);
ok("hasMore is false at the end", details.hasMore === false, details);
ok("text summary reports returned vs total counts", /Reconciled 1 of 3 item\(s\).*offset 2/.test(result.content?.[0]?.text || ""), result.content?.[0]?.text);

console.log(`\n${fail === 0 ? "PASS" : "FAIL"}: ${pass} passed, ${fail} failed`);
rmSync(scratch, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
