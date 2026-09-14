#!/usr/bin/env node
// Test suite for /swarm-mark:
// 1. Auto-appends datetime suffix to marker name: <name>-YYYYMMDD-HHmmss
// 2. Logs audit.checkpoint event into events.jsonl with gitHead, activeAgents, inFlightTasks
// 3. Persists marker in state.json st.markers
// 4. /swarm-mark list surfaces recent checkpoints

import { rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const scratch = join(tmpdir(), `swarm-mark-test-${process.pid}-${Date.now()}`);
rmSync(scratch, { recursive: true, force: true });
mkdirSync(join(scratch, ".pi/swarm"), { recursive: true });

process.env.PI_SWARM_AGENT_ID = "root";

const mod = await import(join(here, "..", "index.ts"));
const factory = mod.default;

const commands = {};
const notifications = [];
const pi = {
	registerTool: () => {},
	registerCommand: (name, def) => {
		commands[name] = def;
	},
	on: () => {},
	exec: async (cmd, args) => {
		if (cmd === "git" && args[0] === "rev-parse") return { code: 0, stdout: "abcdef1234567890\n", stderr: "" };
		if (cmd === "tmux") return { code: 0, stdout: "%1\n", stderr: "" };
		return { code: 1, stdout: "", stderr: "" };
	},
	sendMessage: () => {},
};
factory(pi);

let pass = 0,
	fail = 0;
const ok = (n, c, extra) => {
	if (c) {
		pass++;
		console.log("  ok  ", n);
	} else {
		fail++;
		console.error("  FAIL", n, extra ?? "");
	}
};

const fakeCtx = {
	cwd: scratch,
	ui: {
		notify: (msg, type) => {
			notifications.push({ msg, type });
		},
	},
};

// 1. Verify commands are registered
ok("swarm command is registered", Boolean(commands.swarm));
ok("swarm-mark command is registered", Boolean(commands["swarm-mark"]));

// 2. Run /swarm-mark bug-repro "testing worker settle"
notifications.length = 0;
await commands["swarm-mark"].handler("bug-repro testing worker settle", fakeCtx);

const notif1 = notifications[notifications.length - 1]?.msg || "";
console.log("Notification 1:", notif1);
ok("swarm-mark command responded with Checkpoint marked", notif1.includes("Checkpoint marked"));
ok("checkpoint name contains label and datetime suffix", /bug-repro-\d{8}-\d{6}/.test(notif1));

// 3. Verify state.json contains st.markers
const statePath = join(scratch, ".pi/swarm/swarm-state.json");
const st = JSON.parse(readFileSync(statePath, "utf8"));
const markerKeys = Object.keys(st.markers || {});
ok("st.markers has 1 entry", markerKeys.length === 1);
const markerId = markerKeys[0];
const markerRec = st.markers[markerId];
ok("marker label is bug-repro", markerRec?.label === "bug-repro");
ok("marker note is recorded", markerRec?.note === "testing worker settle");
ok("marker gitHead is captured", markerRec?.gitHead === "abcdef1234567890");

// 4. Verify events.jsonl contains audit.checkpoint trace
const eventsPath = join(scratch, ".pi/swarm/traces/events.jsonl");
const eventsLines = readFileSync(eventsPath, "utf8").trim().split("\n");
const parsedEvents = eventsLines.map((l) => JSON.parse(l));
const markEvent = parsedEvents.find((e) => e.event === "audit.checkpoint");
ok("audit.checkpoint event written to events.jsonl", Boolean(markEvent));
ok("audit.checkpoint payload has markerId", markEvent?.markerId === markerId);
ok("audit.checkpoint payload has gitHead", markEvent?.gitHead === "abcdef1234567890");

// 5. Test /swarm-mark without label -> defaults to mark-<datetime>
notifications.length = 0;
await commands["swarm-mark"].handler("", fakeCtx);
const notif2 = notifications[notifications.length - 1]?.msg || "";
ok("bare /swarm-mark creates mark-<datetime>", /mark-\d{8}-\d{6}/.test(notif2));

// 6. Test another /swarm-mark entry
notifications.length = 0;
await commands["swarm-mark"].handler("checkpoint-two note here", fakeCtx);
const notif3 = notifications[notifications.length - 1]?.msg || "";
ok("/swarm-mark creates second checkpoint", /checkpoint-two-\d{8}-\d{6}/.test(notif3));

// 7. Test /swarm-mark list
notifications.length = 0;
await commands["swarm-mark"].handler("list", fakeCtx);
const notifList = notifications[notifications.length - 1]?.msg || "";
console.log("List notification:\n", notifList);
ok("swarm-mark list shows checkpoints", notifList.includes("Checkpoints (3)"));

// 8. Test argument completions for swarm-mark
const completions = await commands["swarm-mark"].getArgumentCompletions("li");
ok(
	"completions suggest list",
	completions?.some((c) => c.value === "list"),
);

rmSync(scratch, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
