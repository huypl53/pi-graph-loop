# Background Tasks — Pi Extension Design Doc

**Status:** APPROVED (reviewer ✅ after 2 review rounds + TUI addendum). Design-converged; ready to implement. Final.
**Owner:** planner agent
**Target package:** `pi-graph-agents` → new extension `extensions/background-tasks/`
**Date:** 2026-08-04

> Design only. No extension code yet. This document reuses the **swarm** extension's proven
> primitives (`paths()` / `ensureDirs()` / `withLock()` / `readState` / `writeState` /
> `atomicWriteFile` / `trace()` / `now()` / `safeId()` / `textResult()` / `truncate()` /
> config-precedence-from-`compact-resume`) rather than inventing new ones.

---

## 1. Scope & Definition — what is a "background task" here?

A **background task** is a single **shell command** that an agent starts through this extension
and that **keeps running after the tool call returns**, so the parent agent can continue its own
turn and check status / output later. The process is owned by the project session (durable across
`/reload`, `/fork`, resume, and process restarts), not by the bash tool's ephemeral subshell.

### Precise niche

| Thing | Blocks the agent's turn? | Durable / reattachable across sessions? | Output captured & queryable? | What it is |
|---|---|---|---|---|
| `bash` tool | Yes (bounded by tool timeout) | No | Returned once, inline | One-shot command |
| `bash` with `&` | No (shell backgrounds it) | **No** — killed when the bash subshell exits; no record; no log path | No | A shell background job with no harness support |
| **subagent example** (`spawn(pi, …)` SYNCHRONOUSLY, awaited) | **Yes** — `await exit` blocks until the child pi process finishes | No | Captured from JSON stream | Delegated **pi agent** run |
| **swarm tmux agents** | No (fire-and-forget spawn) | Yes (long-lived) | Via capture/mailbox | Long-lived **pi agent processes** with identities, mailboxes, peer coordination |
| **background task (this extension)** | **No** | **Yes** | **Yes** (log files + tail tool) | A long-running **shell command** owned/observed by the current session |

**The niche:** *"start a long build / test / eval / watcher as a plain command, keep chatting, poll
status and output later — and have it survive session restarts."* It is the async, observable,
restartable counterpart to the synchronous `bash` tool. It is **not** multi-agent coordination
(swarm) and **not** delegated-agent delegation (subagent).

### Out of scope for V1 (call out explicitly)
- Spawning a **separate pi process** as a background task (that overlaps subagent; revisit as an
  optional `mode: "pi"` later).
- tmux-interactive tasks (no attachable shell; we capture logs, not panes).
- Sandboxing / containerization of the command.
- A periodic orchestrator pump / push notifications (V1 is pull-based: `background_status`).

---

## 2. Process Model

**Decision: `child_process.spawn` with `detached: true` + `child.unref()`, run through a small
shell wrapper that writes an exit marker.**

### Why this over the alternatives

- **Not `pi.exec`**: `pi.exec` (`pi.exec("cmd", args, { timeout })`) is a bounded, awaited helper
  (swarm uses it for short `git`/`tmux` calls). It blocks the caller. Wrong shape for fire-and-forget.
- **Not tmux**: we don't need an attachable interactive pane or peer-coordination; we need a
  detached long-running command with captured logs + liveness checks. tmux is heavyweight overhead
  here (and adds a hard dependency). Background tasks deliberately *do not* show up as swarm agents.
- **Not a separate pi process (subagent-style)**: that is delegated-agent delegation and it blocks
  (subagent `await`s the exit). A different problem.

### Survival requirements
- **Must survive the parent agent's turn** → `detached: true` makes the child a process-group
  leader; `child.unref()` removes it from the parent pi process's event loop so the tool call can
  return immediately and pi's turn can end.
- **Should survive `session_shutdown`** (default): detached children outlive the spawning process.
  This is the *desirable* default ("start the build, quit pi, the build keeps running"). A config
  knob `PI_BG_TASKS_KILL_ON_SHUTDOWN` (default `0` = leave running) lets a user opt into killing
  tasks this session started on shutdown.
- **Killing a task**: because we spawned detached (new process group), we can kill the **whole
  group** with `process.kill(-pid, "SIGTERM")`, then escalate to `SIGKILL` after a grace period
  (`PI_BG_TASKS_STOP_GRACE_MS`, default 5000). This kills the command *and* any children it forked.

### Spawn argv (quote-safe) + in-wrapper timeout watchdog
The command runs inside a detached `sh` wrapper. To avoid single-quote injection / interpolation
bugs, the user `command` is passed as a **distinct nested `sh -c` argv element** (never
string-interpolated into the wrapper), and the marker carries **only `{exitCode,signal}`** (no
timestamp — see fix below). When `timeoutMs` is set, the deadline is enforced **inside the
wrapper** by a portable `sh` watchdog: stock macOS has **no `timeout`/`gtimeout`**, and a Node
`setTimeout` would die with the spawning pi, so an over-time task would run forever after a crash.
Putting the watchdog in the child process group makes the deadline survive a pi crash:

```ts
// spawn("sh", ["-c", WRAPPER, "<sh>", <user command>, <exit-marker abs path>, <timeoutMs|''>], { detached:true, ... })
// Because Node spawns this wrapper detached:true, the wrapper IS the process-group leader (pgid == $$).
const WRAPPER = [
  'CMDFILE=$1; EXITFILE=$2; TIMEOUTMS=$3; shift 3;',
  'sh -c "$CMDFILE" & CPID=$!;',          // user command as a NESTED sh -c (no interpolation)
  'WPID=',
  // watchdog kills the WRAPPER'S WHOLE PROCESS GROUP (-"$$"), not just $CPID — so the command AND
  // all its descendants die (no orphans, verified). Killing the wrapper before printf => NO marker => case 2.
  'if [ -n "$TIMEOUTMS" ]; then ( sleep "$((TIMEOUTMS/1000))" && kill -TERM -"$$" 2>/dev/null ) & WPID=$!; fi',
  'wait "$CPID"; EC=$?;',                  // natural exit OR group-killed by background_stop/watchdog
  'kill "$WPID" 2>/dev/null;',             // reap the lingering watchdog subshell on natural exit
  "printf '{\"exitCode\":%s,\"signal\":\"\"}\n' \"$EC\" > \"$EXITFILE\";",   // BSD-date-safe: no %N, no date
  'exit "$EC"',
].join(" ");
```

