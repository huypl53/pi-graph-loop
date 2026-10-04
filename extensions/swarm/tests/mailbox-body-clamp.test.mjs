#!/usr/bin/env node
// mailbox-body-clamp.test.mjs — F4 red tests (task-redteam-fixnow)
//
// swarm_send_message accepts UNBOUNDED bodies: a 2KB body persists as a ~2KB mailbox JSONL
// line, and scaled up the redteam PoC (/tmp/rt-edgeb/p7-mail/poc.mjs) showed a 200MB line
// costing +609MB RSS per reader parse. fullMailboxRow (check_mailbox fullBody:true) then
// returns the FULL body into model context with no cap.
//
// RED symptoms (pre-fix, observed against HEAD 6ff8ff8 + F1/F7/F8 fixes, which do not touch
// messages.ts send/fullBody paths):
//   [1] an oversized send (2KB, env cap 1024) SUCCEEDS instead of throwing
//       MESSAGE_BODY_TOO_LARGE (with actual size, cap, and env-var name);
//   [2] the oversized body IS persisted to the mailbox JSONL (silent write, not rejection);
//   [4] a 30KB body seeded via deliverMessageLocked comes back COMPLETE from
//       swarm_check_mailbox fullBody:true (no FULL_BODY_MAX_CHARS clamp, no escape-hint
//       suffix naming the mailbox file).
// GREEN contract (post-fix):
//   - send clamp at the tool boundary, env-tunable via PI_SWARM_MESSAGE_BODY_MAX_BYTES,
//     default 262144 (256KB); rejection is a THROW (pi-runtime-contract §9) BEFORE any
//     mailbox append or state write; in-cap sends unaffected (receipt in details.receipt);
//   - fullMailboxRow clamps bodies to FULL_BODY_MAX_CHARS (20000) chars + escape-hint suffix
//     naming the durable mailbox JSONL path;
//   - R10-1 zero-crossing: pi.sendMessage call count === 0 across rejected + in-cap sends
//     (the clamp adds NO new Pi-runtime boundary crossing);
//   - details.messages keeps raw full bodies (programmatic/harness escape, never model context).
//
// Run: PI_SWARM_MESSAGE_BODY_MAX_BYTES=1024 node extensions/swarm/tests/mailbox-body-clamp.test.mjs
// (The runner passes ambient env; the test asserts the env contract itself below and SKIPs
// with an explicit marker when the var is absent, mirroring minimal-protocol-shadow.test.mjs.)
import { rmSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

// --- env contract: this suite pins a NON-DEFAULT cap (1024) so the env-tunability AC is
// exercised end-to-end; constants.ts reads it at module load, BEFORE the import below.
const CAP = Number(process.env.PI_SWARM_MESSAGE_BODY_MAX_BYTES);
if (!Number.isInteger(CAP) || CAP <= 0) {
	console.log("SKIP: PI_SWARM_MESSAGE_BODY_MAX_BYTES required at process boot (env-conditional suite; runner passes ambient env)");
	process.exit(0);
}

const scratch = mkdtempSync(join(tmpdir(), `swarm-bodyclamp-${process.pid}-`));
rmSync(scratch, { recursive: true, force: true });
mkdirSync(join(scratch, ".pi", "swarm"), { recursive: true });

process.env.PI_SWARM_AGENT_ID = "root";
const mod = await import(join(here, "..", "index.ts"));
const factory = mod.default;
if (typeof factory !== "function") throw new Error("no default export");

// R10-1 counting stub: count calls at the REAL mock-pi sendMessage boundary.
let piSendMessageCalls = 0;
const tools = {};
const pi = {
	registerTool: (def) => {
		tools[def.name] = def;
	},
	registerCommand: () => {},
	on: () => {},
	exec: async () => ({ code: 1, stdout: "", stderr: "" }),
	sendMessage: (...args) => {
		piSendMessageCalls++;
		return {};
	},
};
factory(pi);

let pass = 0,
	fail = 0;
const ok = (n, c, info) => {
	if (c) {
		pass++;
		console.log("  ok  ", n);
	} else {
		fail++;
		console.error("  FAIL", n, info ?? "");
	}
};

const call = async (name, params) => {
	const t = tools[name];
	if (!t) throw new Error("no tool " + name);
	return t.execute("call", params, undefined, undefined, { cwd: scratch });
};

writeFileSync(
	join(scratch, ".pi", "swarm", "swarm-state.json"),
	JSON.stringify(
		{
			version: 1,
			swarmId: "bodyclamp-test",
			cwd: scratch,
			tmuxSession: "x",
			agents: {
				root: { id: "root", role: "root", roleKind: "root", status: "running", runtimeStatus: "idle", tmuxPane: "%0" },
				"clamp-worker": { id: "clamp-worker", role: "worker", roleKind: "worker", status: "running", runtimeStatus: "idle", tmuxPane: "%1" },
			},
			delivered: {},
			messages: {},
			rootPumpSessions: {},
		},
		null,
		2,
	),
);

const mailboxFile = join(scratch, ".pi", "swarm", "mailboxes", "clamp-worker.jsonl");
const mailboxLines = () => (existsSync(mailboxFile) ? readFileSync(mailboxFile, "utf8").split("\n").filter(Boolean).length : 0);
const readStMessages = () => {
	const st = JSON.parse(readFileSync(join(scratch, ".pi", "swarm", "swarm-state.json"), "utf8"));
	return Object.keys(st.messages || {}).length;
};

// ---------------------------------------------------------------------------
console.log("\n[1] oversized send throws MESSAGE_BODY_TOO_LARGE with size/cap/env-name");
{
	const oversized = "X".repeat(2 * CAP); // 2KB body under the 1KB test cap
	let threw = null;
	try {
		await call("swarm_send_message", { to: "clamp-worker", subject: "oversized", body: oversized });
	} catch (err) {
		threw = err;
	}
	ok(
		"send throws with MESSAGE_BODY_TOO_LARGE",
		threw !== null && String(threw.message).includes("MESSAGE_BODY_TOO_LARGE"),
		threw ? `wrong error: ${String(threw.message).slice(0, 120)}` : "no throw — oversized body accepted",
	);
	ok(
		"error carries formatted actual size, cap, and env var name",
		threw !== null && String(threw.message).includes("2.0KB") && String(threw.message).includes("1.0KB") && String(threw.message).includes("PI_SWARM_MESSAGE_BODY_MAX_BYTES"),
		threw ? `message=${String(threw.message).slice(0, 200)}` : "no throw",
	);
}

// ---------------------------------------------------------------------------
console.log("\n[2] nothing persisted after the rejected send");
{
	ok("mailbox JSONL has 0 lines (no append)", mailboxLines() === 0, `lines=${mailboxLines()}`);
	ok("st.messages unchanged (0 records)", readStMessages() === 0, `records=${readStMessages()}`);
}

// ---------------------------------------------------------------------------
console.log("\n[3] in-cap control send succeeds with receipt");
{
	let result = null;
	let threw = null;
	try {
		result = await call("swarm_send_message", { to: "clamp-worker", subject: "control", body: "small control body" });
	} catch (err) {
		threw = err;
	}
	ok("in-cap send does not throw", threw === null, threw ? String(threw.message).slice(0, 120) : "");
	const receipt = result?.details?.receipt;
	ok("receipt present in details", Boolean(receipt?.messageId));
	ok("receipt points at the clamp-worker mailbox", typeof receipt?.mailboxPath === "string" && receipt.mailboxPath.endsWith("clamp-worker.jsonl"));
	ok("in-cap body persisted (1 line)", mailboxLines() === 1, `lines=${mailboxLines()}`);
}

// ---------------------------------------------------------------------------
console.log("\n[4] fullMailboxRow truncates giant bodies with an escape-hint suffix");
{
	// Seed a 30KB body through the REAL delivery path (in-cap under the 256KB default, so this
	// also proves the DEFAULT cap is not the test cap — but this suite runs with cap=1024, so
	// seed via deliverMessageLocked-equivalent: a direct enqueueAndDeliver through the send tool
	// would throw under cap=1024. Instead write a legacy/out-of-band line the way the PoC did,
	// then read it back through check_mailbox fullBody:true — the truncation exists precisely
	// for out-of-band/legacy giant lines the send clamp cannot see.)
	mkdirSync(join(scratch, ".pi", "swarm", "mailboxes"), { recursive: true });
	const giant = "Y".repeat(30_000);
	const legacyMsg = {
		id: "msg-legacy-giant-1",
		swarmId: "bodyclamp-test",
		from: "root",
		to: "clamp-worker",
		type: "user",
		schemaVersion: 1,
		priority: "normal",
		requiresAck: false,
		idempotencyKey: undefined,
		subject: "legacy giant",
		body: giant,
		conversationId: undefined,
		replyTo: undefined,
		createdAt: new Date().toISOString(),
	};
	readFileSync; // (keep import used)
	const { appendFileSync } = await import("node:fs");
	appendFileSync(mailboxFile, JSON.stringify(legacyMsg) + "\n");

	const view = await call("swarm_check_mailbox", { agentId: "clamp-worker", fullBody: true });
	const compact = JSON.parse(view.content[0].text);
	const row = (compact.messages || []).find((m) => m.id === "msg-legacy-giant-1");
	ok("giant message returned in fullBody view", Boolean(row), `rows=${(compact.messages || []).length}`);
	const { FULL_BODY_MAX_CHARS } = await import(join(here, "..", "src", "constants.ts"));
	ok(
		"fullBody body clamped to FULL_BODY_MAX_CHARS + suffix",
		typeof row?.body === "string" && row.body.length <= FULL_BODY_MAX_CHARS + 400 && row.body.includes(`…[+${giant.length - FULL_BODY_MAX_CHARS} chars truncated — full body durable in mailbox JSONL:`),
		`len=${row?.body?.length} FULL_BODY_MAX_CHARS=${FULL_BODY_MAX_CHARS}`,
	);
	ok(
		"escape hint names the mailbox JSONL path",
		typeof row?.body === "string" && row.body.includes("clamp-worker.jsonl"),
		`tail=${String(row?.body).slice(-160)}`,
	);
	ok(
		"details.messages keeps the RAW full body (programmatic escape, not model context)",
		(view.details?.messages || []).some((m) => m.id === "msg-legacy-giant-1" && m.body === giant),
	);
}

// ---------------------------------------------------------------------------
console.log("\n[5] R10-1 zero-crossing: no pi.sendMessage calls across rejected + in-cap sends");
ok(`pi.sendMessage call count === 0 (got ${piSendMessageCalls})`, piSendMessageCalls === 0);

// ---------------------------------------------------------------------------
console.log("\n[6] constants surface: default cap + tunable read");
{
	const consts = await import(join(here, "..", "src", "constants.ts"));
	ok("PI_SWARM_MESSAGE_BODY_MAX_BYTES honors env (1024)", consts.PI_SWARM_MESSAGE_BODY_MAX_BYTES === CAP, `got=${consts.PI_SWARM_MESSAGE_BODY_MAX_BYTES}`);
	ok("DEFAULT_MESSAGE_BODY_MAX_BYTES is 256KiB", consts.DEFAULT_MESSAGE_BODY_MAX_BYTES === 256 * 1024, `got=${consts.DEFAULT_MESSAGE_BODY_MAX_BYTES}`);
	ok("FULL_BODY_MAX_CHARS is 20000", consts.FULL_BODY_MAX_CHARS === 20_000, `got=${consts.FULL_BODY_MAX_CHARS}`);
}

rmSync(scratch, { recursive: true, force: true });
console.log(`\nResults: ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
