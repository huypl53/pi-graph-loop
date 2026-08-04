// Logic-mirror validation for the orchestrator auto-pump fix (defer-when-busy + bounded re-trigger).
//
// This script mirrors the EXACT decision conditions of pumpOrchestratorMailbox() in index.ts. It does
// not import the compiled function (which is coupled to the live extension ctx/lock/state); instead it
// re-evaluates the same boolean predicates against an in-memory model so the behavior can be asserted
// deterministically. If you change the pump's decision logic, update the mirrors here too.
//
// Run: node extensions/swarm/pump-retrigger.validate.mjs

const PUMP_SCAN_WINDOW = 50;
const PUMP_SESSION_ID_CAP = 200;
const PUMP_RETRIGGER_DELAY_MS = 60 * 1000;
const PUMP_RETRIGGER_MAX = 3;

let failures = 0;
function assert(cond, msg) { if (!cond) { failures++; console.error("  ✗ FAIL:", msg); } else { console.log("  ✓", msg); } }

// In-memory model of one orchestrator pump session + mailbox + message records.
function freshWorld() {
	return {
		now: 1_700_000_000_000,
		mailbox: [], // [{id, requiresAck, ackedAt?}]
		records: {}, // id -> {requiresAck, ackedAt?}
		sess: { ids: [], triggeredAt: {}, retriggerCount: {}, lastAt: "" },
	};
}

// Mirror of the pump's lock-block decision. Returns { toSurface, retriggered, deferred } and mutates world.
function pumpDecision(world, idle) {
	const { now, mailbox, records, sess } = world;
	const surfaced = new Set(sess.ids);
	const triggeredAt = { ...sess.triggeredAt };
	const retriggerCount = { ...sess.retriggerCount };
	sess.lastAt = String(now);

	const windowMsgs = mailbox.slice(-PUMP_SCAN_WINDOW).filter((m) => !(records[m.id]?.ackedAt));

	// BUSY: defer entirely (the core fix).
	if (!idle) {
		return { toSurface: [], retriggered: 0, deferred: 1 };
	}

	const neverDisplayed = windowMsgs.filter((m) => !surfaced.has(m.id));
	const overdueRetrigger = windowMsgs.filter((m) => {
		if (!surfaced.has(m.id)) return false;
		const rec = records[m.id];
		if (!rec?.requiresAck || rec.ackedAt) return false;
		const last = triggeredAt[m.id];
		if (!last) return false;
		if (now - last < PUMP_RETRIGGER_DELAY_MS) return false;
		return (retriggerCount[m.id] ?? 0) < PUMP_RETRIGGER_MAX;
	});
	const toSurface = [...neverDisplayed, ...overdueRetrigger].slice(0, 10);
	if (!toSurface.length) return { toSurface: [], retriggered: 0, deferred: 0 };

	const retriggerSet = new Set(overdueRetrigger.map((m) => m.id));
	for (const m of toSurface) {
		surfaced.add(m.id);
		triggeredAt[m.id] = now;
		if (retriggerSet.has(m.id)) retriggerCount[m.id] = (retriggerCount[m.id] ?? 0) + 1;
	}
	// persist back
	sess.ids = [...surfaced].slice(-PUMP_SESSION_ID_CAP);
	sess.triggeredAt = Object.fromEntries(Object.entries(triggeredAt).slice(-PUMP_SESSION_ID_CAP));
	sess.retriggerCount = Object.fromEntries(Object.entries(retriggerCount).slice(-PUMP_SESSION_ID_CAP));
	return { toSurface, retriggered: toSurface.filter((m) => retriggerSet.has(m.id)).length, deferred: 0 };
}

console.log("\n[1] Core fix: busy pump must NOT mark surfaced (old code permanently skipped the nudge)");
{
	const w = freshWorld();
	const nudge = { id: "nudge-1", requiresAck: true };
	w.mailbox.push(nudge);
	w.records["nudge-1"] = { requiresAck: true };
	// Pump while BUSY.
	const r1 = pumpDecision(w, false);
	assert(r1.deferred === 1 && r1.toSurface.length === 0, "busy pump defers, surfaces nothing");
	assert(!w.sess.ids.includes("nudge-1"), "busy pump does NOT mark nudge surfaced (this was the bug)");
	assert(Object.keys(w.sess.triggeredAt).length === 0, "busy pump records no triggeredAt");
	// OLD behavior would have surfaced+marked here, then every later idle pump skips it forever.
}

