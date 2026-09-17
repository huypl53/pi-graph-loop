# Inferred Message Lifecycle & ACK Removal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate `swarm_ack_message` and manual target-to-source acknowledgement by implementing harness-driven delivery receipts, Pi message steering, and inferred lifecycle (`seenAt`, `processingAt`, `respondedAt`/`terminalAt`), while enabling minimal tool gating by default (`PI_SWARM_MINIMAL_PROTOCOL=1`).

**Architecture:** Replace explicit agent-side protocol round-trips with Pi Extension lifecycle hooks and engine-derived states. Crossings follow the Pi runtime 4-layer boundary (L1 Durable Mailbox -> L2 Pi Queue Acceptance / Steering -> L3 TUI Surface -> L4 LLM Consumption) per `docs/swarm/pi-runtime-contract.md`. Delivery and progress evidence are recorded synchronously in durable state without consuming LLM turns.

**Tech Stack:** TypeScript, `@earendil-works/pi-coding-agent` ExtensionAPI, Node.js `node:test` / ES modules, mock-llm fixture testbed.

---

## File Structure & Responsibilities

| File | Responsibility |
|---|---|
| `extensions/swarm/src/constants.ts` | Set `PI_SWARM_MINIMAL_PROTOCOL = 1` default; configure timeouts and lifecycle states. |
| `extensions/swarm/src/tools/messages.ts` | Enhance `swarm_send_message` return shape with immediate delivery receipt; deprecate `swarm_ack_message`. |
| `extensions/swarm/src/mailbox.ts` | Expand `deriveLifecycleTransition` to infer `seenAt` from steering injection and `processingAt` from subsequent agent activity. |
| `extensions/swarm/src/hooks.ts` | Wire `tool_execution_start` and `turn_start` to record `processingAt` for active/unread messages; remove ACK guidance from prompt injection. |
| `extensions/swarm/src/tools/gating.ts` | Enforce minimal tool profile (worker 4 tools, root 12 tools) with `swarm_ack_message` hidden by default. |
| `extensions/swarm/tests/inferred-lifecycle-steering.test.mjs` | Unit and integration tests for steering delivery receipts, `seenAt`, and `processingAt` derivation. |
| `extensions/mock-llm/fixtures/inferred-lifecycle-worker.jsonl` | Mock-LLM fixture verifying worker task completion without any `swarm_ack_message` calls. |

---

## Task Breakdown

### Task 1: Immediate Delivery Receipt in `swarm_send_message`

**Files:**
- Modify: `extensions/swarm/src/tools/messages.ts`
- Modify: `extensions/swarm/src/types.ts`
- Test: `extensions/swarm/tests/delivery-receipt.test.mjs`

- [ ] **Step 1: Write failing test for immediate delivery receipt**
  Create `extensions/swarm/tests/delivery-receipt.test.mjs` asserting that calling `swarm_send_message` returns a structured receipt:
  `{ status: "delivered_to_pane" | "queued_in_mailbox", messageId, target, mailboxPath }` rather than generic text.
- [ ] **Step 2: Run test to verify it fails**
  Run: `node extensions/swarm/tests/delivery-receipt.test.mjs`
  Expected: FAIL (missing fields in return object).
- [ ] **Step 3: Update `swarm_send_message` in `messages.ts`**
  Modify tool execute return structure to return synchronous delivery receipt based on whether message was accepted into mailbox (L1) and steered into Pi session (L2).
- [ ] **Step 4: Run test to verify it passes**
  Run: `node extensions/swarm/tests/delivery-receipt.test.mjs`
  Expected: PASS.
- [ ] **Step 5: Commit changes**
  Commit: `feat(swarm): return synchronous delivery receipt from swarm_send_message`

---

### Task 2: Pi Message Steering & `seenAt` Hook Derivation

**Files:**
- Modify: `extensions/swarm/src/surface.ts`
- Modify: `extensions/swarm/src/mailbox.ts`
- Modify: `extensions/swarm/src/hooks.ts`
- Test: `extensions/swarm/tests/inferred-seen-steering.test.mjs`

- [ ] **Step 1: Write failing test for steering `seenAt` derivation**
  Create `extensions/swarm/tests/inferred-seen-steering.test.mjs` asserting that when a message is delivered via `pi.sendMessage` (`deliverAs: "steer"`), the mailbox record transitions `seenAt` without any explicit ACK call.
- [ ] **Step 2: Run test to verify it fails**
  Run: `node extensions/swarm/tests/inferred-seen-steering.test.mjs`
  Expected: FAIL (message lacks `seenAt` until manual ack).
- [ ] **Step 3: Implement steering injection & `seenAt` stamp**
  In `surface.ts` / `mailbox.ts`, record `seenAt` timestamp when the message enters the target agent's session context via `pi.sendMessage` steering or mailbox read.
- [ ] **Step 4: Run test to verify it passes**
  Run: `node extensions/swarm/tests/inferred-seen-steering.test.mjs`
  Expected: PASS.
- [ ] **Step 5: Commit changes**
  Commit: `feat(swarm): derive seenAt on Pi message steering injection`

---

### Task 3: Inferred `processingAt` on Subsequent Tool Execution

**Files:**
- Modify: `extensions/swarm/src/hooks.ts`
- Modify: `extensions/swarm/src/mailbox.ts`
- Test: `extensions/swarm/tests/inferred-processing.test.mjs`

