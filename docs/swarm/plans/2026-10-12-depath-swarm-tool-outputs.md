# Plan: De-path swarm tool outputs — steer agents to bounded tools, not raw files

> **Rev 2 (2026-10-12, root review):** 3 corrections folded in:
> 1. Finding J — keep warning texts at `lifecycle.ts:69,87` byte-identical (operator-facing troubleshooting anchors); only change tool description + 2 param descriptions (lines 26,45,51). RED test Finding J updated accordingly.
> 2. Site 2 new hint — use exactly `…[+N chars truncated — re-read with fullBody:true and a smaller limit to page through the rest]` (no "or reference the artifact path" — that re-teaches path-following).
> 3. Findings F/G/H — use canonical phrase `the task-graph state file` (not `the task graph`) where the old text said `task.json` semantically refers to the persisted state. Finding E keeps `every task graph` as written.

> Task: `depath-swarm-tool-outputs` — node `plan` (planner: depath-planner)
> Incident: p9-dossier-runtime-debug2 (workflow-agents, 2026-10-12) — worker received send receipt exposing root mailbox path, then hallucinated a `sleep 165; tail -1 root.jsonl` poll loop on that file for hours.
> Design rule: NEVER leave a raw `.pi/swarm` path in model-visible text. Steer to the bounded tool that already exists (`swarm_check_mailbox fullBody:true`, `swarm_audit mode:timeline messageId:`, `swarm_task_status`) or state the behavioral contract ("replies arrive in YOUR mailbox via pump; use `swarm_check_mailbox`; do not read the recipient's mailbox file"). Programmatic paths MAY stay in `details` (harness escape hatch) — decided per site and justified below.

## 0. Scope summary

- **6 identified sites** (per task brief) — all in `extensions/swarm/src/tools/`.
- **Additional findings** from the grep sweep of `src/tools/` + `src/commands/` — listed in §2.
- **Out of scope** (not model-visible, or already correct):
  - `extensions/swarm/src/tools/gating.ts:56` — internal `readFileSync` of `swarm-state.json` for tier gating; never reaches model context.
  - `extensions/swarm/src/nudges/goal-epoch.ts:794` — `Mailbox: ${mbPath}` is inside a message BODY sent to root (model-visible body content, not a tool output). Different category; flagged in §2 as a follow-up but NOT in this fix's scope (changing message bodies is a separate contract change).
  - `extensions/swarm/src/tools/agents/status.ts:9,311,317,318` — code comments only, never reach model context.

## 1. Per-site old → new text table

### Site 1 — `extensions/swarm/src/tools/messages.ts:228` — `swarm_send_message` receipt text

**Severity:** worker-facing (the exact incident vector — worker reads its own send receipt).

**Current text (line 228):**
```ts
`Sent ${msg.id} to ${msg.to}. Delivery status: ${deliveryStatus}. Mailbox: ${mailboxPath}.${mailboxOnlyNote}`
```

**New text:**
```ts
`Sent ${msg.id} to ${msg.to}. Delivery status: ${deliveryStatus}.${mailboxOnlyNote}`
```

**Justification:** The `Mailbox: ${mailboxPath}` segment is the literal incident vector — the worker read this string, extracted the path, and started polling it. The `mailboxPath` variable is still computed (line 204) and still returned in `details.receipt.mailboxPath` (line 209) for programmatic/harness use. The model-visible text drops the path entirely; the bounded tool for the worker to check delivery is `swarm_check_mailbox` (already in its tool set), and the bounded tool for the root to surface the message is the pump (already wired). No information is lost — the `deliveryStatus` field already tells the worker whether the message was `delivered_to_pane` or `queued_in_mailbox`.

**Details retention:** `receipt.mailboxPath` STAYS in `details` (programmatic harness escape hatch, same pattern as `fullMailboxRow` keeping raw bodies in `details.messages`).

### Site 2 — `extensions/swarm/src/tools/messages.ts:118` — `fullMailboxRow` truncation hint

**Severity:** worker-facing (any worker calling `swarm_check_mailbox fullBody:true` on a >20KB body sees this hint).

**Current text (line 118):**
```ts
rest.body = `${rawBody.slice(0, FULL_BODY_MAX_CHARS)}\n…[+${truncated} chars truncated — full body durable in mailbox JSONL: ${mailboxFile}]`;
```

