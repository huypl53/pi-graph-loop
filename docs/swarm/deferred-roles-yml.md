# Deferred feature: role flows as serialized YAML (roles.yml)

> Status: DEFERRED — recorded 2026-10-04 per user request ("lưu lại đã, chưa làm gì vội").
> Not scheduled in issues.yml. Do NOT pick this up without explicit user go-ahead.

## Idea

Today role flows are hardcoded workflow templates in code
(`extensions/swarm/src/taskgraph/graph.ts`: feature-dev = plan(planner) →
implement(implementer) → test(tester) → fix(implementer) → review(reviewer) →
commit(root); only `feature-dev` | `single` selectable via env/yml). The engine
already binds agents to roles at assign time (`assign.ts`: findReusableAgent by
roleKind, autoSpawn `<roleKind>-01`).

Deferred feature: make role flows USER-EDITABLE serialized config, same
philosophy as issues.yml:

1. **roles.yml** (e.g. `.pi/swarm/roles.yml`): a named library of role flows —
   each flow defines nodes (id, role, dependsOn, writeArtifacts, maxAttempts,
   terminal) and edges (from/to/when). Same validation-story as issues.yml
   (strict schema, validator script, corrupt-file reporting).
2. **Skill to set up roles**: a swarm-issues-style read-only skill (e.g.
   `swarm-roles`) for authoring/validating flows + a root command surface
   (`/swarm roles validate|list|show`), mirroring the issues command pattern.
   Mutation stays human-only.
3. **Reference docs**: `docs/swarm/roles.md` — the flow schema, the built-in
   feature-dev flow spelled out as YAML (so users copy-edit it), role→agent
   binding rules, and how `issue-sequencer.workflow` / `swarm_create_task
   workflow:` resolve custom flow names from roles.yml.
4. **Engine binds to it**: `synthesizeTaskGraph` reads roles.yml when
   `workflow:` names a custom flow (built-ins stay as code fallback); spawn/
   assign already keys off node.role so custom roles flow through the existing
   roleKind machinery unchanged.

## Why it matters (context from 2026-10-04 discussion)

- User was surprised role flows live only in code — nothing prints them into
  swarm.yml; `roles:` in swarm.yml is per-slot model whitelisting, a different
  concept that invites confusion.
- Root-assign bug class (same-agent-all-roles) exists because staffing is
  implicit; serialized flows make the expected agent-per-role shape visible and
  enforceable (see related deferred follow-ups: ROLE_SEPARATION fence at
  assign time, staffing hints in assignment bodies / issue-activation message).
- issues.yml proved the pattern: strict queue + validator + snapshot +
  human-only mutation works well for user-owned orchestration data.

## Open questions (when this gets picked up)

- Precedence: custom flow name in roles.yml vs built-in names (shadow or reject?)
- Flow versioning: pin a flow hash into task.json at create time so mid-task
  roles.yml edits don't mutate a live graph.
- Gate surface: custom flows may need gates (reviewApproved etc.) — reuse the
  feature-dev gate synthesis or allow explicit gate defs in YAML?
- Interaction with issue-sequencer: does `issue-sequencer.workflow` accept any
  roles.yml flow id, or keep the feature-dev|single enum?

## Related (also deferred / queued separately)

- ROLE_SEPARATION fence + staffing hints (not yet filed as issue)
- stopped-agent-records-gc (filed: .pi/swarm/issues.yml)
- Guard hardening + demo-lane Leg B tighten (issue 2 review follow-ups,
  see task-202610040930 artifacts/review.md)
