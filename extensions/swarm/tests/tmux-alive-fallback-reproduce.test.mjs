#!/usr/bin/env node
/**
 * REPRODUCE TEST:
 * 1. isTmuxRunning with non-existent window in existing session should return false (not fall back to another window).
 * 2. poolDiag in evaluateIdleGoalNudgeLocked should not diagnose stopped historical agents as alive/dead actionable candidates.
 */
import { isTmuxRunning } from "../src/tmux.ts";

let pass = 0;
let fail = 0;
function ok(name, cond, msg) {
	if (cond) {
		pass++;
		console.log(`  ok   ${name}`);
	} else {
		fail++;
		console.error(`  FAIL ${name} - ${msg || ""}`);
	}
}

console.log("=== Reproduce 1: isTmuxRunning target accuracy ===");
// Mock pi.exec that simulates tmux display-message vs list-panes
// In tmux, if target is "my-session:non-existent-win.0":
// display-message -p -t "my-session:non-existent-win.0" "#{pane_id}" resolves to active pane of my-session ("%543")
// list-panes -t "my-session:non-existent-win.0" exits with code 1 ("can't find window")
const mockPi = {
	exec: async (cmd, args) => {
		if (args[0] === "display-message") {
			const target = args[3];
			if (target.includes("non-existent-win")) {
				// Tmux fallback bug behavior:
				return { code: 0, stdout: "%543\n", stderr: "" };
			}
		}
		if (args[0] === "list-panes") {
			const target = args[2];
			if (target.includes("non-existent-win")) {
				return { code: 1, stdout: "", stderr: "can't find window: non-existent-win" };
			}
			return { code: 0, stdout: "0: [236x38] %543\n", stderr: "" };
		}
		return { code: 1, stdout: "", stderr: "unknown command" };
	},
};

const alive = await isTmuxRunning(mockPi, "my-session:non-existent-win.0");
// If bug exists, alive === true (WRONG)
// Expected after fix: alive === false
ok("isTmuxRunning returns false for non-existent window in active session", alive === false, `expected false, got ${alive}`);

console.log(`\nResults: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
