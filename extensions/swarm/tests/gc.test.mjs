// gc.test.mjs — unit tests for bounded retention/GC (pruneState).
// Covers: terminal-tail bounding by updatedAt, actionable preservation (incl. old actionable),
// keepMessages boundaries (0 / >= total / default), idempotency, delivered cap (intersection-safe),
// and a TTL-age regression check for actionable messages.
// Run: node extensions/swarm/gc.test.mjs
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const { pruneState, DEFAULT_KEEP_MESSAGES } = await import(join(here, "..", "src", "gc.ts"));
const scratch = join(tmpdir(), `swarm-gc-${process.pid}-${Date.now()}`);
rmSync(scratch, { recursive: true, force: true });

let fail = 0;
const ok = (n, c) => { if (c) console.log("  ok  ", n); else { fail++; console.error("  FAIL", n); } };

// --- helpers ---------------------------------------------------------------
const EPOCH = Date.UTC(2026, 0, 1);
const ts = (i) => new Date(EPOCH + i * 1000).toISOString();

function mkMsg(id, overrides = {}) {
	return {
		id, from: "orchestrator", to: "worker",
		status: "queued",
		createdAt: ts(0), updatedAt: ts(0),
		attempts: 0, requiresAck: true,
		...overrides,
	};
}
const queued = (id, i) => mkMsg(id, { status: "queued", updatedAt: ts(i) });
const failedMsg = (id, i) => mkMsg(id, { status: "failed", updatedAt: ts(i) });
const ackedDone = (id, i) => mkMsg(id, { status: "acked", updatedAt: ts(i), ackedAt: ts(i), lastAck: { by: "worker", status: "done", at: ts(i) } });
const deadLetter = (id, i) => mkMsg(id, { status: "dead_letter", updatedAt: ts(i) });
const verified = (id, i) => mkMsg(id, { status: "acked", updatedAt: ts(i), ackedAt: ts(i), lastAck: { by: "worker", status: "done", at: ts(i) }, response: { status: "verified", verifiedAt: ts(i) } });

function makeState(messages, delivered = {}, cwd = scratch) {
	return {
		version: 1, swarmId: "swarm-test", cwd,
		tmuxSession: "pi-swarm-test",
		agents: {}, delivered, messages,
		createdAt: ts(0), updatedAt: ts(0),
	};
}

// 640 messages: 40 recent actionable queued (newest) + 200 old acked-done + 200 old dead_letter + 200 old verified-response.
function buildMainState() {
	const messages = {};
	for (let i = 0; i < 40; i++) messages[`queued-${i}`] = queued(`queued-${i}`, 600 + i); // i=600..639 (newest)
	for (let i = 0; i < 200; i++) messages[`done-${i}`] = ackedDone(`done-${i}`, i);          // i=0..199
	for (let i = 0; i < 200; i++) messages[`dead-${i}`] = deadLetter(`dead-${i}`, 200 + i);    // i=200..399
	for (let i = 0; i < 200; i++) messages[`ver-${i}`] = verified(`ver-${i}`, 400 + i);        // i=400..599
	return makeState(messages);
}

// --- 1. Main scenario (600+ messages, keepMessages=100, kept<=100) --------
{
	const st = buildMainState();
	const total = Object.keys(st.messages).length;
	ok("main total is 640", total === 640);
	const res = pruneState(st, { keepMessages: 100 });
	ok("main removed=540", res.removed === 540);
	ok("main kept=100", res.kept === 100);
	ok("main kept<=100", res.kept <= 100);
	ok("main removed+kept==total", res.removed + res.kept === total);
	ok("all 40 recent queued preserved", Object.keys(st.messages).filter((id) => id.startsWith("queued-")).length === 40);
	ok("all old dead_letter dropped", Object.keys(st.messages).filter((id) => id.startsWith("dead-")).length === 0);
	ok("all old acked-done dropped", Object.keys(st.messages).filter((id) => id.startsWith("done-")).length === 0);
	ok("verified kept=60 (in window), dropped=140 (beyond tail)", Object.keys(st.messages).filter((id) => id.startsWith("ver-")).length === 60);
}