- [ ] **Step 1: Write failing test for `processingAt` on tool execution**
  Create `extensions/swarm/tests/inferred-processing.test.mjs` asserting that when a target agent receives a message and then fires `tool_execution_start` (any tool, e.g., `bash`, `read`, `swarm_update_task`), unacknowledged messages assigned to this agent/task transition to `processingAt = now()`.
- [ ] **Step 2: Run test to verify it fails**
  Run: `node extensions/swarm/tests/inferred-processing.test.mjs`
  Expected: FAIL (`processingAt` remains undefined).
- [ ] **Step 3: Implement `processingAt` derivation in `hooks.ts`**
  Hook into `tool_execution_start` for worker agents: check for active incoming messages addressed to `currentAgentId()`, and stamp `processingAt = now()` inside `withLock`.
- [ ] **Step 4: Run test to verify it passes**
  Run: `node extensions/swarm/tests/inferred-processing.test.mjs`
  Expected: PASS.
- [ ] **Step 5: Commit changes**
  Commit: `feat(swarm): automatically derive processingAt on target tool execution`

---

### Task 4: Watchdog by Exception ("No News is Good News")

**Files:**
- Modify: `extensions/swarm/src/reconcile.ts`
- Modify: `extensions/swarm/src/types.ts`
- Test: `extensions/swarm/tests/message-watchdog.test.mjs`

- [ ] **Step 1: Write failing test for silent vs deadline escalation**
  Create `extensions/swarm/tests/message-watchdog.test.mjs`:
  - When target agent executes tools normally within deadline: NO notification sent to source.
  - When target agent does not reach `seenAt` or `processingAt` before `responseDeadlineMs`: watchdog emits escalation alert to sender/root.
- [ ] **Step 2: Run test to verify it fails**
  Run: `node extensions/swarm/tests/message-watchdog.test.mjs`
  Expected: FAIL.
- [ ] **Step 3: Implement deadline check in `reconcile.ts`**
  Add message deadline sweep in `reconcile.ts`. Replace `ack_missing` errors with `response_deadline_exceeded` watchdog alerts when `expectResponse: true` and time has expired without `seenAt` / `processingAt`.
- [ ] **Step 4: Run test to verify it passes**
  Run: `node extensions/swarm/tests/message-watchdog.test.mjs`
  Expected: PASS.
- [ ] **Step 5: Commit changes**
  Commit: `feat(swarm): notify by exception on message deadline expiry`

---

### Task 5: Enable Minimal Protocol by Default & Hide `swarm_ack_message`

**Files:**
- Modify: `extensions/swarm/src/constants.ts`
- Modify: `extensions/swarm/src/tools/gating.ts`
- Modify: `extensions/swarm/src/tools/messages.ts`
- Test: `extensions/swarm/tests/tool-gating.validate.mjs`

- [ ] **Step 1: Update `constants.ts` default**
  Flip `PI_SWARM_MINIMAL_PROTOCOL` default from `0` to `1` (opt-out with `0`).
- [ ] **Step 2: Remove `swarm_ack_message` from worker and root tool sets**
  Ensure `swarm_ack_message` is not present in `WORKER_TOOL_ALLOWLIST` and `ROOT_TOOL_ALLOWLIST`. Keep it registered solely as an inert backward-compatible shim in `PI_SWARM_ADMIN_MODE=1`.
- [ ] **Step 3: Remove ACK instructions from System Prompts**
  Remove `[PI-SWARM ACK REQUIRED]` prompt guidelines and instructions from session prompt templates.
- [ ] **Step 4: Run tool-gating tests**
  Run: `node extensions/swarm/tests/tool-gating.validate.mjs`
  Expected: PASS (worker sees only 4-5 tools, `swarm_ack_message` absent).
- [ ] **Step 5: Commit changes**
  Commit: `feat(swarm): default PI_SWARM_MINIMAL_PROTOCOL=1 and retire swarm_ack_message`

---

### Task 6: Mock-LLM Fixture & Interactive Tmux Validation

**Files:**
- Create: `extensions/mock-llm/fixtures/inferred-lifecycle-worker.jsonl`
- Test: `extensions/mock-llm/` runner

- [ ] **Step 1: Author Mock-LLM scenario fixture**
  Create `extensions/mock-llm/fixtures/inferred-lifecycle-worker.jsonl` where a worker receives an assignment, reads task status, calls `bash`, updates task to `done`, and sends a reply message — with ZERO calls to `swarm_ack_message`.
- [ ] **Step 2: Run Mock-LLM validation lane**
  Run: `pi --provider mock-llm --model inferred-lifecycle-worker -e ./extensions/mock-llm -e ./extensions/swarm`
  Verify that the entire task lifecycle completes with `seenAt`, `processingAt`, `respondedAt` populated on disk and zero errors in `errors.jsonl`.
- [ ] **Step 3: Dedicated Tmux session UAT**
  Launch a fresh Pi tmux session to verify interactive UX:
  - Check active tools: confirm `swarm_ack_message` is not in `/tools` list.
  - Send message between two agents: verify instant receipt return and zero ACK churn.
- [ ] **Step 4: Capture evidence & commit**
  Commit: `test(swarm): add mock-llm fixture and UAT validation for inferred lifecycle`
