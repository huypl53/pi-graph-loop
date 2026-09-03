// Issues A + B + C: reconcile re-injection of injected-unacked messages, stat-gated pump reads, and
// the idempotency index. End-to-end against real temp state + a mocked pi.exec (same pattern as
// functional.test.mjs).
//
// Run: node extensions/swarm/reconcile-reinject.test.mjs
import { rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const mod = await import(join(here, "..", "index.ts"));
const factory = mod.default;
const { reconcile } = await import(join(here, "..", "src/reconcile.ts"));
const { pruneState } = await import(join(here, "..", "src/gc.ts"));
const { paths } = await import(join(here, "..", "src/state.ts"));
const scratch = join(tmpdir(), `swarm-reinject-${process.pid}-${Date.now()}`);
rmSync(scratch, { recursive: true, force: true });
mkdirSync(join(scratch, ".pi/swarm/mailboxes"), { recursive: true });
mkdirSync(join(scratch, ".pi/swarm/traces/tmux"), { recursive: true });

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.error("  FAIL:", name); } };

// --- Issue C: idempotency index (O(1) lookup, correct result) ---
const { findIdempotentMessage } = await import(join(here, "..", "src/mailbox.ts")).catch(() => ({}));
{
	const st = { messages: {}, swarmId: "s" };
	for (let i = 0; i < 300; i++) {
		st.messages[`m${i}`] = { id: `m${i}`, from: i < 150 ? "root" : "planner", to: i < 150 ? "worker" : "root", status: "injected", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), attempts: 1, requiresAck: true, ...(i === 42 ? { idempotencyKey: "k42" } : {}) };
	}
	const hit = findIdempotentMessage(st, "root", "worker", "k42");
	ok("index finds existing idempotent record", hit?.id === "m42");
	ok("index misses absent key", findIdempotentMessage(st, "root", "worker", "nope") === undefined);
	ok("index built + cached", st.idempotencyIndex && Object.keys(st.idempotencyIndex).length === 1);
	st.messages.m2000 = { id: "m2000", from: "root", to: "worker", status: "injected", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), attempts: 1, requiresAck: true, idempotencyKey: "k43" };
	ok("index rebuilds on count change", findIdempotentMessage(st, "root", "worker", "k43")?.id === "m2000");
}

// --- Issue B: stat-gated mailbox read (identical semantics, cache hit on unchanged file) ---
{
	const { readMailbox, readMailboxCached } = await import(join(here, "..", "src/mailbox.ts"));
	const { mailboxPath } = await import(join(here, "..", "src/state.ts"));
	const p = { mailboxes: join(scratch, ".pi/swarm/mailboxes"), traces: join(scratch, ".pi/swarm/traces"), root: join(scratch, ".pi/swarm") };
	const file = mailboxPath(p, "root");
	const lines = [];
	for (let i = 0; i < 200; i++) lines.push(JSON.stringify({ id: `msg-${i}`, from: "a", to: "root", body: String(i), swarmId: "s", priority: "normal", type: "swarm.message", schemaVersion: 1, createdAt: new Date().toISOString(), requiresAck: true, headers: {} }));
	writeFileSync(file, lines.join("\n") + "\n");
	const a = await readMailbox(p, "root");
	ok("readMailbox parses all 200", a.length === 200);
	const b1 = await readMailboxCached(p, "root");
	const b2 = await readMailboxCached(p, "root");
	ok("cached read identical to full read", b1.length === 200 && b2.length === 200 && b1[0].id === b2[0].id);
	ok("second cached read returns SAME array (no re-parse)", b1 === b2);
	writeFileSync(file, lines.join("\n") + "\n" + JSON.stringify({ id: "msg-new", from: "a", to: "root", body: "x", swarmId: "s", priority: "normal", type: "swarm.message", schemaVersion: 1, createdAt: new Date().toISOString(), requiresAck: true, headers: {} }) + "\n");
	const b3 = await readMailboxCached(p, "root");
	ok("cache invalidates on append", b3.length === 201 && b3 !== b1);
}

// --- TTL issue: actionable unacked messages must not dead-letter on expiry ---
{
	const stateFile = join(scratch, ".pi/swarm/swarm-state.json");
	const old = new Date(Date.now() - 20 * 60_000).toISOString(); // old enough to trip TTL
	const msgId = "msg-repro-ttl";
	const state = {
		version: 1, swarmId: "s", cwd: scratch, tmuxSession: "sess",
		agents: {}, delivered: { root: [] },
		messages: {
			[msgId]: { id: msgId, from: "root", to: "worker-1", status: "queued", createdAt: old, updatedAt: old, attempts: 0, requiresAck: true, ttlMs: 1 },
		},
		createdAt: old, updatedAt: old,
	};
	writeFileSync(stateFile, JSON.stringify(state));

	const pi = { exec: async () => ({ code: 1, stdout: "", stderr: "" }), sendMessage: () => {}, registerTool: () => {}, registerCommand: () => {}, on: () => {} };
	const result = await reconcile(pi, scratch, paths(scratch), { dryRun: false, mark: false });
	const after = JSON.parse(readFileSync(stateFile, "utf8"));
	ok("ttl-expired actionable not dead_lettered", after.messages[msgId].status !== "dead_letter");
	ok("ttl-expired actionable remains queued", after.messages[msgId].status === "queued");
	ok("ttl-expired actionable ttl_stale surfaced", result.actions.some((a) => a.action === "ttl_stale"));

	after.messages[msgId] = { ...after.messages[msgId], status: "acked", ackedAt: old, updatedAt: old, lastAck: { by: "worker-1", status: "done", at: old } };
	writeFileSync(stateFile, JSON.stringify(after, null, 2));
	const postAck = JSON.parse(readFileSync(stateFile, "utf8"));
	const gcRes = pruneState(postAck, { keepMessages: 0 });
	ok("acked done becomes removable after TTL defer", gcRes.removed === 1);
	ok("acked done removed from state", !postAck.messages[msgId]);
}

