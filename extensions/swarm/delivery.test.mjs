// Regression test for the swarm "ack then re-deliver" loop.
//
// Bug: `swarm_ack_message(status="failed")` sets the message record `status = "failed"`. That is the
// SAME status reconcile uses for retryable DELIVERY failures, so reconcile re-injected messages the
// recipient had already received + acked-failed -> the agent saw the same message again, acked-failed
// again, ... looping until MAX_ATTEMPTS/TTL -> dead_letter.
//
// Fix: `isDeliveryFailureRetryable()` discriminates via `lastAck`. A "queued"/"failed" message the
// recipient has ALREADY acknowledged (any ack, incl. failed) is terminal and must never be re-injected.
//
// Run: node extensions/swarm/delivery.test.mjs
import { isDeliveryFailureRetryable } from "./index.ts";

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.error("  FAIL:", name); } };

const delivered = { status: "injected", lastAck: undefined };
const ackedDone = { status: "acked", lastAck: { status: "done" } };
const deliveryFail = { status: "failed", lastAck: undefined };      // never reached recipient -> retry
const ackedFailed = { status: "failed", lastAck: { status: "failed" } }; // recipient processed + failed -> LOOP source
const queued = { status: "queued", lastAck: undefined };
const ackedSeen = { status: "injected", lastAck: { status: "seen" } }; // progress ack, still in-flight

// The fix: acked-failed is NOT retryable (this was true before only by accident of dry-run).
ok("delivery failure (no ack) is retryable", isDeliveryFailureRetryable(deliveryFail) === true);
ok("queued (no ack) is retryable", isDeliveryFailureRetryable(queued) === true);

// The bug: these must be terminal / not retryable.
ok("acked-failed is NOT retryable (loop source)", isDeliveryFailureRetryable(ackedFailed) === false);
ok("acked-done is NOT retryable", isDeliveryFailureRetryable(ackedDone) === false);
ok("delivered (injected) is NOT retryable", isDeliveryFailureRetryable(delivered) === false);
ok("progress-ack (seen) is NOT retryable", isDeliveryFailureRetryable(ackedSeen) === false);

// Simulate the reconcile re-inject decision for the exact record from the live trace
// (msg-...b9111067 -> planner-new: injected -> ack processing -> ack failed).
const liveRecord = {
	status: "failed",
	lastAck: { by: "planner-new", status: "failed", note: "NODE_ASSIGNEE_MISMATCH ...", at: "2026-08-03T09:10:21.633Z" },
};
ok("live acked-failed record would NOT be re-injected by reconcile", isDeliveryFailureRetryable(liveRecord) === false);

console.log(`\n${fail === 0 ? "PASS" : "FAIL"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
