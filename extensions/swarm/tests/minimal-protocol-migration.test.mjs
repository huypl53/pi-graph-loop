#!/usr/bin/env node
/**
 * Minimal-protocol Phase 1 — migration command idempotence + no-fabrication tests (Issue 25).
 *
 * Invariants under test:
 *   - /swarm protocol migrate scans every record and stamps mailboxDeliveredAt from
 *     delivered[to] entries (transport-only, never invents seen/responded/processing/terminal).
 *   - A SECOND run yields migrated=0 (idempotence). Already-migrated records are skipped.
 *   - /swarm protocol migrate --dry-run does NOT write state but emits the same trace plan.
 *   - No record ends up with fabricated seenAt, processingAt, respondedAt, or terminalAt.
 *
 * Pattern: real extension factory, in-memory mock pi, asserts on durable state + events.jsonl.
 */
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const scratch = await mkdtemp(join(tmpdir(), `swarm-minimal-protocol-migration-${process.pid}-${Date.now()}`));
await mkdir(join(scratch, ".pi"), { recursive: true });

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log("  ok  ", name); } else { fail++; console.error("  FAIL", name); } };

// ---- helpers ----
async function readGlobalEvents() {
	const p = join(scratch, ".pi/swarm/traces/events.jsonl");
	const txt = await readFile(p, "utf8").catch(() => "");
	return txt.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
async function readStateFile() {
	const p = join(scratch, ".pi/swarm/swarm-state.json");
	try { return JSON.parse(await readFile(p, "utf8")); } catch { return null; }
}
async function loadExtension({ identity = "root" } = {}) {
	process.env.PI_SWARM_AGENT_ID = identity;
	const tools = {};
	const commands = {};
	const handlers = {};
	const notifies = [];
	const pi = {
		registerTool: (def) => { tools[def.name] = def; },
		registerCommand: (name, def) => { commands[name] = def; },
		on: (ev, fn) => { (handlers[ev] ||= []).push(fn); },
		exec: async (cmd, args) => {
			if (cmd === "tmux" && args?.[0] === "display-message") return { code: 0, stdout: "%1\n", stderr: "" };
			return { code: 1, stdout: "", stderr: "" };
		},
		setModel: async () => true,
		sendMessage: () => {},
	};
	const mod = await import(join(here, "..", "index.ts"));
	mod.default(pi);
	const ctxFactory = (extra = {}) => Object.assign({ cwd: scratch, mode: "tui", hasUI: false, ui: { notify: (text, level) => notifies.push({ text, level }), setStatus: () => {} } }, extra);
	return { pi, tools, commands, handlers, notifies, ctxFactory };
}

function seedStateFixture(N = 50, alreadyMigrated = 10) {
	const ts = new Date().toISOString();
	const messages = {};
	const delivered = {};
	for (let i = 0; i < N; i++) {
		const id = `msg-${i}`;
		const isMigrated = i < alreadyMigrated;
		const isTransportStamped = i % 2 === 0; // half have a delivered[to] entry
		messages[id] = {
			id,
			from: "root",
			to: "worker-a",
			status: "injected",
			createdAt: ts,
			updatedAt: ts,
			injectedAt: ts,
			attempts: 1,
			requiresAck: true,
			...(isMigrated ? { migrationRunId: "pmig-prior-run-xxx", migratedAt: ts } : {}),
		};
		if (isTransportStamped) {
			(delivered["worker-a"] ||= []).push(id);
		}
	}
	return {
		version: 1, swarmId: "test", cwd: scratch, tmuxSession: "test",
		agents: {
			"root": { id: "root", role: "root", roleKind: "root", capabilities: [], activeTaskIds: [], maxConcurrentTasks: 99, status: "running", runtimeStatus: "idle", health: "healthy", tmuxSession: "test", tmuxWindow: "orch", tmuxTarget: "test:orch.0", model: "glm-5.1", provider: "zai-coding-cn", cwd: scratch, mailbox: ".pi/swarm/mailboxes/root.jsonl", createdAt: ts, updatedAt: ts },
			"worker-a": { id: "worker-a", role: "worker", roleKind: "worker", capabilities: [], activeTaskIds: [], maxConcurrentTasks: 1, status: "running", runtimeStatus: "idle", health: "healthy", tmuxSession: "test", tmuxWindow: "worker-a", tmuxTarget: "test:worker-a.0", model: "glm-5.1", provider: "zai-coding-cn", cwd: scratch, mailbox: ".pi/swarm/mailboxes/worker-a.jsonl", createdAt: ts, updatedAt: ts },
		},
		delivered,
		messages,
	};
}

// ============================================================
// Scenario 1: dry-run does not mutate state but emits plan + completion traces
// ============================================================
{
	console.log("\n--- Scenario 1: --dry-run emits plan + completion, NO state write ---");
	await rm(join(scratch, ".pi"), { recursive: true, force: true });
	await mkdir(join(scratch, ".pi/swarm"), { recursive: true });
	await writeFile(join(scratch, ".pi/swarm/swarm-state.json"), JSON.stringify(seedStateFixture(50, 10), null, 2), "utf8");
	const beforeContent = await readFile(join(scratch, ".pi/swarm/swarm-state.json"), "utf8");

	const { commands, notifies, ctxFactory } = await loadExtension({ identity: "root" });
	await commands.swarm.handler("protocol migrate --dry-run", ctxFactory());

	const afterContent = await readFile(join(scratch, ".pi/swarm/swarm-state.json"), "utf8");
	ok("dry-run does NOT mutate swarm-state.json", beforeContent === afterContent);

	const events = await readGlobalEvents();
	const records = events.filter((e) => e.event === "protocol.migration.record");
	ok("protocol.migration.record emitted per record (dry-run)", records.length === 50);
	const completions = events.filter((e) => e.event === "protocol.migration.completed");
	ok("protocol.migration.completed emitted exactly once", completions.length === 1);
	if (completions.length) {
		ok("completion is dryRun=true", completions[0].dryRun === true);
		ok("completion scanned=50", completions[0].scanned === 50);
		ok("completion migrated=0 in dry-run (no writes)", completions[0].migrated === 0);
		// Fixture: 10 already-migrated skip; 25 delivered[] entries; 5 of those 25 overlap the
		// already-migrated set; 20 delivered-but-unmigrated are PLAN-eligible (skipped==30,
		// migrated==0 under dry-run); remaining 20 have no delivered[] -> skipped. Total = 30.
		ok("completion skipped=30 (10 already + 20 without transport)", completions[0].skipped === 30);
	}
	ok("notifies contains the migration summary", notifies.some((n) => String(n.text).includes("Migration") && String(n.text).includes("dry-run")));
}

// ============================================================
// Scenario 2: real run stamps transport-only mailboxDeliveredAt, no fabrication
// ============================================================
{
	console.log("\n--- Scenario 2: real run stamps mailboxDeliveredAt from delivered[]; no fabrication ---");
	await rm(join(scratch, ".pi"), { recursive: true, force: true });
	await mkdir(join(scratch, ".pi/swarm"), { recursive: true });
	await writeFile(join(scratch, ".pi/swarm/swarm-state.json"), JSON.stringify(seedStateFixture(50, 10), null, 2), "utf8");

	const { commands, ctxFactory } = await loadExtension({ identity: "root" });
	await commands.swarm.handler("protocol migrate", ctxFactory());

	const after = await readStateFile();
	ok("state file exists", after !== null);
	// Half (25) had delivered[] entries; of those, 5 were already migrated. So 20 should be stamped.
	let stamped = 0; let fabricated = 0;
	for (const rec of Object.values(after.messages)) {
		if (rec.mailboxDeliveredAt) stamped++;
		if (rec.seenAt || rec.processingAt || rec.respondedAt || rec.terminalAt) fabricated++;
	}
	ok("only transport-only mailboxDeliveredAt stamped", stamped === 20);
	ok("NO seen/processing/responded/terminal fabricated", fabricated === 0);

	const events = await readGlobalEvents();
	const completions = events.filter((e) => e.event === "protocol.migration.completed");
	if (completions.length) {
		const c = completions[0];
		ok("completion scanned=50", c.scanned === 50);
		ok("completion migrated=20", c.migrated === 20);
		ok("completion skipped=30 (10 already + 20 without transport)", c.skipped === 30);
		ok("completion dryRun=false", c.dryRun === false);
	}

	// Each stamped record must carry a migrationRunId + migratedAt from this run.
	const stampedRunIds = new Set(Object.values(after.messages).filter((r) => r.mailboxDeliveredAt).map((r) => r.migrationRunId));
	ok("all stamped records share one migrationRunId", stampedRunIds.size === 1);
	ok("at least one stamped record has migratedAt", Object.values(after.messages).some((r) => r.migratedAt && r.mailboxDeliveredAt));
}

// ============================================================
// Scenario 3: idempotence — second run yields migrated=0
// ============================================================
{
	console.log("\n--- Scenario 3: idempotence (second run -> migrated=0) ---");
	const { commands, ctxFactory } = await loadExtension({ identity: "root" });
	await commands.swarm.handler("protocol migrate", ctxFactory());

	const after = await readStateFile();
	let stamped = 0;
	for (const rec of Object.values(after.messages)) if (rec.mailboxDeliveredAt) stamped++;
	ok("still exactly 20 records stamped (no further work)", stamped === 20);

	const events = await readGlobalEvents();
	const completions = events.filter((e) => e.event === "protocol.migration.completed");
	const last = completions[completions.length - 1];
	ok("second-run completion present", Boolean(last));
	if (last) {
		ok("second run migrated=0", last.migrated === 0);
		ok("second run skipped=50 (all carry migrationRunId now)", last.skipped === 50);
	}
}

// ============================================================
// Scenario 4: usage error path — unknown subcommand + missing sub
// ============================================================
{
	console.log("\n--- Scenario 4: usage error paths ---");
	const { commands, notifies, ctxFactory } = await loadExtension({ identity: "root" });
	await commands.swarm.handler("protocol foo", ctxFactory());
	ok("unknown sub -> usage warning", notifies.some((n) => String(n.text).includes("Usage: /swarm protocol migrate")));
	notifies.length = 0;
	await commands.swarm.handler("protocol", ctxFactory());
	ok("no sub -> usage warning", notifies.some((n) => String(n.text).includes("Usage: /swarm protocol migrate")));
}

console.log(`\n${pass} pass, ${fail} fail`);
if (fail > 0) process.exit(1);
