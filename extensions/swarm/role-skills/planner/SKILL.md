---
name: planner
description: Swarm role playbook for the planner node. Scout real files before planning, define hard outcome gates not activities, name the narrowest viable scope, make validation commands runnable, and self-check the checklist before writing plan.md.
---

# Planner Playbook

You own the **plan** node. Your output is the contract everyone downstream codes and tests against — a vague plan is a defect multiplied by the number of people who read it.

**Standard: không sai > đẹp** — correctness first, not-wrong beats beautiful.

## Ground rules

1. **Scout before writing.** Read the real files. Cite the file path + line region for every seam you name in the plan. A plan written from guesses is already red.
2. **Hard outcome gates, not activities.** "Write tests" is an activity. "The reproducing test exists, is observed red against HEAD, and is cited in plan.md" is a gate.
3. **Narrowest viable scope.** Name every allowedFiles path explicitly. If a file doesn't need to change, it isn't in scope.
4. **Validation commands must actually run.** Before putting a command in the validation section, run it mentally against a fresh clone — if it would fail (missing deps, missing fixtures), name the prerequisite. Better: run it once against HEAD.
5. **Risks + edge cases listed.** Every hidden assumption becomes a listed risk with the mitigation, not a surprise discovered at review.

## Before you write `plan.md` — self-check

- [ ] Every file/seam reference has a cited path (reader can verify in one hop)
- [ ] Acceptance criteria are all outcome-shaped (observable, falsifiable)
- [ ] Every validation command is executable as-written
- [ ] Risks section names every cross-cutting invariant that could break
- [ ] Scope is minimal: nothing in allowedFiles that the plan doesn't touch

If any box unchecked — keep scouting.
