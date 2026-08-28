# cron

A minimal pi extension that schedules recurring prompts and injects them into the current session as real user-visible turns.

## Install / load

Ships with the `pi-graph-agents` package (`extensions/cron/index.ts`). The repo root `package.json` exposes `"pi": { "extensions": ["./extensions"] }`, so the extension auto-loads in any pi session opened in a project that includes this package — no `-e` flag needed.

## Commands

| Command | Effect |
|---|---|
| `/cron add --every <n><s|m|h> "<prompt>"` | Add a job. `n` must be a positive integer; unit is `s`, `m`, or `h`. |
| `/cron list` | Show all jobs with their ordinal `#`, interval, last-fire timestamp, and a prompt preview. |
| `/cron remove <#>` | Remove the job at list ordinal `#`. `/cron remove last` removes the most recently added job. |

Jobs have no names — they are identified by their list ordinal. Removing a job shifts the ordinals of the remaining jobs.

## Scheduling semantics

- **Tick cadence**: 30s. The scheduler uses a self-rescheduling `setTimeout` chain (not `setInterval`) so a lost tick cannot silently drop the loop; `session_shutdown` tears it down and the next `session_start` re-arms it.
- **First fire**: a newly added job has `lastRunAt: null`, so it is due immediately and fires on the very next tick (within ~30s of `/cron add`); subsequent fires follow the interval.
- **Missed-tick policy**: if pi was down for longer than one interval, each overdue job fires **at most once** on resume. There is no backfill of missed intervals; after the catch-up fire, the normal cadence resumes from that run time.
- **Injection surface**: scheduled prompts are sent with `pi.sendUserMessage(...)` — a real user message that always triggers a turn. If the agent is streaming when a tick lands, the prompt is queued with `deliverAs: "followUp"` so it stays user-visible and does not interrupt the active turn. We intentionally do not use `pi.sendMessage` because that is a custom message, not a user turn.

## Persistence

- Jobs are stored in `<project>/.pi/cron/jobs.json` (schema version 1) and survive pi restarts; on startup, the store is reloaded and jobs resume ticking under the missed-tick policy.
- Writes are atomic (temp file + `rename`).
- There is no runs log (out of scope).

## Scope (intentional non-goals)

- No job names (ordinal identity only).
- No `enable` / `disable` / `run` subcommands.
- No swarm coupling, no preset prompts.
- Node stdlib + pi ExtensionAPI only; no dependencies.

## Module map

- `index.ts` — thin wiring: `/cron` command registration + scheduler lifecycle on `session_start` / `session_shutdown`.
- `src/scheduler.ts` — pure scheduler math (interval parsing, due-check, missed-tick policy) + the tick loop.
- `src/store.ts` — durable `.pi/cron/jobs.json` load/save with atomic writes.
- `src/command.ts` — `/cron` parser and handlers.

## Tests

```bash
node extensions/cron/cron.test.mjs
npx tsc --noEmit --allowImportingTsExtensions --module nodenext --moduleResolution nodenext --skipLibCheck --target es2022 --lib es2022 extensions/cron/index.ts
```