> **Why the group kill (`-"$$"`), not `"$CPID"` (review #2 fix #11).** Killing only `$CPID`
> (the inner `sh`) leaves the command's own children orphaned and running — verified empirically:
> `sleep 10; echo NEVER` with a 1.5s timeout killed the inner `sh` but `sleep` kept running. Because
> the wrapper is spawned `detached:true` it is the process-group leader (`pgid == $$`), so
> `kill -TERM -"$$"` reaches the wrapper + inner `sh` + the command + **all descendants** — exactly
> what `background_stop`'s `process.kill(-pid)` already does. (`setsid` is NOT available on stock
> macOS; `-$$` on a detached group leader is the portable lever.) Killing the wrapper before it
> reaches `printf` means a timed-out task writes **no marker** → it is case 2 (live listener), which
> now matches the contract below. Optional hardening: escalate `TERM`→`KILL` inside the watchdog
> (`... && kill -TERM -"$$" && sleep 2 && kill -KILL -"$$" ...`); a single group TERM is the V1
> default since the live listener captures the signal regardless.

### Reaping / exit-code capture — the precise 3-case contract
With `detached + unref` we never `wait()` on the child, so once the **spawning** pi exits we cannot
read its exit code via Node. The wrapper's `wait`/`printf` runs **only on the natural-exit path**
(a signal that kills the *wrapper `sh`* itself — e.g. a group SIGTERM/SIGKILL from `background_stop`,
`killOnShutdown`, or the watchdog — never reaches `printf`). The exit code is therefore captured by
exactly one of these three cases:

1. **Natural command exit** → wrapper writes `tasks/<taskId>.exit = {"exitCode":N,"signal":""}`.
   `endedAt` is stamped with Node `now()` by whoever finalizes it. exitCode **exact**.
2. **Signal-terminated while the spawning pi is alive** (`background_stop`, `killOnShutdown`, or
   the `timeoutMs` watchdog firing) → the **live** `child.on("exit", (code, signal) => …)` listener
   finalizes the record with the captured `signal` (exitCode null / `128+signum` where reported). The
   watchdog group-kills the wrapper (`-"$$"`) — command **and all descendants**, no orphans — and the
   wrapper dies before `printf`, so **no marker is written** (this is case 2, not case 1).
   `background_stop`/`timeoutMs`/`killOnShutdown` therefore rely on the **live listener**, NOT the marker.
3. **Signal-terminated after the spawning pi died** (killed by a later session / the OS) →
   cross-session reconcile finds **no marker** and `process.kill(pid,0)` throws `ESRCH` → finalized
   as `unknown`, `exitCode: null`, `reapedByExternal: true`. This is the honest worst case.

**Contract:** marker ⇒ natural exit (exact code); live listener ⇒ signal-terminated while pi alive
(signal captured); no-marker + dead ⇒ `unknown`. SIGKILL can never run a trap; a SIGTERM that kills
the wrapper `sh` also produces no marker — which is exactly why `background_stop`/`timeoutMs`/
`killOnShutdown` depend on the **live** listener and only natural exits recover cross-session with an
exact code.

### Liveness check (authoritative = marker, NOT liveness)
`process.kill(pid, 0)` throws `ESRCH` if no such pid — but **liveness is ambiguous** (pids are
reused after reboot / long uptime), so it is never authoritative on its own:
- **marker present & parses** ⇒ authoritative finalize (case 1);
- **no marker + `kill(pid,0)` ok** ⇒ keep `running`, **best-effort**: a rebooted/reused pid would
  falsely read alive, so we also record `startedAtBoot`/`startedAtEpoch` (§3) and downgrade to
  `unknown` on a boot/epoch mismatch;
- **no marker + `ESRCH`** ⇒ `unknown` (case 3). `unknown` is the safe cross-reboot fallback.

---

## 3. State & Persistence

### Location
All state under `<cwd>/.pi/background-tasks/` (mirrors `.pi/swarm/`):

```
.pi/background-tasks/
  state.json            # SOLE source of truth: single registry of tasks, atomic-written (temp+rename)
  state.lock            # mkdir-based lock (exact swarm withLock pattern)
  tasks/<taskId>.exit   # exit marker {exitCode,signal} written by the spawn wrapper (§2 case 1)
  logs/<taskId>.out.log # stdout stream
  logs/<taskId>.err.log # stderr stream
  events.jsonl          # structured trace (append-only, exact swarm trace() pattern)
```

> **Canonical source = `state.json` only.** V1 does NOT keep a separate `tasks/<id>.json`:
> writing two files under one lock is not crash-atomic across both, and a crash between the two
> `atomicWriteFile`s would leave them inconsistent with no stated winner. `state.json` (atomic
> temp+rename) is the single source of truth, exactly like the original swarm `swarm-state.json`. A
> regenerable per-task cache can be added later if the read path needs it; reconcile reads nothing
> from disk except `state.json` + the marker files. (Resolves §10 Q1.)

### Concurrency / locking
Reuse the swarm `withLock(p, fn)` mkdir-based lock verbatim (with a per-extension `LOCK_STALE_MS`).
Every state mutation (start/stop/reconcile/finalize) happens inside `withLock(p, async () => {
const st = await readState(p, cwd); … ; await writeState(p, st); })`. The spawn itself happens
*inside* the lock too (so the pid is recorded before the child can exit and the `exit` listener
fires into a locked re-read). Log streams are opened before the lock is released.

