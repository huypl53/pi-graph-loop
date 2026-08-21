// Issue D: deliver() trusts tmux send-keys — a pane that is alive but no longer running pi
// (crashed/exit → shell prompt) still gets marked delivered. Pure predicate test for isPiLikeCommand;
// the end-to-end tmux repro lives in scripts + artifacts (see repro/findings.md).
//
// Run: node extensions/swarm/pane-pi-like.test.mjs
import { isPiLikeCommand } from "./index.ts";

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.error("  FAIL:", name); } };

// Shell / pager / editor commands mean "no pi running in this pane".
// Shell / pager / editor / arbitrary foreground commands mean "no pi running in this pane".
for (const c of ["zsh", "bash", "sh", "fish", "ksh", "-zsh", "tmux", "screen", "ssh", "cat", "less", "more", "tail", "head", "vi", "vim", "nvim", "nano", "emacs", "sleep", "python", "SomeBinary"]) {
	ok(`non-pi command "${c}" is NOT pi-like`, isPiLikeCommand(c) === false);
}
// pi always runs as a node process; empty (unresolved target) fails open.
for (const c of ["node", ""]) {
	ok(`pi-plausible ${JSON.stringify(c || "(empty)")} is pi-like (fail-open)`, isPiLikeCommand(c) === true);
}

console.log(`\n${fail === 0 ? "PASS" : "FAIL"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
