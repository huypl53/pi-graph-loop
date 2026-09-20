// Regression test: ensure prompt/keys starting with dash ('-') do not fail in tmux send-keys.
// Real tmux uses getopt: any argument starting with '-' before '--' is parsed as an option flag.
// Without '--', prompts starting with '-' trigger "command send-keys: invalid flag - " or similar.
import { rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { sendToPane } from "../src/tmux.ts";
import { sendKeys, spawnAgent } from "../src/agents.ts";
import { ensureDirs, paths } from "../src/state.ts";

const here = dirname(fileURLToPath(import.meta.url));
const scratch = join(tmpdir(), `swarm-dash-prompt-${process.pid}-${Date.now()}`);
rmSync(scratch, { recursive: true, force: true });
mkdirSync(join(scratch, ".pi", "swarm"), { recursive: true });

let pass = 0;
let fail = 0;
const ok = (n, c) => {
	if (c) {
		pass++;
		console.log("  ok  ", n);
	} else {
		fail++;
		console.error("  FAIL", n);
	}
};

// Mock pi that enforces real tmux argument parsing rules
function createMockPi() {
	const calls = [];
	const pi = {
		calls,
		exec: async (cmd, args) => {
			if (cmd !== "tmux") return { code: 1, stdout: "", stderr: "not tmux" };
			calls.push(args);
			const sub = args[0];
			if (sub === "send-keys") {
				// Simulate tmux send-keys argument parsing
				let endOfOptions = false;
				for (let i = 1; i < args.length; i++) {
					const arg = args[i];
					if (!endOfOptions) {
						if (arg === "--") {
							endOfOptions = true;
							continue;
						}
						if (arg === "-t") {
							i++; // skip target argument
							continue;
						}
						if (arg === "-l" || arg === "-R" || arg === "-M" || arg === "-X") {
							continue;
						}
						if (arg.startsWith("-")) {
							return {
								code: 1,
								stdout: "",
								stderr: `command send-keys: invalid flag ${arg.slice(0, 2)}`,
							};
						}
						// First non-option argument in tmux ends option parsing if not -l
						// but with -l, tmux getopt still parses options unless '--' was supplied.
					}
				}
				return { code: 0, stdout: "", stderr: "" };
			}
			if (sub === "has-session") return { code: 0, stdout: "", stderr: "" };
			if (sub === "new-window" || sub === "new-session") return { code: 0, stdout: "", stderr: "" };
			if (sub === "display-message") return { code: 0, stdout: "%99\n", stderr: "" };
			if (sub === "capture-pane") return { code: 0, stdout: "ready\n", stderr: "" };
			return { code: 0, stdout: "", stderr: "" };
		},
	};
	return pi;
}

console.log("\n[1] sendToPane with prompt starting with dash '-'");
{
	const mockPi = createMockPi();
	let err = null;
	try {
		await sendToPane(mockPi, "test:w1.0", "- Task bullet starting with dash");
	} catch (e) {
		err = e;
	}
	ok("sendToPane does not throw on prompt starting with '-'", !err);
	const hasDoubleDash = mockPi.calls.some((c) => c[0] === "send-keys" && c.includes("--"));
	ok("send-keys args include '--' before payload", hasDoubleDash);
}

console.log("\n[2] sendToPane with prompt starting with double dash '--'");
{
	const mockPi = createMockPi();
	let err = null;
	try {
		await sendToPane(mockPi, "test:w1.0", "--flag-style prompt text");
	} catch (e) {
		err = e;
	}
	ok("sendToPane does not throw on prompt starting with '--'", !err);
}

console.log("\n[3] sendToPane with chunked text where chunk starts with '-'");
{
	const mockPi = createMockPi();
	let err = null;
	// Create payload > 2000 chars where chunk 2 starts with '-'
	const chunk1 = "x".repeat(2000);
	const chunk2 = "- second chunk starts with dash";
	try {
		await sendToPane(mockPi, "test:w1.0", chunk1 + chunk2);
	} catch (e) {
		err = e;
	}
	ok("sendToPane chunked send does not throw when chunk starts with '-'", !err);
}

console.log("\n[4] sendKeys literal mode with keys starting with '-'");
{
	const mockPi = createMockPi();
	const p = paths(scratch);
	let err = null;
	try {
		await sendKeys(mockPi, p, "test:w1.0", "- literal text starting with dash", { literal: true });
	} catch (e) {
		err = e;
	}
	ok("sendKeys literal mode does not throw on keys starting with '-'", !err);
}

console.log("\n[5] spawnAgent with initialPrompt starting with dash");
{
	process.env.MOCKPROVIDER_API_KEY = "test-key";
	const mockPi = createMockPi();
	const p = paths(scratch);
	await ensureDirs(p);
	const state = {
		version: 1,
		swarmId: "test-dash-swarm",
		tmuxSession: "test",
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		agents: {},
		messages: {},
		delivered: {},
	};
	let err = null;
	try {
		await spawnAgent(mockPi, scratch, p, state, {
			id: "dash-worker",
			role: "Worker",
			model: "mockmodel",
			provider: "mockprovider",
			initialPrompt: "- Assigned task: perform analysis on module X",
		});
	} catch (e) {
		err = e;
	}
	ok("spawnAgent succeeds when initialPrompt starts with '-'", !err);
	const hasDoubleDash = mockPi.calls.some((c) => c[0] === "send-keys" && c.includes("--"));
	ok("spawnAgent send-keys call includes '--'", hasDoubleDash);
}

// Live tmux check if tmux is available
console.log("\n[6] Live tmux test against real tmux session");
{
	const sessionName = `swarm-repro-dash-${process.pid}-${Date.now()}`;
	const newSess = spawnSync("tmux", ["new-session", "-d", "-s", sessionName]);
	if (newSess.status === 0) {
		try {
			const realPi = {
				exec: async (cmd, args) => {
					const r = spawnSync(cmd, args, { encoding: "utf8" });
					return { code: r.status ?? 1, stdout: r.stdout || "", stderr: r.stderr || "" };
				},
			};
			let err = null;
			try {
				await sendToPane(realPi, sessionName, "- real tmux dash prompt test");
			} catch (e) {
				err = e;
			}
			ok("sendToPane succeeds on REAL tmux with prompt starting with '-'", !err);
		} finally {
			spawnSync("tmux", ["kill-session", "-t", sessionName]);
		}
	} else {
		console.log("  skip live tmux (tmux not available or cannot create session)");
	}
}

console.log(`\nResults: ${pass} passed, ${fail} failed.`);
if (fail > 0) process.exit(1);