### Task record schema (`BackgroundTask`)
```ts
type BgStatus = "pending" | "running" | "done" | "failed" | "killed" | "unknown";

interface BackgroundTask {
  taskId: string;            // safeId of caller-provided label, else bg-<timestamp>-<rand>
  label?: string;            // human label (caller-provided)
  status: BgStatus;          // see lifecycle below
  command: string;           // the shell command string
  args?: string[];           // optional explicit argv when shell:false
  shell: boolean;            // true → run via `sh -c` (default true)
  cwd: string;               // absolute, containment-checked vs ctx.cwd (§7)
  env?: Record<string, string>; // optional merged env (built on INHERITED process.env + these)
  pid?: number;              // child pid (process-group leader)
  pgid?: number;             // process group id (== pid for detached)
  startedAt: string;         // ISO (now())
  endedAt?: string;          // ISO when finalized
  exitCode?: number | null;  // null when reaped externally / unknown
  signal?: string | null;    // e.g. "SIGTERM"
  reapedByExternal?: boolean;// true if finalize came from marker/liveness, not our exit listener
  lastNotifiedStatus?: BgStatus; // persisted UI dedup: last status the TUI notified (survives /reload) (§11.3)
  timeoutMs?: number;        // optional auto-kill timer (from background_start)
  spawnedByPid: number;      // process.pid of the pi that started it (for killOnShutdown scoping)
  spawnedBySession?: string; // PI_SESSION_ID of spawner (attribution only)
  kind: "shell";             // task kind; "shell" now — reserves a cheap seam for a future "pi" mode (§10 Q7)
  startedAtEpoch?: number;   // child start time (ms since boot) for PID-reuse disambiguation (§2 liveness)
  startedAtBoot?: string;    // boot id / kernel boot time; mismatch ⇒ pid reused after reboot ⇒ unknown
  logOut: string;            // relative path to stdout log
  logErr: string;            // relative path to stderr log
  logTruncated?: boolean;    // true if a hard size cap stopped appending
  exitMarker: string;        // relative path to tasks/<id>.exit
  createdAt: string;
  updatedAt: string;
}

// Capture sources for the PID-reuse fields above (portable; review #2 note #3):
//   startedAtEpoch  = child start time, ms since boot. macOS: `ps -o lstart= -p <pid>` parsed to
//                    epoch-ms relative to boot; Linux: `/proc/<pid>/stat` field 22 (starttime in
//                    clock ticks) × (1000/clk_tck). Fallback: Date.now() - uptime if ps unavailable.
//   startedAtBoot   = kernel boot time as a stable id. macOS: `sysctl -n kern.boottime` sec;
//                    Linux: `/proc/stat` btime line. A mismatch on reconcile ⇒ the pid was reused
//                    after a reboot ⇒ finalize as `unknown` rather than trusting `kill(pid,0)`.

interface BackgroundState {
  version: number;           // 1
  cwd: string;
  tasks: Record<string, BackgroundTask>;
  createdAt: string;
  updatedAt: string;
}
```

### `session_start` restore (reconcile)
Inside `withLock`:
1. `ensureDirs(p)`.
2. For each task with `status === "pending" || "running"`:
   - **marker exists & parses (authoritative, §2 case 1)** → finalize: `status` = `done` (exitCode
     0) / `failed` (non-zero); stamp `endedAt` with Node `now()` (the marker intentionally carries
     no timestamp — BSD `date` has no `%N`); keep `exitCode`/`signal` from the marker.
   - **else if `process.kill(pid, 0)` throws `ESRCH`** → finalize as `unknown`, `exitCode: null`,
     `reapedByExternal: true`.
   - **else (`kill(pid,0)` ok, no marker)** → leave `running`, **best-effort only**: if the recorded
     `startedAtBoot`/`startedAtEpoch` no longer match the current boot/epoch (pid reused after
     reboot), finalize as `unknown` instead of trusting the live pid. No `timeoutMs` re-arm is
     needed — the deadline is owned by the wrapper's watchdog child (§2), which survives independently.
3. `trace(p, "session.start", { reconciled: n, alive, finalized })`.
4. Start **no** background resources in the factory; the reconcile runs in the `session_start` hook
   (satisfies the "defer to session_start" constraint).

### `withLock` + `trace` + `safeId` + `now` + `textResult` + `atomicWriteFile`
All reused as-is from the swarm `src/state.ts` / `src/utils.ts` shape (re-implemented locally in
`extensions/background-tasks/src/` so the extension is self-contained; see §8).

---

## 4. Output Capture

- Streams: child `stdout` → `logs/<taskId>.out.log`, child `stderr` → `logs/<taskId>.err.log`
  (separate files; combined view is produced on read by concatenation).
- Write via `fs.createWriteStream(path, { flags: "a" })` and pipe child streams into them. A
  **hard size cap** (`PI_BG_TASKS_LOG_MAX_BYTES`, default 5 MB per stream) — once exceeded, stop
  appending to that stream and set `logTruncated: true` on the record (V1 keeps it simple; log
  rotation is V2, flagged §10).
- Finalization appends one sentinel line `[bg-task exited code=N signal=S at <iso>]` to both logs
  when the live `exit` path runs (helps a human `tail`-ing the file).
- **Truncation on read**: `background_output` returns a bounded slice using pi's
  `truncateHead`/`truncateTail` (with `DEFAULT_MAX_BYTES` / `DEFAULT_MAX_LINES`), exactly as swarm's
  `truncate()` helper does for traces. Default tail = last 50 lines; caller can ask for `head`/`tail`.
- Paths returned to the LLM are **project-relative** (e.g. `.pi/background-tasks/logs/bg-….out.log`)
  so the agent can also `read` them directly for large/offset reads.

---

## 5. Tools to Expose

All registered via `pi.registerTool(defineTool({ name, label, description, promptGuidelines, parameters, execute }))`
following `extensions/swarm/src/tools/agents.ts`. **`promptGuidelines` names each tool.** Tool
errors are **thrown** (pi sets `isError: true`). Returns use `textResult(text, details)`.

> **Enum params use `StringEnum([...], { description, default })` imported from
> `@earendil-works/pi-ai`** — NOT `Type.Union(Type.Literal(...))` or bare `Type.String`.
> `StringEnum` emits `{type:"string",enum:[...]}`, which is compatible with providers (e.g.
> Google/Gemini) that reject `anyOf`/`const` (confirmed in
> `examples/extensions/subagent/index.ts` `AgentScopeSchema`). Applies to `background_output.stream`,
> `background_stop.signal`, `background_status.status`.

**Minimal set: FIVE tools.** (`background_list` was collapsed into `background_status`'s `status?`
filter per the reviewer's minimality lean — one fewer overlapping verb; human enumeration lives in
the `/bg` TUI command §11.4, not as an agent tool.)

