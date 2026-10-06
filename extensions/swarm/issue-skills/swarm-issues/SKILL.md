---
name: swarm-issues
description: "Prepare, validate, and read issue-run context for the swarm issue sequencer. Use when an issues.yml queue, an issue run, or an active issue is in play: root prepares/validates a strictly sequential queue; root or worker reads the immutable active-issue snapshot. Read-only: all mutation authority is the human-only /swarm issues commands."
---

# swarm-issues

You are working in a swarm that runs a sequential issue auto-run. This skill is **read-only**: it never starts, pauses, resumes, abandons, or stops a run, and it never mutates `issues.yml` or swarm state. All mutation authority belongs to the human via root-only `/swarm issues` commands. There are no issue-management Pi tools by design.

## Mode 1 — root prepare/review (before a run starts)

1. Scout the local project and its docs for candidate work.
2. Decompose into **strictly sequential** entries — one issue at a time, no parallelism — each with ONLY the four allowed keys:
   - `id` (kebab-case, snapshot-path safe)
   - `title`
   - `content` (what "done" means, end to end)
   - `docs` (list of repo-relative context doc paths; may be empty)

   Exact shape (the file MUST be a single root mapping named `issues` — a bare YAML list is rejected with `root_not_mapping`):

   ```yaml
   issues:
     - id: fix-tokenizer-unbalanced-quote
       title: "Tokenizer: error on unbalanced quotes instead of silent mis-parse"
       content: >
         Problem: src/tokenizer.ts:25-58 silently swallows the rest of
         the input on an unbalanced double quote. Done means: (1) tokenizer
         throws a clear error naming the unterminated quote; (2) unit test
         covers `"abc` input; (3) `node test/tokenizer.test.mjs` — exit 0.
       docs:
         - README.md
   ```
3. Write them to `.pi/swarm/issues.yml` (the swarm root — where `swarm-state.json` lives; NOT the project root, NOT `issues.yml`). Only when the human asked you to draft one.
4. Execute the validator and iterate until clean (`<skill-dir>` = the directory containing this SKILL.md — the skill is dispatched from pi's resource dir; repo checkout paths are irrelevant):
   ```bash
   node <skill-dir>/scripts/validate-issues.mjs --source .pi/swarm/issues.yml
   ```
   The validator defaults to `issues.yml` in the CWD (kept for raw CLI use) — always pass `--source` explicitly when validating the real queue.
5. Present the validated queue to the human for review/approval. **Stop.** Starting the run is a human decision (`/swarm issues start`).

## Mode 2 — root/worker active context (during a run)

1. Read the immutable activation snapshot for the current issue:
   ```bash
   node <skill-dir>/scripts/show-active-issue.mjs
   ```
   The snapshot was captured at activation and never mutates mid-run. Default output is compact; `--full` shows the bounded snapshot; `--json` is machine-readable.
2. Do the linked task work with the ordinary swarm task tools — the skill adds no task authority.
3. Never manage the run: no start/pause/resume/abandon/stop (workers cannot; root does it only as explicit human disposition).

## Hard rules

- The scripts are **read-only**: they write nothing.
- There are exactly two scripts; neither renders run status (use `/swarm issues status`).
- Hint bodies carry only issue id/title + this skill's name — never fetch or inject a full snapshot into a message.
- **Automatic loop:** once an issue run is started, advancing through the validated queue is automatic; the controller re-reads `issues.yml` at advance points and appends new, eligible entries to the queue tail. Appended entries use normal snapshot/task/goal/staffing and hint behavior. Do not manually restart merely because an issue was appended.
- **Cross-run auto-continue is opt-in:** `.pi/swarm.yml` `issues.autoContinue: true` starts a follow-on run after an all-successful completed run when eligible source entries remain; it defaults off. It will not continue after failed/blocked/cancelled issue outcomes and pauses at its consecutive-start cap (default 3). `/swarm issues stop` is the kill-switch until an explicit `/swarm issues start` clears it.
- **Restart dedup**: `/swarm issues start` skips issues whose content-hash matches a prior completed run; the status notice names the prior run. Editing an issue's `content` or `title` re-opens it (content-hash changes). Editing only `docs` does NOT re-open (sourceHash covers `id`/`title`/`content` only). Use `--force-all` to deliberately re-run everything.