// --- 2. Never drop an OLD actionable message (even beyond the window) -----
{
	const messages = { "old-failed": failedMsg("old-failed", 0) }; // oldest, actionable
	for (let i = 1; i <= 200; i++) messages[`d-${i}`] = deadLetter(`d-${i}`, i); // newer terminal
	const st = makeState(messages);
	const res = pruneState(st, { keepMessages: 10 });
	ok("old-actionable removed=190", res.removed === 190);
	ok("old-actionable kept=11 (10 window + 1 old failed)", res.kept === 11);
	ok("old failed survived despite being oldest", !!st.messages["old-failed"]);
}

// --- 3. keepMessages:0 drops all terminal, keeps all actionable -----------
{
	const st = makeState({
		a: queued("a", 0), b: failedMsg("b", 1),
		c: deadLetter("c", 2), d: ackedDone("d", 3), e: verified("e", 4),
	});
	const res = pruneState(st, { keepMessages: 0 });
	ok("km0 removed=3 (c,d,e terminal)", res.removed === 3);
	ok("km0 kept=2 (a,b actionable)", res.kept === 2);
	ok("km0 a survived", !!st.messages.a);
	ok("km0 b survived", !!st.messages.b);
}

// --- 4. TTL-expired actionable message stays until terminal --------------
{
	const ttlActionable = queued("ttl-actionable", 0);
	ttlActionable.ttlMs = 1;
	const st = makeState({ "ttl-actionable": ttlActionable });
	const res = pruneState(st, { keepMessages: 0 });
	ok("ttl-expired actionable removed=0", res.removed === 0);
	ok("ttl-expired actionable kept=1", res.kept === 1);
	ok("ttl-expired actionable survived despite age>TTL", !!st.messages["ttl-actionable"]);

	st.messages["ttl-actionable"] = ackedDone("ttl-actionable", 1);
	st.messages["ttl-actionable"].ttlMs = 1;
	const doneRes = pruneState(st, { keepMessages: 0 });
	ok("ttl-expired acked-done removed=1", doneRes.removed === 1);
	ok("ttl-expired acked-done removed from state", !st.messages["ttl-actionable"]);
}

// --- 5. keepMessages >= total keeps everything ----------------------------
{
	const st = buildMainState();
	const res = pruneState(st, { keepMessages: 10000 });
	ok("huge keepMessages removed=0", res.removed === 0);
	ok("huge keepMessages kept=640", res.kept === 640);
}

// --- 6. Default keepMessages = 500 ----------------------------------------
{
	ok("DEFAULT_KEEP_MESSAGES is 500", DEFAULT_KEEP_MESSAGES === 500);
	const messages = {};
	for (let i = 0; i < 600; i++) messages[`d-${i}`] = deadLetter(`d-${i}`, i);
	const st = makeState(messages);
	const res = pruneState(st); // no opts -> default 500
	ok("default removed oldest 100 terminal", res.removed === 100);
	ok("default kept newest 500", res.kept === 500);
	const keptMin = Math.min(...Object.keys(st.messages).map((id) => Number(id.split("-")[1])));
	ok("default kept the newest 500 (min idx=100)", keptMin === 100);
}

// --- 7. Idempotency: a second run removes nothing -------------------------
{
	const st = buildMainState();
	pruneState(st, { keepMessages: 100 });
	const res2 = pruneState(st, { keepMessages: 100 });
	ok("idempotent second run removed=0", res2.removed === 0);
}

// --- 8. delivered cap (intersection-safe) ---------------------------------
{
	const messages = {};
	for (let i = 0; i < 500; i++) messages[`m${i}`] = deadLetter(`m${i}`, i);     // old terminal
	for (let i = 500; i < 600; i++) messages[`m${i}`] = queued(`m${i}`, i);       // newer actionable
	const delivered = { worker: Array.from({ length: 600 }, (_, i) => `m${i}`) };
	const st = makeState(messages, delivered);
	pruneState(st, { keepMessages: 50 });
	// surviving messages: m500..m599 (100 queued: 50 actionable from the tail + 50 from the window)
	ok("delivered survivors count=100", Object.keys(st.messages).length === 100);
	const arr = st.delivered.worker;
	ok("delivered capped to 50", arr.length === 50);
	ok("delivered keeps most-recent 50 (m550..m599)", arr[0] === "m550" && arr[49] === "m599");
	ok("delivered intersection-safe (all ids still exist)", arr.every((id) => st.messages[id]));
}

rmSync(scratch, { recursive: true, force: true });
console.log(`\n${fail === 0 ? "GC PASS" : "GC FAIL"} (${fail} failures)`);
process.exit(fail === 0 ? 0 : 1);