// --- Issue A: reconcile re-injects injected-but-unacked (old) messages, bounded ---
{
	// Build a swarm state with one worker agent "worker-1" whose pane is alive and pi-like.
	const stateFile = join(scratch, ".pi/swarm/swarm-state.json");
	const old = new Date(Date.now() - 20 * 60_000).toISOString(); // 20 min ago > ACK_MISSING_MS / REINJECT_AFTER_MS
	const msgId = "msg-repro-a";
	const state = {
		version: 1, swarmId: "s", cwd: scratch, tmuxSession: "sess",
		agents: {
			"worker-1": { id: "worker-1", role: "worker", roleKind: "worker", capabilities: [], activeTaskIds: [], maxConcurrentTasks: 1, status: "running", runtimeStatus: "idle", health: "healthy", tmuxSession: "sess", tmuxWindow: "worker-1", tmuxTarget: "sess:worker-1.0", model: "m", provider: "p", cwd: scratch, mailbox: ".pi/swarm/mailboxes/worker-1.jsonl", createdAt: old, updatedAt: old },
		},
		delivered: { "worker-1": [] },
		messages: {
			[msgId]: { id: msgId, from: "root", to: "worker-1", status: "injected", createdAt: old, updatedAt: old, injectedAt: old, attempts: 1, requiresAck: true, reinjects: 0 },
		},
		createdAt: old, updatedAt: old,
	};
	writeFileSync(stateFile, JSON.stringify(state));
	writeFileSync(join(scratch, ".pi/swarm/mailboxes/worker-1.jsonl"), JSON.stringify({ id: msgId, swarmId: "s", from: "root", to: "worker-1", subject: "s", priority: "normal", type: "swarm.message", schemaVersion: 1, createdAt: old, body: "repro A", requiresAck: true, headers: {} }) + "\n");

	let sendKeysCalls = 0;
	const tools = {};
	const pi = {
		registerTool: (def) => { tools[def.name] = def; },
		registerCommand: () => {},
		on: () => {},
		exec: async (cmd, args) => {
			if (cmd === "tmux" && args[0] === "display-message") {
				// pane_alive probe (#{pane_id}) and pi-likeness probe (#{pane_current_command})
				const fmt = args[args.length - 1];
				return { code: 0, stdout: fmt.includes("pane_current_command") ? "node\n" : "%1\n", stderr: "" };
			}
			if (cmd === "tmux" && args[0] === "send-keys") { sendKeysCalls++; return { code: 0, stdout: "", stderr: "" }; }
			if (cmd === "tmux" && args[0] === "capture-pane") return { code: 0, stdout: "", stderr: "" };
			return { code: 1, stdout: "", stderr: "" };
		},
		sendMessage: () => {},
	};
	factory(pi);
	const rec = await tools["swarm_reconcile"].execute("c", { cwd: scratch }, undefined, undefined, { cwd: scratch });
	const text = rec?.content?.[0]?.text || "";
	ok("reconcile reports reinjected for old injected-unacked", /reinject/.test(text));
	ok("send-keys actually re-injected the message", sendKeysCalls >= 2 /* literal + Enter */);
	const after = JSON.parse(readFileSync(stateFile, "utf8"));
	const r = after.messages[msgId];
	ok("record reinjects incremented to 1", r.reinjects === 1);
	ok("record still injected (not dead_letter)", r.status === "injected");
	ok("attempts still below MAX_ATTEMPTS escalation", r.attempts <= 2);

	// Second immediate reconcile: lastReinjectAt is fresh -> NOT re-injected again (cooldown).
	sendKeysCalls = 0;
	await tools["swarm_reconcile"].execute("c", { cwd: scratch }, undefined, undefined, { cwd: scratch });
	ok("fresh re-injection is not immediately repeated (cooldown)", sendKeysCalls === 0);
	const after2 = JSON.parse(readFileSync(stateFile, "utf8"));
	ok("reinjects still 1 after immediate second reconcile", after2.messages[msgId].reinjects === 1);
}

console.log(`\n${fail === 0 ? "PASS" : "FAIL"}: ${pass} passed, ${fail} failed`);
rmSync(scratch, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
