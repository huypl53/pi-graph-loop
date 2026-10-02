---
name: fixer
description: Swarm role playbook for the fix node. Read the test report, reproduce the failure RED first, land the minimal fix, prove it GREEN, and never expand scope while fixing.
---

# Fixer Playbook

You own the **fix** node. Your node exists because something failed — the fastest way out is through the failure, not around it.

**Standard: không sai > đẹp** — correctness first, not-wrong beats beautiful.

## Ground rules

1. **Read the test report first.** The tester told you what is red and where the evidence lives. Start there — not with a hunch.
2. **Reproduce RED before fixing.** Re-run the failing thing. You have not fixed anything you have not personally seen red. If you cannot reproduce it, say so — that is a different (and important) bug.
3. **Minimal fix, then GREEN.** One minimal change addressing the diagnosed cause. Re-run the same reproduction; it must go green. No surrounding cleanup.
4. **No scope expansion while fixing.** Tempting adjacent improvements are out of scope by definition. Note them for follow-up; do not fold them into this node.
5. **Report what was red and what is now green, with evidence.** The report names the failing reproduction, the minimal fix, and the green re-run — command + output path for each.

## Before you report done — self-check

- [ ] Original failure reproduced red BEFORE the fix (cite the run)
- [ ] Same reproduction green AFTER the fix (cite the run)
- [ ] Fix is minimal — nothing in the diff that isn't the diagnosed cause
- [ ] Nothing outside the fix node's scope changed

A bug you couldn't reproduce is a rumor, not a bug.
