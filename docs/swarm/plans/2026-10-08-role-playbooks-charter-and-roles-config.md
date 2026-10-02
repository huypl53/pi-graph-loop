# Role Playbooks, Project Charter & `roles:` Config Implementation Plan

> **Goal:** Give every swarm role (planner / implementer / fixer / tester / reviewer) a real, always-loaded identity — a pi skill injected at spawn via `--skill`, a correctness-first charter, and a user-visible `roles:` surface in swarm.yml — so output quality stops depending on the model's default disposition ("không sai > đẹp", evidence-mandatory, model-invariant results).

---

## 1. Problem Statement

The feature-dev graph (`buildDefaultGraph`, `src/taskgraph/graph.ts`) routes nodes to roles `planner → implementer → test → (fix) → review → commit`, but the agents filling those roles have **no role-specific operating standard**:

1. **Identity is role-agnostic.** `buildIdentityMarkdown()` (`src/identity.ts`) emits the same Operating Protocol / Reply Protocol / Lifecycle / Peer Discovery / Review Expectations sections for every roleKind. Nothing tells the tester to re-run commands instead of trusting `implementation-report.md`; nothing tells the planner that validation commands must actually run.
2. **Assignment bodies are pure logistics.** `buildAssignmentBody()` (`src/taskgraph/formatting.ts`) carries scope/artifacts/attempt-token — no quality bar for the node.
3. **No swarm-wide working philosophy layer.** Project `AGENTS.md` already reaches every worker automatically (pi loads it at startup from cwd — verified), but a swarm used on a *different* codebase with a thin AGENTS.md ships no correctness-first defaults at all.
4. **Consequence:** plan depth, review rigor, and test honesty vary with the model's mood. Swapping models changes results because there is no shared checklist to anchor against.

### 1.1 Prior art already in-repo (and its flaw)

`extensions/swarm/qualification-skills/qualification-gate/SKILL.md` is referenced by `buildIdentityMarkdown()` for root/reviewer/auditor — but its directory is **not** a pi skill location (pi loads only `~/.pi/agent/skills/`, `~/.agents/skills/`, `.pi/skills/`, `.agents/skills/`, package `pi.skills`, settings `skills[]`, CLI `--skill`). It works only when a model virtuously follows the path in a text hint. This plan must not repeat that: playbooks must be **real pi skills delivered via `--skill` at spawn**, present in the system prompt from turn 0.

### 1.2 Verified runtime facts this design leans on

- `--skill <path>` is **additive** to normal skill discovery (`docs/skills.md`: "CLI: `--skill <path>` (repeatable, additive even with `--no-skills`)"). Workers keep user/project skills; playbooks are added, never replacing.
- Worker spawn command is built in `spawnAgent()` (`src/agents.ts` ~L258): `cmd = envPrefix + pi --model M --provider P + childPiArgs()`; `childPiArgs()` (`src/session.ts` L52) returns `--approve -e <abs-ext-path>` unless `PI_SWARM_CHILD_ARGS` overrides verbatim. The spawn seam (tmux driver `spawnAgent`, herdr driver G2) takes the composed command string — one insertion point, drivers untouched.
- Project `AGENTS.md` / `.pi/APPEND_SYSTEM.md` already land in every worker's context automatically (pi context-file loading, cwd-based). Swarm must NOT write to those files (user-owned); charter is a separate, additive layer.
- Role routing already exists: `inferRoleKind(id, role)` yields `root|planner|reviewer|tester|implementer|worker|observer` and stamps `agent.roleKind` on every record.

---

## 2. Design

### 2.1 New artifacts: `extensions/swarm/role-skills/`

Five real pi skills (frontmatter name + description, Agent Skills standard; validated by pi at load):