console.log("\n[2] After deferring, the next IDLE pump surfaces + triggers the nudge");
{
	const w = freshWorld();
	const nudge = { id: "nudge-1", requiresAck: true };
	w.mailbox.push(nudge);
	w.records["nudge-1"] = { requiresAck: true };
	pumpDecision(w, false); // busy, defer
	const r2 = pumpDecision(w, true); // idle
	assert(r2.toSurface.length === 1 && r2.toSurface[0].id === "nudge-1", "idle pump surfaces the deferred nudge");
	assert(w.sess.ids.includes("nudge-1"), "idle pump marks nudge surfaced");
	assert(w.sess.triggeredAt["nudge-1"] != null, "idle pump stamps triggeredAt");
	assert((w.sess.retriggerCount["nudge-1"] ?? 0) === 0, "first trigger is not counted as a re-trigger");
}

console.log("\n[3] Bounded re-trigger: unacked requiresAck nudge re-surfaces after delay, up to MAX");
{
	const w = freshWorld();
	const nudge = { id: "nudge-1", requiresAck: true };
	w.mailbox.push(nudge);
	w.records["nudge-1"] = { requiresAck: true };
	pumpDecision(w, true); // initial trigger
	for (let i = 1; i <= PUMP_RETRIGGER_MAX; i++) {
		w.now += PUMP_RETRIGGER_DELAY_MS + 1; // overdue
		const r = pumpDecision(w, true);
		assert(r.toSurface.length === 1, `re-trigger #${i}: nudge re-surfaced after delay`);
		assert(r.retriggered === 1, `re-trigger #${i}: counted as retriggered`);
		assert(w.sess.retriggerCount["nudge-1"] === i, `retriggerCount == ${i}`);
	}
	// Beyond cap: must NOT re-trigger again.
	w.now += PUMP_RETRIGGER_DELAY_MS + 1;
	const rOver = pumpDecision(w, true);
	assert(rOver.toSurface.length === 0, "cap reached: nudge no longer re-triggered (no spam)");
	assert(w.sess.retriggerCount["nudge-1"] === PUMP_RETRIGGER_MAX, "retriggerCount frozen at MAX");
}

console.log("\n[4] Informational (requiresAck:false) messages trigger exactly once, never re-triggered");
{
	const w = freshWorld();
	const info = { id: "info-1", requiresAck: false };
	w.mailbox.push(info);
	w.records["info-1"] = { requiresAck: false };
	const r1 = pumpDecision(w, true);
	assert(r1.toSurface.length === 1, "informational message triggers once");
	w.now += PUMP_RETRIGGER_DELAY_MS + 10;
	w.now += PUMP_RETRIGGER_DELAY_MS + 10;
	const r2 = pumpDecision(w, true);
	assert(r2.toSurface.length === 0, "informational message is NOT re-triggered (sufficient to prompt once)");
}

console.log("\n[5] Acked message is never surfaced again");
{
	const w = freshWorld();
	const m = { id: "m-1", requiresAck: true };
	w.mailbox.push(m);
	w.records["m-1"] = { requiresAck: true };
	pumpDecision(w, true);
	w.records["m-1"].ackedAt = String(w.now); // recipient processed it
	w.now += PUMP_RETRIGGER_DELAY_MS + 1;
	const r = pumpDecision(w, true);
	assert(r.toSurface.length === 0, "acked message skipped by pump");
}

console.log("\n[6] Fresh work is surfaced alongside an overdue re-trigger within one pump");
{
	const w = freshWorld();
	const old = { id: "old-1", requiresAck: true };
	w.mailbox.push(old);
	w.records["old-1"] = { requiresAck: true };
	pumpDecision(w, true); // old-1 triggered once at T0
	w.now += PUMP_RETRIGGER_DELAY_MS + 1; // old-1 now overdue (unacked)
	// A brand-new message arrives in the same window.
	const fresh = { id: "fresh-1", requiresAck: true };
	w.mailbox.push(fresh);
	w.records["fresh-1"] = { requiresAck: true };
	const r = pumpDecision(w, true);
	assert(r.toSurface.length === 2, "both the fresh message and the overdue re-trigger surface in one pump");
	assert(r.retriggered === 1, "only the overdue one counts as a re-trigger; the fresh one is a first-time display");
	assert(w.sess.retriggerCount["old-1"] === 1 && (w.sess.retriggerCount["fresh-1"] ?? 0) === 0, "retriggerCount: old-1=1, fresh-1=0");
}

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"}`);
process.exit(failures === 0 ? 0 : 1);
