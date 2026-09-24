# Root Inbound Message Coalescing & Batch Surfacing Implementation Plan

> **Goal:** Eliminate sequential single-message LLM turn thrashing at the Swarm Root Agent by coalescing pending worker messages into a single batched delivery with a single `pi.sendMessage` turn trigger, complemented by a short arrival debounce window and noise suppression.

---

## 1. Problem Statement & Evidence from Production Pane %141

### 1.1 Observed Symptoms (tmux pane %141)
In live session pane `%141`, root received 8 consecutive messages from workers (`fix-rag-branch`, `planner-sandbox-ui`) between `00:12:46` and `00:14:41`:
- Each worker message triggered a separate, isolated root LLM turn.
- Root performed no substantive work in those turns, simply replying *"Đã nhận snapshot..."*, *"Acknowledged..."*, *"Đã nhận xác nhận cuối..."*, *"Đã rõ..."*.
- Context exploded to `↑467k ↓48k R7.7M 63.5%/200k` on `gpt-6-luna`, causing massive token burn, rate limit pressure, and continuous root busy locks.

### 1.2 Root Cause Analysis
1. **Loop delivery with `deliverAs: "followUp"` in [`surface.ts:1250-1268`](file:///home/vtit/code/utils/pi-graph-loop/extensions/swarm/src/surface.ts#L1250-L1268)**:
   When `pumpRootMailbox` finds $N$ pending messages in the mailbox, it loops over them:
   ```ts
   for (let i = 0; i < pending.length; i++) {
     const msg = pending[i];
     const opts = i === 0 ? { triggerTurn: true } : { deliverAs: "followUp" };
     pi.sendMessage({ customType: "swarm-message", content: formatSwarmMessageContent(msg), ... }, opts);
   }
   ```
   Per [Pi Runtime Contract §3](file:///home/vtit/code/utils/pi-graph-loop/docs/swarm/pi-runtime-contract.md#L58-L68), messages queued with `deliverAs: "followUp"` are converted by Pi runtime into **sequential follow-up turns** executed one after another once the preceding turn ends.
2. **Turn-settle chain reaction**:
   When root is busy with message 1, incoming messages 2 and 3 are deferred. When message 1 completes, `agent_settled` hook immediately triggers `pumpRootMailbox`, which delivers message 2 (and message 3 as follow-up). Root remains permanently busy processing 1-by-1.
3. **No arrival debounce**:
   Workers finishing sub-tasks 3–10 seconds apart cannot coalesce because root immediately consumes the first message upon going idle.

---

## 2. Pi Runtime Contract & Boundary Analysis

Per [`docs/swarm/pi-runtime-contract.md`](file:///home/vtit/code/utils/pi-graph-loop/docs/swarm/pi-runtime-contract.md), changes crossing Pi runtime boundaries must classify against the 4 layers:

| Layer | Contract Boundary | Behavior in this Plan |
|---|---|---|
| **L1: Durable Mailbox** | Append-only JSONL files on disk | Unchanged. Workers still append messages individually to `root.jsonl`. |
| **L2: Pi Queue Acceptance** | `pi.sendMessage` call count & options | **CHANGED (R10-1 boundary):** For $N$ pending messages ($N \ge 1$), call `pi.sendMessage` **exactly ONCE** with `{ triggerTurn: true }`. Do NOT queue follow-ups for same-batch items. |
| **L3: Visible Surface (TUI)** | Rendered markdown display in Pi terminal | Formats all batched messages into a structured, unified batch card with clear sender dividers and priority tags. |
| **L4: LLM Consumption** | Model turn context | The root LLM receives all worker updates in a single turn context, producing one consolidated synthesis/acknowledgement. |

---

## 3. Architecture & Design

### 3.1 Batch Formatting (`delivery.ts`)
Add `formatSwarmBatchMessageContent(msgs: SwarmMessage[]): string`:
- Formats $N$ messages into a clean composite view:
  ```markdown
  [2026-09-24 00:15:00] Inter-agent swarm batch delivery for root (3 messages):

  --- [1/3] From: fix-rag-branch | Priority: normal | Subject: Ack Camunda deletion ---
  Acknowledging msg-1790183340471: Camunda migration 0019_camunda_jobs.py is deleted...

  --- [2/3] From: planner-sandbox-ui | Priority: normal | Subject: Result: prep only ---
  Result for assignment msg-1790183098068-f032b5e9: PREP ONLY...

  --- [3/3] From: fix-rag-branch | Priority: normal | Subject: STOP acknowledged ---
  Acknowledged STOP (re-sending snapshot)...
  ```
- If $N = 1$, fall back to standard `formatSwarmMessageContent(msg)`.

### 3.2 Single Boundary Call & Atomic State Accounting (`surface.ts`)
In `pumpRootMailbox`:
- When `pending.length > 0`:
  1. Construct a single batched message:
     ```ts
     const isBatch = pending.length > 1;
     const content = isBatch
       ? formatSwarmBatchMessageContent(pending)
       : formatSwarmMessageContent(pending[0]);
     
     pi.sendMessage(
       {
         customType: isBatch ? "swarm-batch-message" : "swarm-message",
         content,
         display: true,
         details: { batch: isBatch, messageIds: pending.map(m => m.id), count: pending.length, messages: pending },
       },
       result.escalatedStuck
         ? { triggerTurn: true, deliverAs: "steer" }
         : { triggerTurn: true },
     );
     ```
  2. In the durable receipts block:
     - Mark **ALL** message IDs in `pending` as surfaced in `st.delivered.root` (for `requiresAck: false`) and `st.consumerReceipts.root.entries[id]` (for `requiresAck: true`).
     - Bump `st.consumerReceipts.root.revision` once for the batch.
     - Trace `notification.batch.surfaced` with `{ count: pending.length, ids: pending.map(m => m.id) }`.

### 3.3 Root Inbound Debounce Window (`hooks.ts`)
- Add `PI_SWARM_ROOT_DEBOUNCE_MS` (default: 2000ms, test override: 50ms).
- When root transitions to idle (`agent_settled`), if the mailbox contains un-surfaced messages:
  - Check if any pending message is `priority === "high"`.
  - If high-priority exists: pump immediately.
  - If all messages are normal/low priority: schedule pump after debounce timeout, resetting if new messages arrive during the window.

### 3.4 Informational Chatter Suppression (Protocol-level noise reduction)
- For messages with `requiresAck === false` and `requiresResponse === false` that match acknowledgement signatures (e.g. subject starting with `Ack:` or body acknowledging stop/pause):
  - Mark them as consumed in `st.delivered.root` without triggering an immediate LLM turn if no action is required, or bundle them under an informational fold in the batch.

---

## 4. Implementation Steps & Verification

### Phase 1: Failing R10-1 Boundary Test (Reproduce First)
- [ ] **Step 1.1**: Create reproduction test [`extensions/swarm/tests/r30-root-message-batching.test.mjs`](file:///home/vtit/code/utils/pi-graph-loop/extensions/swarm/tests/r30-root-message-batching.test.mjs).
  - Seed root mailbox with 3 worker messages.
  - Mock `pi.sendMessage` and count invocations at the boundary.
  - **Expected Red**: `sendMessageCount === 3` (currently 1 `triggerTurn` + 2 `followUp`).
  - Target Green: `sendMessageCount === 1`.

### Phase 2: Implementation in Swarm Core
- [ ] **Step 2.1**: Implement `formatSwarmBatchMessageContent` in [`extensions/swarm/src/delivery.ts`](file:///home/vtit/code/utils/pi-graph-loop/extensions/swarm/src/delivery.ts).
- [ ] **Step 2.2**: Update `pumpRootMailbox` in [`extensions/swarm/src/surface.ts`](file:///home/vtit/code/utils/pi-graph-loop/extensions/swarm/src/surface.ts):
  - Replace `for (let i = 0; i < pending.length; i++)` with single batched delivery.
  - Ensure all $N$ message IDs are properly acknowledged in `st.consumerReceipts` and `st.delivered`.
  - Add trace event `notification.batch.surfaced`.
- [ ] **Step 2.3**: Implement root idle debounce in [`extensions/swarm/src/hooks.ts`](file:///home/vtit/code/utils/pi-graph-loop/extensions/swarm/src/hooks.ts) with high-priority bypass.
- [ ] **Step 2.4**: Run `node extensions/swarm/tests/r30-root-message-batching.test.mjs` and verify it passes.

### Phase 3: Contract & Regression Safety Checks
- [ ] **Step 3.1**: Run full test suite:
  - `node extensions/swarm/tests/r15-normal-root-result.test.mjs`
  - `node extensions/swarm/tests/r13-root-unknown-target.test.mjs`
  - `node extensions/swarm/tests/root-wake.test.mjs`
  - `node extensions/swarm/tests/r25-unacked-notify.test.mjs`
- [ ] **Step 3.2**: Check `grep -rnE "catch\s*\{\s*\}" extensions/swarm/src` (Mandatory error-swallowing audit).
- [ ] **Step 3.3**: Update [`docs/swarm/pi-runtime-contract.md §3`](file:///home/vtit/code/utils/pi-graph-loop/docs/swarm/pi-runtime-contract.md) documenting root batching semantics.

### Phase 4: Mock-LLM Fixture & Interactive Tmux Validation
- [ ] **Step 4.1**: Author deterministic scenario [`extensions/mock-llm/fixtures/root-message-batch.jsonl`](file:///home/vtit/code/utils/pi-graph-loop/extensions/mock-llm/fixtures/root-message-batch.jsonl).
- [ ] **Step 4.2**: Execute real mock-LLM lane in an isolated tmux pane:
  - `pi --provider mock-llm --model root-message-batch -e ./extensions/mock-llm -e ./extensions/swarm`
  - Verify transcript captures exactly 1 turn processing the 3 messages together.
- [ ] **Step 4.3**: Provide pane capture before/after evidence in final report.