| Skill | roleKind / node | Core standard (all follow "không sai > đẹp") |
|---|---|---|
| `planner` | planner | Scout before writing (read real files, not guesses); hard outcome gates not activities; narrowest viable allowedFiles; validation commands must be commands that can actually run; risks + edge cases listed; self-check checklist before writing `plan.md` |
| `implementer` | implementer (non-fix nodes) | Minimal diff, no beautification beyond plan scope; follow plan.md gates; run validation commands before claiming done; honest reporting — never claim an unrun command |
| `fixer` | `fix` node | Read test-report → reproduce the failure RED first → minimal fix → GREEN again; no scope expansion while fixing; report what was red and what is now green with evidence |
| `tester` | tester | Zero-trust: re-run everything yourself, do not trust `implementation-report.md`; a bug-fix is only validated by its red reproduction; negative cases; every conclusion carries command + evidence path; missing evidence = fail, not pass |
| `reviewer` | reviewer | Diff-vs-plan conformance; scope creep; silent error swallowing (`catch {}` patterns); evidence spot-check (did the tester's commands actually run?); verdict APPROVE/REJECT against an explicit checklist, never vibes |

Fixer selection is **playbook-layer only**: the graph keeps `role: "implementer"` on the `fix` node (model-pool routing unchanged); the spawn/assign site selects the fixer playbook when the node id is `fix` (or role string starts with `fix`).

Charter default (embedded constant, `ROLE_CHARTER_DEFAULT` in constants.ts):

> Correctness first: not-wrong beats beautiful. Minimal diff inside your node's scope. Every claim you make must carry evidence (command you ran + path you read). Missing evidence counts as failure. Ask (blocked) instead of guessing outside scope.

Per-project charter override: `roles.charter: <path>` in swarm.yml → file content replaces the default (embedded remains fallback). Path resolved relative to project root; missing file = preflight validation error (not silent fallback).

### 2.2 Config surface: `roles:` in swarm.yml (`src/config.ts`)

```yaml
roles:
  charter: ./TEAM-RULES.md          # optional; default = embedded correctness-first charter
  planner:  default                 # default = bundled role-skills playbook
  implementer: default
  fixer: default
  tester: default
  reviewer: default
  # any role: ./docs/my-heavier-planner.md   # absolute or project-relative path to a SKILL.md
```

- Precedence: project yml `roles:` > global yml `roles:` > bundled defaults (per-key merge, matching existing config layering).
- Validation: custom paths must exist and contain a `SKILL.md` (or be a root `.md` in `~/.pi/agent/skills`-style — accept both a directory containing SKILL.md and a direct .md path). Invalid → preflight error listing the key, file, and expected shape. `"default"` string selects the bundled skill; `null`/omitted = default.
- No changes to modelPool `roles:` allow-list semantics (that key lives under modelPool entries — different schema path, no collision: one is `modelPool[].roles: string[]`, this is top-level `roles: {charter, planner, ...}`).

### 2.3 Spawn-time injection (`src/session.ts` + `src/agents.ts`)

- `childPiArgs()` gains an optional skill list parameter (or a new `childPiArgsWithSkills(skills: string[])`): appends `--skill <abs-path>` per resolved playbook, **after** the existing `-e` args, **before** any `PI_SWARM_CHILD_ARGS` passthrough logic (explicit `PI_SWARM_CHILD_ARGS` still wins verbatim — existing test `child-pi-args-cwd.test.mjs` pins this).
- `spawnAgent()` resolves the playbook for the agent: node-aware at the assign/spawn site (fix node → fixer), otherwise by `roleKind`. Bundled skills resolve to absolute paths from the extension's own directory (cwd-independent, same discipline as the `-e` path).
- Skill injection failure mode: if a **custom** configured path fails to exist at spawn time (raced deletion after validation), spawn proceeds WITHOUT the skill flag and `logSwarmError(...)` records it (never block a spawn on a missing optional playbook; the preflight already errored once — this is the defense-in-depth net). Bundled paths are package-shipped and cannot miss.
- `registerAdoptedAgent` (pane adoption path): no command re-composition possible — the identity reference section (2.4) is the delivery vehicle there.

### 2.4 Identity & assignment surfacing (`src/identity.ts` + `src/taskgraph/formatting.ts`)

- `buildIdentityMarkdown()`: new `## Role Playbook` section — absolute playbook path for the agent's roleKind (+ charter text inline or path if custom). Regeneration already versions + hashes content (`rebuildEffectiveIdentity`), so updates propagate with the existing mechanism.
- `buildAssignmentBody()`: one added line — `Role playbook: <abs-path> — read it before starting this node.` (belt-and-braces for adopted panes and `PI_SWARM_CHILD_ARGS` overrides; also guarantees mid-task consistency since assignment messages re-fire on reassign).

### 2.5 User surface: `/swarm roles` (`src/commands/`)

New command (registered alongside pool/agents commands):
- Lists each role → playbook path (bundled/custom marker), source layer (project yml / global yml / default), charter source (embedded / custom path), and whether the file currently exists.
- Mirrors the "user can know about the roles" requirement without new tool surface (observability stays commands-only per repo norms).

### 2.6 What this plan deliberately does NOT do

- No new graph nodes/edges; `fix` stays role `implementer` in task.json.
- No writes to `AGENTS.md` / `.pi/APPEND_SYSTEM.md` (user-owned).
- No `--no-skills` strict mode in v1 (playbooks are additive; strict mode can be a follow-up option if noise proves real).
- No root playbook (root keeps its existing coordination identity).
- qualification-skills/ stays as-is (fixing its mount is a separate concern; new code does not add references to it).

---

## 3. Pi Runtime Contract & Boundary Analysis

This plan crosses Pi runtime boundaries at spawn/CLI surface only:

| Layer | Boundary | This plan |
|---|---|---|
| L1 durable mailbox | mailbox JSONL | unchanged |
| L2 Pi queue acceptance | `pi.sendMessage` counts | unchanged |
| L3 visible surface | TUI | `/swarm roles` output only (command surface, not message surface) |
| L4 LLM consumption | worker system prompt | **changed via CLI flag composition** (`--skill`) — the flag is documented pi CLI surface (additive), not a runtime-semantics modification |

Spawn command composition is not one of the four contract's sensitive mutation sites (no `pi.sendMessage`/`ctx.abort`/`ctx.reload` semantics touched). No §10 rows are falsified; one clarifying row will be added documenting that spawned workers include role playbooks via `--skill` (documenting the new invariant, per reviewer expectations). No new swarm code path calls `pi.sendMessage` differently — R10-1 boundary-count assertion not required; the boundary this plan crosses (spawn argv) is covered by direct argv assertions in tests instead.

---

## 4. Implementation Steps & Verification

### Phase 0 — Reproduction first (mandate)

- [ ] **0.1** Author red test `extensions/swarm/tests/role-playbook-spawn.test.mjs`:
  - Assert `childPiArgs`/spawn command for each roleKind contains `--skill <role-skills/planner>` etc. — **expected red**: no `--skill` today.
  - Assert fix-node resolution picks `fixer` not `implementer` — red today.
  - Assert `buildAssignmentBody` mentions the playbook path — red today.
- [ ] **0.2** Author red test `extensions/swarm/tests/roles-config.test.mjs`:
  - swarm.yml with `roles.charter: ./does-not-exist.md` → preflight error — red today (key ignored silently).
  - `roles.tester: ./custom/skill-dir` with SKILL.md present → resolves; missing SKILL.md → error — red today.

### Phase 1 — Playbooks + charter artifacts

- [ ] **1.1** Author the five `extensions/swarm/role-skills/*/SKILL.md` (frontmatter valid: lowercase-hyphen names ≤64 chars, descriptions ≤1024 chars, specific trigger wording). Content per §2.1 table; Vietnamese philosophy rendered in English operational checklists (workers' models vary; English checklists are the stable contract).
- [ ] **1.2** Add `ROLE_CHARTER_DEFAULT` constant (+ export) with the §2.1 charter text.

### Phase 2 — Config + resolution

- [ ] **2.1** `config.ts`: parse + validate top-level `roles:` (per-key merge project>global>default; path existence + SKILL.md shape; `"default"` sentinel). Extend preflight error surface with role-config errors.
- [ ] **2.2** New `resolveRolePlaybook(roleKind, nodeId?)` helper (co-located with config or `utils.ts`): returns absolute skill path (custom or bundled) or null for root/observer/worker kinds without playbooks. Bundled path anchored to extension dir.
- [ ] **2.3** Run Phase 0 tests — config half should go green.

### Phase 3 — Spawn injection + identity/assignment surfacing

- [ ] **3.1** `session.ts`: extend `childPiArgs` (default behavior unchanged when no skills passed — existing tests must stay green verbatim).
- [ ] **3.2** `agents.ts` `spawnAgent()`: resolve playbook, pass to args; race-miss → `logSwarmError` + proceed (per §2.3).
- [ ] **3.3** `identity.ts` `buildIdentityMarkdown()`: add `## Role Playbook` section (playbook path + charter; charter inline when embedded, path when custom).
- [ ] **3.4** `formatting.ts` `buildAssignmentBody()`: add playbook reference line.
- [ ] **3.5** Run Phase 0 tests — all green.

### Phase 4 — Command surface + docs

- [ ] **4.1** `/swarm roles` command (read-only; mirrors §2.5).
- [ ] **4.2** Update `docs/swarm/tools.md` configuration section + `POOL_SCAFFOLD_YML_PLACEHOLDER` commented `roles:` block (users discover the surface where they already configure the pool).
- [ ] **4.3** Add §10 contract row (worker spawn includes role playbook via `--skill`).
- [ ] **4.4** CHANGELOG.md entry (`feat`).

### Phase 5 — Mock-LLM fixture + tmux validation (mandate)

- [ ] **5.1** Author `extensions/mock-llm/fixtures/role-playbook-e2e.jsonl`: scripted root turn creates a task, spawns/assigns a tester node; scenario asserts (via scripted tool sequence) the assignment body + spawned pane command carry the playbook. Deterministic, lowercase pi-builtin tool names, per fixture conventions.
- [ ] **5.2** Validation lane in isolated tmux: `pi --provider mock-llm --model role-playbook-e2e -e ./extensions/mock-llm -e ./extensions/swarm`; cite transcript path under `.pi/mock-llm/transcripts/` + before/after pane captures in the final report.
- [ ] **5.3** Full suite: `npm run test:swarm` + `npm run test:mockllm`; `grep -rnE "catch\s*\{\s\}" extensions/swarm/src` zero (excluding errorlog.ts internals); every new `.catch` routes to `logSwarmError`/`expected()`.

---

## 5. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| `--skill` additive load pulls playbook into *every* turn's system prompt skill list | That is the point (always-on identity); descriptions are one line each — context cost ~5 lines per worker |
| Custom playbook path deleted between validation and spawn | logSwarmError + spawn proceeds (§2.3); bundled defaults cannot miss |
| Model ignores the skill (progressive disclosure gap) | Identity + assignment-body references are belt-and-braces delivery paths; three independent surfaces |
| Blast radius on existing spawn tests | `childPiArgs()` default signature/behavior unchanged; only callers that pass skills see new flags; existing `child-pi-args-cwd.test.mjs` assertions stay valid verbatim |
| Qualification-skills precedent (unmounted skill) repeated | Playbooks are mounted through documented CLI surface (`--skill`), asserted by argv tests + fixture lane |