### 5.1 `background_start`
Start a background task; returns immediately (child is detached/unref'd).
```
parameters:
  command: string           // required (used when shell:true, or argv[0])
  args?: string[]           // optional explicit argv (shell:false)
  cwd?: string              // default ctx.cwd; must be ctx.cwd or a subdir (containment check)
  label?: string            // human label; derives taskId via safeId
  env?: Record<string,string> // merged onto process.env
  shell?: boolean           // default true
  timeoutMs?: number        // optional auto-kill after N ms
returns:
  { taskId, status:"running"|"pending", pid, logOut, logErr, cwd }
promptGuidelines: ["Use `background_start` to launch a long-running command that keeps running while you continue working; check it later with `background_status`/`background_output`."]
```

### 5.2 `background_status`
Status of one task, or all tasks if `taskId` omitted (optionally filtered by `status`). **Reconciles
lazily** (reads exit markers, checks liveness) before returning, under `withLock`.
```
parameters:
  taskId?: string
  status?: StringEnum["running","done","failed","killed","pending","unknown"]   // filter; only with no taskId
returns:
  { count, tasks: [ { taskId, label, status, pid, startedAt, endedAt, exitCode, ageSec, logOut, logErr } ] }
promptGuidelines: ["Use `background_status` to check background tasks: one task by taskId, or all tasks when taskId is omitted (optional status filter)."]
```

### 5.3 `background_output`
Return captured stdout/stderr (bounded tail/head).
```
parameters:
  taskId: string
  stream?: StringEnum["stdout","stderr","combined"]   // default "combined"
  tail?: number   // default 50 lines (mutually exclusive with head)
  head?: number   // optional leading lines
returns:
  { taskId, status, text:<truncated>, logOut, logErr, truncated }
promptGuidelines: ["Use `background_output` to read the captured stdout/stderr of a background task (bounded tail/head); for full logs, `read` the returned log path."]
```

### 5.4 `background_wait`
**Block** until the task finalizes or `timeoutMs` elapses (bounded, opt-in). Polls liveness/marker
every `PI_BG_TASKS_WAIT_POLL_MS` (~250 ms). **Honors the execute `AbortSignal`** (3rd arg): if the
user cancels / the turn aborts, it stops polling and returns the *current* status with
`aborted:true`.
```
parameters:
  taskId: string
  timeoutMs?: number   // default 30000; effective cap = min(PI_BG_TASKS_WAIT_MAX_MS, PI_TOOL_TIMEOUT_S*1000 − 2000ms slack)
returns:
  { taskId, status, exitCode, signal, endedAt, timedOut:boolean, aborted:boolean, tail:<last lines of combined output> }
  // throws if task unknown
promptGuidelines: ["Use `background_wait` only when you explicitly need to block for a background task to finish (bounded, abortable, returns final status + output tail). Note its cap is clamped under the tool timeout."]
```
> The default/cap are deliberately **below** pi's per-tool timeout (`PI_TOOL_TIMEOUT_S`, default
> 120s) so the harness cannot kill the wait before it returns `timedOut`. Effective max =
> `min(PI_BG_TASKS_WAIT_MAX_MS, PI_TOOL_TIMEOUT_S*1000 − 2000)`.

### 5.5 `background_stop`
Stop a running task by signaling its **whole process group** (`process.kill(-pid, signal)`), then
escalate `SIGTERM`→`SIGKILL` after `graceMs`. Finalization of the record relies on the **live**
`child.on("exit")` listener (§2 case 2), NOT the exit marker — a group signal kills the wrapper
`sh` before its `printf`, so no marker is produced for stopped tasks.
```
parameters:
  taskId: string
  signal?: StringEnum["SIGTERM","SIGKILL"]   // default "SIGTERM"
  graceMs?: number                           // default PI_BG_TASKS_STOP_GRACE_MS (5000)
returns:
  { taskId, status:"killed"|<final>, signal, exitCode, endedAt }
  // throws if not running / already terminal
promptGuidelines: ["Use `background_stop` to terminate a running background task (SIGTERM its process group, escalate to SIGKILL after grace). Only meaningful while the spawning pi is alive; relies on the live exit listener."]
```

> **No `background_list` tool** — collapsed into `background_status` (omit `taskId` + optional
> `status` filter) to keep a minimal, non-overlapping tool surface (reviewer lean, accepted). The
> human-facing enumeration lives in the `/bg` TUI command (§11.4), not as an agent tool.

---

## 6. Lifecycle & Cleanup