**New text:**
```ts
rest.body = `${rawBody.slice(0, FULL_BODY_MAX_CHARS)}\n…[+${truncated} chars truncated — re-read with fullBody:true and a smaller limit to page through the rest]`;
```

**Justification:** The old hint named the durable mailbox JSONL path, which is exactly the kind of breadcrumb that invites a worker to start reading the file directly. The new hint steers the worker back to the bounded tool (`fullBody:true` with a smaller `limit`) or to the artifact path the sender should have cited (per the F4 clamp contract: "Trim the body or reference an artifact path instead"). The `mailboxFile` parameter is still passed to `fullMailboxRow` (line 102) for any future programmatic use, but is no longer interpolated into model-visible text.

**Details retention:** `details.messages` already keeps the raw full body (programmatic escape hatch, unchanged).

### Site 3 — `extensions/swarm/src/tools/agents/status.ts:116` — `swarm_agent_status` description

**Severity:** worker-facing (description is part of the tool's system-prompt advertisement; workers see it on every session_start).

**Current text (line 116):**
```ts
"Report runtime/liveness status for swarm agents using pi lifecycle state, terminal pane liveness, and mailbox message counts. Default view is a compact attention/census summary and is the correct shape for routine supervision; a targeted agentId query returns one slim row with the same vocabulary. For forensic fields (pid, exact timestamps) read .pi/swarm/swarm-state.json directly."
```

**New text:**
```ts
"Report runtime/liveness status for swarm agents using pi lifecycle state, terminal pane liveness, and mailbox message counts. Default view is a compact attention/census summary and is the correct shape for routine supervision; a targeted agentId query returns one slim row with the same vocabulary. For forensic fields (pid, exact timestamps) use the bounded audit surface (swarm_audit mode:timeline messageId:<id> for message forensics; swarm_reconcile dryRun:true for task-graph drift)."
```

**Justification:** The old description told the model to "read .pi/swarm/swarm-state.json directly" — a direct invitation to bypass the bounded tool surface. The new description steers to the bounded tools that already exist: `swarm_audit mode:timeline messageId:<id>` for message forensics (the audit tool already reconstructs message timelines from the trace), and `swarm_reconcile dryRun:true` for task-graph drift (the reconcile tool already reports stored-vs-derived status drift). No information is lost — the forensic fields are still accessible via the bounded tools.

### Site 4 — `extensions/swarm/src/tools/agents/status.ts:140` — `swarm_agent_status` runtime guard error

**Severity:** worker-facing (this error is thrown when a worker calls the removed `view:"full"`/`verbose:true` params; the error text is the model's only guidance on what to do instead).

**Current text (line 140):**
```ts
"view:'full'/verbose were removed (2026-10-10): the 24-field envelope polluted agent context. Default call = attention/census summary; pass agentId for a slim per-agent row; read .pi/swarm/swarm-state.json for forensic fields (pid, exact timestamps)."
```

**New text:**
```ts
"view:'full'/verbose were removed (2026-10-10): the 24-field envelope polluted agent context. Default call = attention/census summary; pass agentId for a slim per-agent row; for forensic fields (pid, exact timestamps) use swarm_audit mode:timeline messageId:<id> or swarm_reconcile dryRun:true."
```

**Justification:** Same as Site 3 — the old text pointed at a raw file path; the new text points at bounded tools.

### Site 5 — `extensions/swarm/src/tools/audit.ts:260` — `readAuditEvents` source.file (events mode)

**Severity:** worker-facing (the `source` block is part of every `swarm_audit mode:events` result; workers see it on every audit call).

**Current text (line 259-263):**
```ts
const source = {
    file: p.events,
    bytesScanned: files.map((f) => (existsSync(f) ? statSync(f).size : 0)).reduce((a, b) => a + b, 0),
    generationsIncluded: generations,
};
```

**New text:**
```ts
const source = {
    bytesScanned: files.map((f) => (existsSync(f) ? statSync(f).size : 0)).reduce((a, b) => a + b, 0),
    generationsIncluded: generations,
    // file path is kept in details.source.file for programmatic/harness use; the model-visible
    // text drops it to prevent workers from reading the trace file directly (incident p9-dossier-runtime-debug2).
};
```

**Justification:** The `source.file` field exposed the raw `p.events` path (which resolves to `.pi/swarm/traces/events.jsonl`) in every audit result. Workers seeing this path may start reading the file directly instead of using the bounded `swarm_audit` tool. The new shape drops `file` from the model-visible `source` block but keeps it available in `details.source.file` for programmatic/harness use (the audit tool's `textResult` already passes the full result as `details`).

**Details retention:** `details.source.file` STAYS (programmatic harness escape hatch).

### Site 6 — `extensions/swarm/src/tools/audit.ts:326` — `auditTimeline` source.file (timeline mode)

**Severity:** worker-facing (same as Site 5, but for `mode:timeline`).

**Current text (line 326):**
```ts
source: { file: p.events, bytesScanned: 0, generationsIncluded: opts.generations !== false },
```

**New text:**
```ts
source: { bytesScanned: 0, generationsIncluded: opts.generations !== false },
```

**Justification:** Same as Site 5. The `file` field is dropped from the model-visible `source` block. The full result (including `source.file`) is still passed as `details` by the `textResult` call at line 571.

**Details retention:** `details.source.file` STAYS (programmatic harness escape hatch).

### Site 7 — `extensions/swarm/src/tools/tasks/create.ts:104` — `swarm_create_task` result text

**Severity:** root-only (the tool is gated by `requireRootAuthority`; only root can call it). But still model-visible to root, and root is the agent that assigns work to workers — if root leaks the path in an assignment message body, workers inherit it.

**Current text (line 104):**
```ts
`Created task ${result.taskId} at ${relative(ctx.cwd, result.tp.root)}\nStart: ${result.task.start}\nReady: ${result.actionable.join(", ") || "(none)"}${result.autoClosed?.length ? `\nAuto-closed root terminal nodes: ${result.autoClosed.join(", ")}` : ""}\nHint: use task-role-staffing.`
```

**New text:**
```ts
`Created task ${result.taskId}\nStart: ${result.task.start}\nReady: ${result.actionable.join(", ") || "(none)"}${result.autoClosed?.length ? `\nAuto-closed root terminal nodes: ${result.autoClosed.join(", ")}` : ""}\nHint: use task-role-staffing. Inspect with swarm_task_status (detail:"graph" for the full node/edge map).`
```

**Justification:** The old text included `at ${relative(ctx.cwd, result.tp.root)}` which resolves to `.pi/swarm/tasks/<task-id>/`. Root seeing this path may include it in assignment message bodies, which workers then inherit. The new text drops the path and steers root to the bounded `swarm_task_status` tool for inspection.

**Details retention:** `details.taskMd` and `details.taskJson` (lines 108-109) STAY in `details` for programmatic/harness use (same pattern as `receipt.mailboxPath`).

### Site 8 — `extensions/swarm/src/tools/messages.ts:224` — root mailbox-only note

**Severity:** worker-facing (any worker sending to root sees this note in its own send receipt).

**Current text (line 224):**
```ts
" (root: mailbox-only — durable in mailbox, no time-bound surface guarantee; normal)"
```

**New text:**
```ts
" (root: mailbox-only — replies arrive in root's mailbox via the pump; root uses swarm_check_mailbox to read; do not read root's mailbox file directly)"
```

**Justification:** The old note said "durable in mailbox" which is truthful but invites the worker to start polling the mailbox file. The new note states the behavioral contract: replies arrive via the pump, root reads via `swarm_check_mailbox`, and the worker should NOT read root's mailbox file directly. This is the exact behavioral instruction the incident worker needed.

## 2. Additional findings from grep sweep

The task brief asked to grep the whole `src/tools/` + `src/commands/` for OTHER model-visible `.pi/swarm` path leaks. Findings:

### Finding A — `extensions/swarm/src/tools/agents/lifecycle.ts:90` — `swarm_spawn_agent` result text

**Severity:** root-only (the tool is gated by `requireRootAuthority`).

**Current text (line 90):**
```ts
`${warnHeader}Spawned ${result.agent.id} at ${result.agent.tmuxTarget}\nIdentity: ${relative(ctx.cwd, result.identity)}\nSnapshot: ${relative(ctx.cwd, result.snapshot)}`
```

**Issue:** `Identity: <path>` and `Snapshot: <path>` expose the agent identity file and snapshot file paths (which resolve under `.pi/swarm/agents/<id>/`). Root seeing these paths may include them in subsequent tool calls or message bodies.

**Proposed new text:**
```ts
`${warnHeader}Spawned ${result.agent.id} at ${result.agent.tmuxTarget}\nIdentity + snapshot persisted (use swarm_agent_status agentId:"${result.agent.id}" to inspect).`
```

**Details retention:** `result.identity` and `result.snapshot` are already in the `result` object passed as `details` (line 91).

**Scope decision:** INCLUDE in this fix. The task brief says "grep the whole src/tools + src/commands for any OTHER model-visible .pi/swarm path leaks and include findings" — this is a clear model-visible path leak in a tool output.

### Finding B — `extensions/swarm/src/tools/agents/status.ts:299` — `swarm_list_agents` description

**Severity:** worker-facing (description is part of the tool's system-prompt advertisement).

**Current text (line 299):**
```ts
"List pi swarm agents for this project as a compact phonebook: ids, role first lines, status, driver target, slot, and mailbox paths."
```

**Issue:** The description says "mailbox paths" — this hints to the model that mailbox paths are accessible, which invites direct file reads.

**Proposed new text:**
```ts
"List pi swarm agents for this project as a compact phonebook: ids, role first lines, status, driver target, and slot."
```

**Scope decision:** INCLUDE in this fix. The description is model-visible and the "mailbox paths" phrase is a path-leak hint.

### Finding C — `extensions/swarm/src/tools/messages.ts:153` — `swarm_send_message` description

**Severity:** worker-facing (description is part of the tool's system-prompt advertisement).

**Current text (line 153):**
```ts
"Send an inter-agent swarm message. The message is appended to the recipient mailbox JSONL and injected into the recipient tmux pane with PI-SWARM system headers when possible."
```

**Issue:** The description says "appended to the recipient mailbox JSONL" — this hints at the file format and location.

**Proposed new text:**
```ts
"Send an inter-agent swarm message. The message is durably queued for the recipient and injected into the recipient tmux pane with PI-SWARM system headers when possible."
```

**Scope decision:** INCLUDE in this fix. The description is model-visible and the "mailbox JSONL" phrase is a path-leak hint.

### Finding D — `extensions/swarm/src/tools/messages.ts:246` — `swarm_check_mailbox` description

**Severity:** worker-facing (description is part of the tool's system-prompt advertisement).

**Current text (line 246):**
```ts
"Read pending or recent messages from a swarm agent mailbox JSONL. Defaults to the current PI_SWARM_AGENT_ID. The default compact scan (id/from/subject/age/unread) is the correct poll shape; unread drains durably once messages are surfaced or marked delivered, so a repeated poll returning unread:0 needs no re-reading. Use bodyPreview to triage bodies; use fullBody only to read specific message(s) you have already selected from a scan (pass a small limit)."
```

**Issue:** The description says "from a swarm agent mailbox JSONL" — this hints at the file format and location.

**Proposed new text:**
```ts
"Read pending or recent messages from a swarm agent's mailbox. Defaults to the current PI_SWARM_AGENT_ID. The default compact scan (id/from/subject/age/unread) is the correct poll shape; unread drains durably once messages are surfaced or marked delivered, so a repeated poll returning unread:0 needs no re-reading. Use bodyPreview to triage bodies; use fullBody only to read specific message(s) you have already selected from a scan (pass a small limit)."
```

**Scope decision:** INCLUDE in this fix. The description is model-visible and the "mailbox JSONL" phrase is a path-leak hint.

### Finding E — `extensions/swarm/src/tools/messages.ts:416` — `swarm_reconcile` description

**Severity:** worker-facing (description is part of the tool's system-prompt advertisement).

**Current text (line 416):**
```ts
"Reconcile swarm mailbox state AND task graph state. Mailbox: inspects queued/failed/injected messages requiring ack, retries failed/queued injections when recipient tmux is running, marks expired or max-attempt messages dead_letter. Task sweep: re-reads every task.json, reports stored-vs-derived status drift and stale/nudge signals (dead assignee, dead-lettered assignment, in_progress too long, ack_missing), and stamps advisory node.staleAt. Use offset to skip reconciliation actions already returned by an earlier call. Mark-only by default; pass mark=true to also persist the recomputed task.status. Never auto-fails a node."
```

**Issue:** The description says "re-reads every task.json" — this hints at the file path.

**Proposed new text:**
```ts
"Reconcile swarm mailbox state AND task graph state. Mailbox: inspects queued/failed/injected messages requiring ack, retries failed/queued injections when recipient tmux is running, marks expired or max-attempt messages dead_letter. Task sweep: re-reads every task graph, reports stored-vs-derived status drift and stale/nudge signals (dead assignee, dead-lettered assignment, in_progress too long, ack_missing), and stamps advisory node.staleAt. Use offset to skip reconciliation actions already returned by an earlier call. Mark-only by default; pass mark=true to also persist the recomputed task.status. Never auto-fails a node."
```

**Scope decision:** INCLUDE in this fix. The description is model-visible and the "task.json" phrase is a path-leak hint.

### Finding F — `extensions/swarm/src/tools/tasks/inspect.ts:51` — `swarm_task_status` description

**Severity:** worker-facing (description is part of the tool's system-prompt advertisement).

**Current text (line 51):**
```ts
"Read task.json and summarize task/node/gate state. Optionally include artifact listing and runtime liveness/message warnings."
```

**Issue:** The description says "Read task.json" — this hints at the file path.

**Proposed new text:**
```ts
"Read the task-graph state file and summarize task/node/gate state. Optionally include artifact listing and runtime liveness/message warnings."
```

**Scope decision:** INCLUDE in this fix. The description is model-visible and the "task.json" phrase is a path-leak hint.

### Finding G — `extensions/swarm/src/tools/tasks/assign.ts:66` — `swarm_assign_task` description

**Severity:** root-only (the tool is gated by `requireRootAuthority`).

**Current text (line 66):**
```ts
"Assign a task graph node to an agent: reuse an idle role-matching agent by default, optionally spawn, update node assignment state + activeTaskIds, and send a structured assignment message carrying taskId/nodeId/replyTarget. task.json is the source of truth. Root-level tool."
```

**Issue:** The description says "task.json is the source of truth" — this hints at the file path.

**Proposed new text:**
```ts
"Assign a task graph node to an agent: reuse an idle role-matching agent by default, optionally spawn, update node assignment state + activeTaskIds, and send a structured assignment message carrying taskId/nodeId/replyTarget. The task-graph state file is the source of truth. Root-level tool."
```

**Scope decision:** INCLUDE in this fix. The description is model-visible and the "task.json" phrase is a path-leak hint.

### Finding H — `extensions/swarm/src/tools/tasks/update.ts:72` — `swarm_update_task` description

**Severity:** worker-facing (workers call this tool to update their assigned node).

**Current text (line 72):**
```ts
"Update an assigned task node's status/outcome/note/artifact/gate/sharedContext. Enforces ownership (current agent must be the node assignee, or root via force) and allowed lifecycle transitions; releases activeTaskIds + editLocks on terminal-ish node states. Validation precedes any write, so invalid calls leave task.json untouched."
```

**Issue:** The description says "invalid calls leave task.json untouched" — this hints at the file path.

**Proposed new text:**
```ts
"Update an assigned task node's status/outcome/note/artifact/gate/sharedContext. Enforces ownership (current agent must be the node assignee, or root via force) and allowed lifecycle transitions; releases activeTaskIds + editLocks on terminal-ish node states. Validation precedes any write, so invalid calls leave the task-graph state file untouched."
```

**Scope decision:** INCLUDE in this fix. The description is model-visible and the "task.json" phrase is a path-leak hint.

### Finding I — `extensions/swarm/src/tools/tasks/create.ts:36` — `swarm_create_task` description

**Severity:** root-only (the tool is gated by `requireRootAuthority`).

**Current text (line 36):**
```ts
"Create a task graph under .pi/swarm/tasks/<task-id>/ with task.md, task.json, events.jsonl, and artifacts/. Synthesizes the built-in feature-dev graph unless a custom nodes/edges graph is supplied."
```

**Issue:** The description explicitly names `.pi/swarm/tasks/<task-id>/` and the file names `task.md`, `task.json`, `events.jsonl`.

**Proposed new text:**
```ts
"Create a durable task graph with task markdown, task state, event stream, and artifact directory. Synthesizes the built-in feature-dev graph unless a custom nodes/edges graph is supplied."
```

**Scope decision:** INCLUDE in this fix. The description is model-visible and contains the most explicit path leak in the codebase.

### Finding J — `extensions/swarm/src/tools/agents/lifecycle.ts:26,45,51,69,87` — `swarm_spawn_agent` description + params + warning

**Severity:** root-only (the tool is gated by `requireRootAuthority`).

**Issue:** Multiple mentions of `.pi/swarm.yaml` in the description, promptGuidelines, parameter descriptions, and warning text. These are configuration file paths, not state file paths, but they still hint at the file system layout.

**Proposed new text (description, line 26):**
```ts
"Do NOT specify provider or model when spawning agents. Model and provider are configured by the user in the swarm config file. Only specify id, role, roleKind, and initialPrompt unless the user explicitly requested a specific model/provider."
```

**Proposed new text (param description, line 45):**
```ts
"Optional model override. Omit this parameter; swarm agents automatically inherit model from the swarm config."
```

**Proposed new text (param description, line 51):**
```ts
"Optional provider override. Omit this parameter; swarm agents automatically inherit provider from the swarm config."
```

**NOT changed (Rev 2 correction):** The warning texts at `lifecycle.ts:69` and `lifecycle.ts:87` are operator-facing troubleshooting anchors — a human greps for "Configure .pi/swarm.yaml" when the pool is missing. Keep both warning strings byte-identical.

**Scope decision:** INCLUDE in this fix (description + 2 param descriptions only). The exact filename `.pi/swarm.yaml` is replaced with the generic "swarm config" in the model-visible description/params — the model doesn't need to know the filename to understand the behavioral instruction. The warning texts stay byte-identical for operator grep-ability.

### Finding K — `extensions/swarm/src/commands/pool.ts` — `/swarm pool` command help text

**Severity:** root-only (the command is root-gated).

**Issue:** Multiple mentions of `.pi/swarm.yaml` and `.pi/swarm.yml` in the help text and validation messages. These are slash-command outputs, not tool outputs, but they are still model-visible when root runs `/swarm pool validate`.

**Scope decision:** DEFER. The task brief says "grep the whole src/tools + src/commands for any OTHER model-visible .pi/swarm path leaks" — this IS a model-visible path leak in a command output. However, the task's allowedFiles list does NOT include `extensions/swarm/src/commands/pool.ts`. The implement node's allowedFiles is inherited from the task's allowedFiles. Including this fix would require expanding the allowedFiles list, which is a scope change. Flagging as a follow-up for a separate task.

### Finding L — `extensions/swarm/src/nudges/goal-epoch.ts:794` — health-check message body

**Severity:** root-facing (the message is sent TO root).

**Issue:** The health-check message body includes `Mailbox: ${mbPath}` which exposes the worker's mailbox path to root. Root seeing this path may include it in subsequent tool calls or message bodies.

**Scope decision:** DEFER. This is a message BODY, not a tool output. Changing message bodies is a separate contract change (the body is part of the message envelope that other agents may have already learned to parse). Flagging as a follow-up for a separate task. The task brief specifically says "model-visible tool outputs" — message bodies are a different category.

## 3. RED reproduction approach

### RED test 1 — `extensions/swarm/tests/depath-tool-outputs.test.mjs` (new file)

A single test file that exercises all 6 identified sites + the additional findings, asserting that the CURRENT (pre-fix) outputs contain path leaks. The test is observed RED against HEAD, then GREEN after the fix.

**Test structure:**
1. Seed a scratch cwd with a minimal swarm state (1 agent, 1 mailbox message, 1 task).
2. Load the real extension via `import(join(here, "..", "index.ts"))`.
3. Call each tool and assert:
   - **Site 1 (send receipt):** `swarm_send_message` result text does NOT contain `.pi/swarm/mailboxes/`.
   - **Site 2 (fullBody hint):** `swarm_check_mailbox fullBody:true` on a >20KB body does NOT contain `mailbox JSONL:` in the body field.
   - **Site 3 (status description):** `swarm_agent_status` tool description does NOT contain `.pi/swarm/swarm-state.json`.
   - **Site 4 (status runtime guard):** calling with `view:"full"` throws an error that does NOT contain `.pi/swarm/swarm-state.json`.
   - **Site 5 (audit events source):** `swarm_audit mode:events` result `source` block does NOT contain a `file` field.
   - **Site 6 (audit timeline source):** `swarm_audit mode:timeline messageId:<id>` result `source` block does NOT contain a `file` field.
   - **Site 7 (create task text):** `swarm_create_task` result text does NOT contain `.pi/swarm/tasks/`.
   - **Site 8 (root mailbox-only note):** `swarm_send_message to:"root"` result text does NOT contain `durable in mailbox` (the old phrasing that invited polling).
   - **Finding A (spawn result):** `swarm_spawn_agent` result text does NOT contain `Identity:` or `Snapshot:` with a path.
   - **Finding B (list description):** `swarm_list_agents` tool description does NOT contain `mailbox paths`.
   - **Finding C (send description):** `swarm_send_message` tool description does NOT contain `mailbox JSONL`.
   - **Finding D (check_mailbox description):** `swarm_check_mailbox` tool description does NOT contain `mailbox JSONL`.
   - **Finding E (reconcile description):** `swarm_reconcile` tool description does NOT contain `task.json`.
   - **Finding F (task_status description):** `swarm_task_status` tool description does NOT contain `task.json`.
   - **Finding G (assign description):** `swarm_assign_task` tool description does NOT contain `task.json`.
   - **Finding H (update description):** `swarm_update_task` tool description does NOT contain `task.json`.
   - **Finding I (create description):** `swarm_create_task` tool description does NOT contain `.pi/swarm/tasks/`.
   - **Finding J (spawn description/params only — Rev 2):** `swarm_spawn_agent` tool description + 2 param descriptions do NOT contain `.pi/swarm.yaml`. The warning texts at `lifecycle.ts:69,87` are NOT changed (operator-facing troubleshooting anchors; byte-identical preservation).

**Negative controls (must still work after fix):**
   - `details.receipt.mailboxPath` STILL contains the path (programmatic harness escape).
   - `details.taskMd` and `details.taskJson` STILL contain the paths (programmatic harness escape).
   - `details.source.file` STILL contains the path (programmatic harness escape).
   - `details.messages` STILL contains raw full bodies (programmatic harness escape).
   - `swarm_check_mailbox fullBody:true` STILL returns complete bodies (up to FULL_BODY_MAX_CHARS).
   - `swarm_audit mode:timeline messageId:<id>` STILL returns the timeline.
   - `swarm_task_status detail:"graph"` STILL returns the full graph.

### RED test 2 — mock-llm fixture (optional, per AGENTS.md fallback)

Per AGENTS.md: "if mocking streaming behavior proves impractical for a specific surface, an OpenAI-completions-compatible mock (static canned completion responses) is the fallback — state which and why in the plan artifact."

**Decision:** DEFER the mock-llm fixture. The deterministic unit test (RED test 1) exercises all 6 sites + findings directly via the real tool handlers. A mock-llm fixture would add no additional signal beyond the unit test (the bug is in the tool output text, not in the LLM's response to it). The unit test IS the required reproduction per AGENTS.md: "the fixture replays the agent-side of the interaction deterministically" — the unit test replays the tool-side deterministically, which is the actual bug surface.

## 4. Files touched

| File | Sites | Change type |
|------|-------|-------------|
| `extensions/swarm/src/tools/messages.ts` | 1, 2, 8, C, D | Edit (text + description) |
| `extensions/swarm/src/tools/agents/status.ts` | 3, 4, B | Edit (description + error text) |
| `extensions/swarm/src/tools/audit.ts` | 5, 6 | Edit (source object shape) |
| `extensions/swarm/src/tools/tasks/create.ts` | 7, I | Edit (text + description) |
| `extensions/swarm/src/tools/agents/lifecycle.ts` | A, J | Edit (text + description + params + warning) |
| `extensions/swarm/src/tools/tasks/inspect.ts` | F | Edit (description) |
| `extensions/swarm/src/tools/tasks/assign.ts` | G | Edit (description) |
| `extensions/swarm/src/tools/tasks/update.ts` | H | Edit (description) |
| `extensions/swarm/tests/depath-tool-outputs.test.mjs` | NEW | New test file (RED → GREEN) |
| `docs/swarm/tools.md` | — | Edit (update tool descriptions to match new wording) |
| `extensions/swarm/README.md` | — | Edit (if tool descriptions are referenced) |
| `CHANGELOG.md` | — | Edit (add entry under [Unreleased]) |
| `docs/swarm/plans/2026-10-12-depath-swarm-tool-outputs.md` | — | New plan file (this artifact, published) |

## 5. Validation commands

```bash
# RED → GREEN: the new test file
node extensions/swarm/tests/depath-tool-outputs.test.mjs

# Grep sweep: no raw .pi/swarm paths in model-visible text
grep -rn "Mailbox: \${" extensions/swarm/src/tools/messages.ts  # → zero
grep -rn "read .pi/swarm.*directly" extensions/swarm/src  # → zero
grep -rn "\.pi/swarm" extensions/swarm/src/tools/  # → only in comments + internal file reads (gating.ts:56)
grep -rn "task.json" extensions/swarm/src/tools/  # → only in comments + internal file reads
grep -rn "events.jsonl" extensions/swarm/src/tools/  # → only in comments + internal file reads
grep -rn "swarm-state.json" extensions/swarm/src/tools/  # → only in comments + internal file reads

# Regression: full swarm test suite must stay green
npm run test:swarm

# No silent catches (AGENTS.md mandate)
grep -rnE "catch\s*\{\s*\}" extensions/swarm/src  # → zero (excl. errorlog.ts internals)
```

## 6. Risks

| Risk | Mitigation |
|------|------------|
| Breaking programmatic consumers that read `details.receipt.mailboxPath` | `details` is unchanged for all sites; only model-visible text is modified. The test asserts `details.receipt.mailboxPath` still contains the path. |
| Breaking programmatic consumers that read `details.source.file` | Same as above — `details` is unchanged. |
| Breaking programmatic consumers that read `details.taskMd`/`details.taskJson` | Same as above — `details` is unchanged. |
| Workers that have already learned the old wording (e.g. from prior sessions) may still try to read the file | The new wording is a behavioral instruction, not just a path removal. The test asserts the new wording is present. |
| The `swarm_spawn_agent` warning text change (Finding J) may confuse users who are used to seeing `.pi/swarm.yaml` in the warning | **Rev 2 correction:** warning texts at `lifecycle.ts:69,87` are NOT changed — kept byte-identical for operator grep-ability. Only the tool description + 2 param descriptions are genericized. |
| The `swarm_create_task` description change (Finding I) removes the explicit path that some users may rely on for debugging | The description still says "Create a durable task graph with task markdown, task state, event stream, and artifact directory" — the file types are named generically. Users who need the exact path can use `swarm_task_status detail:"graph"` which returns the task metadata. |
| The `swarm_check_mailbox fullBody:true` hint change (Site 2) may confuse workers who were using the old hint to find the mailbox file | **Rev 2 correction:** the new hint is exactly `…[+N chars truncated — re-read with fullBody:true and a smaller limit to page through the rest]` — no "or reference the artifact path" (that re-teaches path-following). The bounded tool is still the way to read the full body. |
| The `swarm_send_message` receipt text change (Site 1) removes the `Mailbox:` segment that some harnesses may parse | The `deliveryStatus` field already tells the harness whether the message was `delivered_to_pane` or `queued_in_mailbox`. The `receipt.mailboxPath` in `details` is unchanged for programmatic use. |
| The root mailbox-only note change (Site 8) changes the wording that root may have learned to expect | The new wording is a behavioral instruction ("replies arrive in root's mailbox via the pump; root uses swarm_check_mailbox to read; do not read root's mailbox file directly") that is more actionable than the old "durable in mailbox" phrasing. |

## 7. Self-check (per planner playbook)

- [x] Every file/seam reference has a cited path (reader can verify in one hop)
- [x] Acceptance criteria are all outcome-shaped (observable, falsifiable)
- [x] Every validation command is executable as-written
- [x] Risks section names every cross-cutting invariant that could break
- [x] Scope is minimal: nothing in allowedFiles that the plan doesn't touch (Findings K and L are explicitly deferred with justification)

## 8. Out of scope (explicit)

- `extensions/swarm/src/commands/pool.ts` (Finding K) — not in allowedFiles; deferred to a separate task.
- `extensions/swarm/src/nudges/goal-epoch.ts:794` (Finding L) — message body, not tool output; deferred to a separate task.
- `extensions/swarm/src/tools/gating.ts:56` — internal file read, never model-visible; no change needed.
- `extensions/swarm/src/tools/agents/status.ts:9,311,317,318` — code comments only, never model-visible; no change needed.