| Event | Behavior |
|---|---|
| **factory** | Only `pi.on(...)` registrations + `pi.registerTool(...)` + `pi.registerCommand(...)`. **No** processes started, no timers, no state files written. |
| **`session_start`** | `ensureDirs(p)`; run reconcile (§3) under `withLock`; `trace("session.start", {…})`. If `ctx.hasUI` set a status line `ctx.ui.setStatus("bg", "bg:N")`. |
| **`background_status`** | Lazily reconcile before returning (cheap, bounded). |
| **`session_start` (TUI)** | After reconcile: if `ctx.mode === "tui"` start the **UI refresh interval** (`PI_BG_TASKS_UI_REFRESH_MS`, default 1000ms) that re-reads state and re-renders the widget + status line (§11). Mirrors swarm's `startOrchestratorMailboxPump` (TUI-gated interval started in `session_start`). |
| **`session_shutdown`** | If `PI_BG_TASKS_KILL_ON_SHUTDOWN==="1"`: for tasks with `spawnedByPid === process.pid` and `status==="running"`, send group **SIGTERM synchronously**, then fire-and-forget a SIGKILL escalation after `graceMs` (**do NOT `await` the grace window in the shutdown hook** — children are already detached/unref'd, so shutdown must not block on the grace period). Best-effort finalize as `killed` via the live listener. Otherwise: do nothing (children survive). |
| **config (settings.json + env)** | Same precedence as `compact-resume`: **env > `.pi/settings.json` extensions block > defaults.** Knobs: `PI_BG_TASKS` (enable/disable), `PI_BG_TASKS_KILL_ON_SHUTDOWN`, `PI_BG_TASKS_MAX` (max concurrent, default 8), `PI_BG_TASKS_LOG_MAX_BYTES` (default 5MB), `PI_BG_TASKS_WAIT_MAX_MS` (default 120000), `PI_BG_TASKS_STOP_GRACE_MS` (default 5000), `PI_BG_TASKS_WAIT_POLL_MS` (default 250), **UI:** `PI_BG_TASKS_UI` (default on in TUI), `PI_BG_TASKS_UI_REFRESH_MS` (default 1000), `PI_BG_TASKS_UI_MAX_ROWS` (default 8). Settings shape under `extensions["background-tasks"]` (with optional `.ui = { enabled, refreshMs, maxRows }`). |
| **zombie detection** | `process.kill(pid, 0)` in reconcile; ESRCH ⇒ dead. Marker file ⇒ finalized with code. |

A `/background-tasks` slash command (mirrors `compact-resume`'s status command) prints config +
counts for the user. Its handler begins `if (!ctx.hasUI) return;` so print/json sessions are no-ops
(same guard as compact-resume's `/compact-resume`).

### Reconcile correctness note
Reconcile is **idempotent** and only ever moves a task *forward* toward a terminal state; it never
restarts or kills anything. So running it on every status call is safe.

---

## 7. Safety

- **cwd containment**: `cwd` must `realpath`-resolve to `ctx.cwd` or a subdirectory of it (reuse
  swarm's `resolveEvidencePath`/containment idea: `realpath(target)` startsWith
  `realpath(ctx.cwd)+sep`). Reject otherwise (throw). This stops `background_start` from running in
  `/` or `..`.
- **command policy**: V1 does **not** sandbox the command string — it relies on the same trust model
  as the built-in `bash` tool (the user already trusts the agent to run shell). Documented as a known
  limitation. An optional allow/deny regex list (`PI_BG_TASKS_ALLOW`/`_DENY`) is a V2 knob.
- **max concurrent tasks**: `PI_BG_TASKS_MAX` (default 8, like subagent's `MAX_PARALLEL_TASKS`).
  `background_start` throws when exceeded.
- **log size caps**: per-stream hard cap (`PI_BG_TASKS_LOG_MAX_BYTES`, default 5 MB); on overflow,
  stop appending + set `logTruncated`. Read-time truncation via `truncateHead`/`truncateTail`.
- **timeout auto-kill**: optional `timeoutMs` on `background_start` is enforced **inside the
  detached wrapper** by a portable `sh` watchdog child that **group-kills `-"$$"`** (wrapper +
  command + all descendants — no orphans), NOT a Node `setTimeout`. The wrapper dies before `printf`,
  so a timed-out task writes **no marker** and is finalized as case-2 by the live listener. Rationale:
  stock macOS has no `timeout(1)`/`gtimeout`, and a Node timer dies with the spawning pi — so an
  over-time task would run forever after a crash. The in-wrapper watchdog is owned by the child
  process group and survives independently. (See §2 spawn argv; review #2 fix #11.)
- **no orphaned timers in the factory**: all timers belong to live tool calls or the session.
- **audit trail**: every `background_start` appends a `task.start` event to `events.jsonl` via
  `trace()` with `{ requestedBy, command, cwd, pid, taskId, timeoutMs }`, and every finalize appends
  `task.finalize`. Because background tasks persist + survive + run unobserved (a stronger threat
  model than the one-shot `bash` tool), this durable audit log is the primary safety control.

---

## 8. Package Structure

**Decision: a new top-level `extensions/background-tasks/` extension, mirroring swarm's multi-file
layout.** NOT folded into `utils` — background tasks are substantial enough to warrant their own
extension, and keeping `utils` for tiny standalone extensions matches the existing split. Discovery
is automatic: pi loader rule #2 (`extensions/<dir>/index.ts`) means adding this dir under
`pi.extensions=["./extensions"]` is picked up with no config change.

```
extensions/background-tasks/
  index.ts              # default factory: readSettings(); registerHooks(pi); registerTools(pi); registerCommand(pi)
  src/
    constants.ts        # EXT="background-tasks", STATE_VERSION, LOCK_STALE_MS, defaults (max, log bytes, wait/stop ms)
    types.ts            # BackgroundTask, BackgroundState, BgStatus, BackgroundSettings
    state.ts            # paths(cwd), ensureDirs, withLock, readState, writeState, atomicWriteFile, appendJsonl, trace
    settings.ts         # readSettings() + env precedence (mirror compact-resume)
    lifecycle.ts        # spawnTask(), killTask(), isAlive(pid), reconcileLocked(), readExitMarker(), buildWrapperArgv()
    utils.ts            # now(), safeId(), textResult(), truncate(), humanAge(), shellQuote() (local copies of swarm helpers)
    hooks.ts            # session_start reconcile + UI interval, session_shutdown killOnShutdown
    ui.ts               # renderUi(), summaryLine(), formatRow(), detectTransitions() (§11)
    tools/
      start.ts          # background_start
      status.ts         # background_status (one-or-all + status filter)
      output.ts         # background_output
      wait.ts           # background_wait
      stop.ts           # background_stop
```

`index.ts` mirrors `extensions/swarm/index.ts`:
```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerHooks } from "./src/hooks.ts";
import { registerTools } from "./src/tools/index.ts";   // one fn registering all 5 tools
import { registerCommand } from "./src/command.ts";
import { readSettings } from "./src/settings.ts";

export default function (pi: ExtensionAPI) {
  const settings = readSettings();
  if (!settings.enabled) return;            // mirror compact-resume disable gate
  registerHooks(pi, settings);
  registerTools(pi, settings);
  registerCommand(pi, settings);
}
```
TypeScript runs uncompiled via jiti (no build step), exactly like swarm. Typecheck command mirrors
the README's swarm one.

> **Future shared-module extraction (non-blocking).** Re-implementing `withLock/paths/now/safeId/
textResult/truncate/shellQuote` locally (~100 LOC) duplicates swarm and risks drift. Acceptable for
V1 (keeps the extension self-contained with no cross-extension import). A later refactor should
extract these into a shared `pi-graph-agents` internal module both extensions import.

---

## 9. Validation Plan (per AGENTS.md — MUST run in a fresh tmux pi session)

The extension is **not** "validated" unless this actually runs in tmux. Smallest realistic workflow:

1. **Isolated tmux target** (per the tmux-pane-operator skill): create a dedicated session/window,
   e.g. `pi-bg-val` (capture before-state).
2. **Launch pi** in it with a packaged extension load:
   ```
   pi --model glm-5.1 --provider zai-coding-cn -e .
   ```
   (`-e .` is belt-and-suspenders — the package's `pi.extensions=["./extensions"]` already
   auto-loads the new dir via loader rule #2; confirm the extension actually loaded by checking the
   `/bg` command exists before running the workflow, per review #2 note #5.)
3. **Workflow inside pi** (driving the agent to call the tools):
   - `background_start` a recognizable command: `sh -c 'sleep 3; echo BG-DONE-MARKER-123'` with
     label `probe`.
   - Immediately `background_status` → expect `status: running` (proves non-blocking: the turn
     returned and the task is still alive).
   - `background_output probe` shortly after → may be empty; proves the read path + relative log
     path is returned.
   - `background_wait probe` → expect `status: done`, `exitCode: 0`, and `tail` containing
     `BG-DONE-MARKER-123` (proves live reaping + output capture).
   - Start a second long task `sleep 60` labeled `slow`, then `background_stop slow` → expect
     `status: killed`, `signal: SIGTERM` (proves group kill + finalize).
   - `background_status` (no taskId) → shows both tasks with correct terminal statuses.
   - **Restart probe (cross-session reaping):** start `sh -c 'sleep 8; echo AFTER-RESTART'`
     labeled `persist`, then `/reload` (or restart pi), then `background_status persist` → after the
     sleep, expect `status: done` via the **exit marker** path (proves reconcile). If timing makes the
     in-process exit fire first, that's also acceptable evidence.
   - **No-orphan assertion (review #2 residual risk — mandatory):** empirically confirm the group
     kill reaches descendants. Start `sh -c 'sleep 30'` labeled `deep` with `timeoutMs: 1500` (a
     real detached child). After it times out, run `bash` `pgrep -P <deep's pid>` (and `pgrep -g
     <pgid>`) → expect **zero** leftover `sleep`/descendant processes. Repeat for a `background_stop`'d
     multi-process command (e.g. `sh -c 'sleep 30 & sleep 30'`). A non-detached test harness cannot
     reproduce this — the real detached tmux run MUST show no `pgrep` leftovers for both the
     `timeoutMs` and `background_stop` paths. (Fix #11 correctness proof.)
4. **Capture after-state** of the pane; assert via file-backed evidence (the log files under
   `.pi/background-tasks/logs/` and `state.json`).
5. **Report** (checklist from AGENTS.md): tmux target, exact pi command, actions performed,
   pass/fail + any fixes, and the log/state file paths for user review.
6. **UI assertions (mandatory, §11 / T6):** the validation MUST visibly demonstrate the widget +
   a finish toast in the captured frames — log-file checks alone do NOT prove the TUI. In the TUI
   run: (a) **capture BEFORE** starting a task → widget absent/cleared (empty state); (b) start
   `probe` → widget shows a ⏳ running row with an elapsed timer that advances; (c) the footer
   status line shows `bg: 1 running` (and updates to `… 1 done` after `probe` finishes); (d)
   **capture AFTER/DURING completion** → widget row flips to ✓ done AND a finish `notify` toast
   appears in the pane; (e) `/bg` opens the scrollable full task list; (f) `/bg off` hides the
   widget. Call out the **tmux target** + the before/after **snapshot paths**
   (`.pi/background-tasks/traces/...` or a tmux `capture-pane` dump) in the report so the user can
   review the actual rendered frames.

---

## 10. Open Questions / Risks (for the reviewer to challenge)

1. **One state file vs. registry+per-task JSON.** ✅ **RESOLVED (review #1):** single `state.json` is the sole source of truth; no per-task JSON (crash-atomicity). See §3.
2. **`background_list` vs `background_status(all)`.** ✅ **RESOLVED (review #1):** collapsed — `background_status` gains an optional `status?` filter; no `background_list` tool. Five tools total. See §5.
3. **Cross-session exit-code accuracy.** ✅ **RESOLVED (review #1):** precise 3-case contract (natural-exit marker exact; signal-terminated while pi alive via live listener; no-marker+dead ⇒ `unknown`). No reap daemon. See §2.
4. **Log rotation vs hard cap.** V1 hard-caps and stops appending (`logTruncated`). Loses early
   output for very chatty long tasks. Rotate (keep last N bytes) instead?
5. **Command sandboxing.** ✅ **RESOLVED (review #1):** trust like `bash` for V1, BUT every `background_start` is traced to `events.jsonl` (who/command/cwd/pid) as the safety control for unobserved persistent commands. Optional allow/deny regex is V2. See §7.
6. **Interaction with the `bash` tool.** An agent could already fake this with `nohup … &`.
   Justification for the extension = durability + observability + lifecycle, not capability. Worth
   stating in the tool guidelines.
7. **`mode: "pi"` background agents.** ✅ **RESOLVED (review #1):** deferred; `BackgroundTask.kind: "shell"` added now as a cheap future seam. V1 strictly shell.
8. **`killOnShutdown` default.** ✅ **RESOLVED (review #1):** default **leave-running**. Orphans are visible via `background_status`/reconcile.
9. **Windows.** `detached` + process groups + `process.kill(-pid)` are POSIX. `windowsHide` is set,
   but group-kill semantics differ. Scope V1 to macOS/Linux, document Windows as best-effort?
10. **Id collisions.** `taskId = safeId(label)` can collide if labels repeat; fall back to
    `bg-<timestamp>-<rand>` when the safeId already exists. Confirm this resolution rule.
11. **Should bg tasks surface into swarm?** ✅ **RESOLVED (review #1):** no integration — keep fully separate from `.pi/swarm/`.
12. **PID-reuse / reboot safety (review #1).** `process.kill(pid,0)` success ≠ still-YOUR-task (pids reused after reboot). Mitigated: marker is authoritative; `startedAtBoot`/`startedAtEpoch` recorded to invalidate a reused pid across reboot ⇒ `unknown` rather than falsely `running`. See §2/§3. Open: is boot-id capture (platform-specific) worth V1, or rely on the epoch heuristic only?
13. **UI refresh cadence vs cost (addendum lean).** ✅ **RESOLVED:** 1 s, always-on (incl. during streaming) — cheap lock-free atomic-snapshot read. mtime guard / pause-while-typing deferred.
14. **Where the widget lives (addendum lean).** ✅ **RESOLVED:** ship BOTH — below-editor `setWidget` (detail) + footer `setStatus("bg:2r/1d")` (count). Header replacement rejected (invasive). Render-only V1 (no row key handler).
15. **Notification spam (addendum T4).** ✅ **RESOLVED:** notify **once** per running→terminal transition, deduped by the **persisted `lastNotifiedStatus`** field on the record (survives /reload); `info` on `done`, `warning` on `failed`/`killed`. Tick-only detection (not the live `child.on("exit")` listener) to keep one decoupled source and avoid stale-ctx. See §11.3.
16. **UI tick: read-only vs reconciling (addendum T5).** ✅ **RESOLVED (review #2 note #2):** tick is read-only EXCEPT it `stat`s each running task's exit marker and does a short locked finalize when one is present, so the widget + notify fire without a tool call/restart. Lock-free snapshot otherwise (atomic rename ⇒ no torn reads). See §11.2.

---

## 11. TUI / User-facing UI (mandatory)

> Added per a hard requirement from the human (orchestrator relay): the extension must let the
> **human user** see background tasks live in the TUI — not only tools for the agent. This whole
> section is mandatory. Every `ctx.ui.*` call is guarded; print/json/rpc modes get zero UI and the
> tools still work.

### 11.1 What we render (placement decision)

Two complementary, always-guarded surfaces:

1. **Below-editor widget** — `ctx.ui.setWidget("bg-tasks", lines, { placement: "belowEditor" })`
   (API: `widget-placement.ts`, `custom-ui.md`). One compact line per task. This is the *detail*
   view. We chose **below-editor** over above-editor/header/footer because: the header is shared
   with branding + keybinding hints (`setHeader` replaces it wholesale — too invasive); the footer
   is one line — too cramped for a table; above-editor sits between input and the transcript and is
   visually noisy. Below-editor is the natural "ambient panel" slot and is a first-class `setWidget`
   placement.
2. **Footer status line** — `ctx.ui.setStatus("bg-tasks", "bg: 2 running, 1 done")` (API:
   `status-line.ts`). A glanceable one-line summary that is always present while tasks exist.

Rendering rules:
- **0 tasks** → clear the widget (`setWidget("bg-tasks", undefined)`) and clear the status
  (`setStatus("bg-tasks", undefined)`). No empty panel, no wasted screen. *(Deviation from review
  addendum T3, which suggested a dim "no background tasks" empty state — we clear instead so the
  feature leaves zero footprint when idle; flag for confirmation.)*
- **1…N (N ≤ `PI_BG_TASKS_UI_MAX_ROWS`, default 8)** → one row per task.
- **> N** → render the **newest** N rows, then a footer row `… +k more  (/bg for all)`.
- Each row: `{icon} {labelOrCmd}  {mm:ss elapsed}  {pid}  {lastCombinedLine}`. Icon map:
  `⏳` running · `✓` done · `✗` failed · `◔` killed · `?` unknown. Label falls back to the command
  string if no `label`. `labelOrCmd` and `lastCombinedLine` are width-truncated with
  `truncateToWidth`/`visibleWidth` from `@earendil-works/pi-tui` (same as `custom-footer.ts`).
- Colors via `ctx.ui.theme.fg(...)`: running=`accent`, done=`success`, failed=`error`,
  killed/unknown=`muted`; elapsed/last-line in `dim`.

> **Widget form (string[], not a component factory) + render-only.** We use the simple
> `setWidget("bg-tasks", string[])` form called repeatedly by the interval, NOT the
> `(tui, theme) => Component & { dispose() }` factory the addendum floated. Rationale: the interval
> is the update driver (mirrors swarm's pump, which also avoids component factories), and the widget
> holds **no stream/resource handles** — so there is nothing for `dispose()` to close; teardown is
> just `setWidget("bg-tasks", undefined)` on `session_shutdown`. V1 is **render-only**: rows have no
> key handler / click action (opening logs is via the `/bg` command or the `read` tool), per the
> addendum's own lean.

### 11.2 What drives live updates

A **TUI-gated interval started in `session_start`**, exactly mirroring swarm's
`startOrchestratorMailboxPump` (`extensions/swarm/src/hooks.ts`):

```ts
let uiTimer: NodeJS.Timeout | undefined;
const stopUiTimer = () => { if (uiTimer) clearInterval(uiTimer); uiTimer = undefined; };

pi.on("session_start", async (_e, ctx) => {
  await reconcileLocked(ctx.cwd);                 // §3 restore
  if (ctx.hasUI) ctx.ui.setStatus("bg-tasks", summaryLine());
  if (ctx.mode !== "tui") return;                 // interval is TUI-only
  const refreshMs = settings.ui.refreshMs;        // default 1000
  const tick = async () => { try { await renderUi(ctx); } catch { /* best-effort */ } };
  await tick();
  uiTimer = setInterval(() => { void tick(); }, refreshMs);
});

pi.on("session_shutdown", () => stopUiTimer());   // ALWAYS clear the interval
```

**Closure lifecycle (explicit).** The `uiTimer` handle lives in a module closure — **one timer per
live TUI session**. The factory registers hooks only (no timer, no widget, no state files),
satisfying the "nothing in the factory" rule. Print/`-p`/json/rpc sessions never start the timer
(`ctx.mode !== "tui"` early-return), matching swarm's note that `-p`/print exits after one turn.
`session_shutdown` always `clearInterval`s and tears the widget down (`setWidget("bg-tasks",
undefined)`), even on `/reload`/`/fork`/resume — the next `session_start` starts a fresh timer with
a live `ctx`.

`renderUi(ctx)`:
1. **Read-only snapshot** then **marker-finalize**: `const st = await readState(p, cwd)` (no
   `withLock`; `state.json` is atomic temp+rename ⇒ a lock-free read is a complete, untorn
   snapshot). For each task still `running`, `stat` its `tasks/<id>.exit`; if present, take a short
   `withLock` to finalize it (read marker, stamp `endedAt`, set status) + write. This makes the widget
   + notify fire even when the spawning pi is dead and no tool is being called (review #2 note #2).
2. **Detect transitions** for notifications (§11.3) by comparing each task's persisted
   `lastNotifiedStatus` to its current `status`.
3. **Render**: compute rows → `setWidget("bg-tasks", rows.length ? rows : undefined, {
   placement: "belowEditor" })` + `setStatus("bg-tasks", summary)`.

> **T5 locking — why lock-free (addressing the addendum's `withLock` lean head-on).** The addendum
> leaned toward a read-only `withLock` peek at 1 Hz. We go **lock-free** instead: `state.json` is
> written by `atomicWriteFile` (write temp → `rename`), and POSIX `rename` is atomic, so a
> concurrent reader observes either the old or the new *complete* file — **never a torn/partial
> read**. Therefore the timer can never observe an inconsistent registry, and it avoids even the
> sub-ms lock contention of a `withLock` peek against tool writes. (A `withLock` read-only peek is a
> correct, trivially-swappable equivalent if the reviewer prefers the belt-and-suspenders form.) The
> tick never mutates state, so it never contends for the *write* lock.

> **Tick mutates ONLY on marker (review #2 note #2 — shipped).** The tick is read-only except for a
> short locked finalize when it `stat`s an exit marker for a `running` task (so the widget + notify
> fire without a tool call/restart in the "spawning pi dead, idle TUI, task finishes" case). It never
> spawns/kills and never contends for the write lock otherwise. State freshness otherwise comes from
> the live `child.on("exit")` listener (spawning pi alive) and `session_start` reconcile.

### 11.3 Notifications on finish / fail

`ctx.ui.notify(text, level)` (API: `notify.ts`) is called **once** per `running → terminal`
transition, deduped by the **persisted `lastNotifiedStatus` field on the record** (§3) — persisted,
not in-memory, so the dedup **survives `/reload`/`/fork`/resume** and can't double-notify across
sessions. On each tick, for a task whose `status` is terminal and differs from
`lastNotifiedStatus`, notify then (under a quick `withLock` write) set `lastNotifiedStatus =
status`:
- `done` (exitCode 0) → `notify(\`bg '${label}' done (code 0)\`, "info")`
- `failed` (exitCode ≠ 0) → `notify(\`bg '${label}' failed (code ${exitCode})\`, "warning")`
- `killed` → `notify(\`bg '${label}' killed\`, "warning")`

The detection runs inside `renderUi` so it covers both the live-exit case and the cross-session
reconcile case uniformly. (The live `child.on("exit")` listener is an alternative notification
path but is not used for UI, to keep a single decoupled source of truth and to avoid touching a
possibly-stale captured `ctx`.)

### 11.4 `/bg` slash command

`pi.registerCommand("bg", { description, getArgumentCompletions, handler })` (API: `commands.ts`):
- `/bg` → a scrollable `ctx.ui.select("Background tasks", rows)` of **all** tasks (full columns:
  id, label, status, elapsed/ended, exitCode, pid). Reuses the `commands.ts` select-list pattern.
- `/bg running|done|failed|killed` → same list filtered by status (autocomplete via
  `getArgumentCompletions`).
- `/bg off` → hides the widget for the session (re-enable with `/bg on`).

### 11.5 Guards (non-negotiable)

| Call | Guard |
|---|---|
| `ctx.ui.setStatus(...)` / `setWidget(...)` / `notify(...)` | `if (ctx.hasUI)` |
| the interval, `ctx.ui.custom(...)`, component factories, `setFooter`/`setHeader` | `if (ctx.mode === "tui")` |
| everything in `/bg` handler | `if (ctx.hasUI)` (and `select` is a no-op default in RPC) |

Modes: `tui` → full UI; `rpc` → `hasUI` true but `custom()` no-op (dialogs/notify via JSON); `json`/
`print` → `hasUI` false, **zero UI**, tools still fully functional. (Cheatsheet in `custom-ui.md`.)

### 11.6 New files / wiring

- `src/ui.ts` — `renderUi(ctx, p, settings, lastStatus)`, `summaryLine(st)`, `formatRow(task,
  theme, width)`, `detectTransitions(st, lastStatus)`.
- `src/command.ts` — the `/bg` command (was already in §8; now hosts the UI command too).
- `src/hooks.ts` — owns `uiTimer` start (TUI-only) / clear (shutdown), alongside reconcile.
- Config in `src/settings.ts` gains `ui: { enabled, refreshMs, maxRows }` (env > settings > defaults).

### 11.7 Stale-ctx resilience

Like swarm's pump, a captured `ctx` can go stale after `/reload`/session replacement: a `ctx.ui.*`
 call may throw. The tick wraps `renderUi` in `try/catch`; on a stale-ctx error it
 `stopUiTimer()` once and traces, so a broken interval doesn't spam stderr every second — the next
 `session_start` restarts a fresh interval with a live `ctx` (same pattern as
 `pumpOrchestratorMailbox`'s `orchestratorMailboxPumpError` handling).

---

## Appendix A — Reused primitives (proven in swarm)

| Primitive | Source | Reused for |
|---|---|---|
| `withLock(p, fn)` (mkdir lock + stale break) | `swarm/src/state.ts` | all state mutations |
| `paths(cwd)` + `ensureDirs(p)` | `swarm/src/state.ts` | `.pi/background-tasks/` layout |
| `readState`/`writeState`/`atomicWriteFile` | `swarm/src/state.ts` | state.json durability |
| `appendJsonl` / `trace(p, event, data)` | `swarm/src/state.ts` | `events.jsonl` |
| `now()`, `safeId()`, `textResult()`, `truncate()`, `humanAge()` | `swarm/src/utils.ts` | ids/timestamps/returns |
| `defineTool({name,label,description,promptGuidelines,parameters,execute})` + `pi.registerTool` | `swarm/src/tools/agents.ts` | all 5 tools |
| `StringEnum([...], {description,default})` (enum params) | `@earendil-works/pi-ai` (used in `subagent/index.ts` `AgentScopeSchema`) | `background_output.stream`, `background_stop.signal`, `background_status.status` |
| `shellQuote()` | `swarm/src/utils.ts` | quote-safe spawn argv (§2) |
| `truncateHead`/`truncateTail`/`DEFAULT_MAX_*`/`formatSize`/`CONFIG_DIR_NAME` | pi-coding-agent exports | output truncation + `.pi/` root |
| env > settings.json > defaults precedence | `compact-resume.ts` | config knobs |
| `ctx.ui.setWidget`/`setStatus`/`notify` + TUI-gated interval in `session_start` (cleared on shutdown) | `widget-placement.ts`, `status-line.ts`, `notify.ts`, swarm `startOrchestratorMailboxPump` | §11 TUI |
| `truncateToWidth`/`visibleWidth` | `@earendil-works/pi-tui` (`custom-footer.ts`) | widget row width-truncation (§11) |
| `session_start` reconcile / `session_shutdown` cleanup | `swarm/src/hooks.ts` | lifecycle |
| `pi.exec` (bounded) | swarm `tmux.ts`/`captureGitCommit` | **not** used for the task itself (spawn instead); used only for tiny helpers if needed |

## Appendix B — Lifecycle state machine

```
pending ──start(spawn ok)──▶ running ──exit(code 0)──▶ done
                              │      └──exit(code≠0)──▶ failed
                              │      └──background_stop──▶ killed
                              │      └──timeoutMs──▶ killed
                              │      └──killOnShutdown──▶ killed
                              └──(spawning pi dies)── reconcile: marker? finalize : (alive? running : unknown)
```
Terminal states: `done`, `failed`, `killed`, `unknown`. Reconcile only moves forward to a terminal
state; it never restarts.
