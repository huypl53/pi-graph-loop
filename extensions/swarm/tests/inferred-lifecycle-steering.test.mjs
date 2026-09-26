// inferred-lifecycle-steering.test.mjs — verify inferred seenAt and processingAt without swarm_ack_message
import { rmSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const mod = await import(join(here, "..", "index.ts"));
const factory = mod.default;

let pass = 0,
	fail = 0;
const ok = (name, cond) => {
	if (cond) {
		pass++;
		console.log("  ok  ", name);
	} else {
		fail++;
		console.error("  FAIL:", name);
	}
};

const toolDefs = new Map();
const activeTools = new Set();
const handlers = {};

const pi = {
	registerTool: (def) => {
		toolDefs.set(def.name, def);
		activeTools.add(def.name);
	},
	registerCommand: () => {},
	on: (ev, fn) => {
		(handlers[ev] ??= []).push(fn);
	},
	getActiveTools: () => [...activeTools],
	getAllTools: () => [...toolDefs.values()].map((d) => ({ name: d.name })),
	setActiveTools: (names) => {
		activeTools.clear();
		for (const n of names) activeTools.add(n);
	},
	exec: async () => ({ code: 0, stdout: "", stderr: "" }),
	sendMessage: () => {},
};

factory(pi);

const scratch = mkdtempSync(join(tmpdir(), "swarm-inferred-lifecycle-"));
mkdirSync(join(scratch, ".pi/swarm"), { recursive: true });

writeFileSync(
	join(scratch, ".pi/swarm/swarm-state.json"),
	JSON.stringify(
		{
			version: 1,
			swarmId: "swarm-test",
			cwd: scratch,
			tmuxSession: "test",
			agents: {
				root: { id: "root", role: "root", roleKind: "root", status: "running", runtimeStatus: "idle", tmuxPane: "%0" },
				"worker-1": {
					id: "worker-1",
					role: "worker",
					roleKind: "worker",
					status: "running",
					runtimeStatus: "idle",
					tmuxPane: "%1",
					activeTaskIds: [],
				},
			},
			delivered: {},
			messages: {},
			rootPumpSessions: {},
		},
		null,
		2,
	),
);

const sendTool = toolDefs.get("swarm_send_message");

// Step 1: Root sends message to worker-1
process.env.PI_SWARM_AGENT_ID = "root";
const rootCtx = { cwd: scratch, mode: "tui", hasUI: false, isIdle: () => true };

const sendRes = await sendTool.execute(
	"c1",
	{
		to: "worker-1",
		body: "Please run tests",
		subject: "Task directive",
		requiresResponse: true,
	},
	undefined,
	undefined,
	rootCtx,
);

const msgId = sendRes?.details?.receipt?.messageId;
ok("message sent with id", Boolean(msgId));

// Step 2: Simulate message arriving at worker-1 pane and triggering input hook
process.env.PI_SWARM_AGENT_ID = "worker-1";
const workerCtx = { cwd: scratch, mode: "tui", hasUI: false, isIdle: () => true, abort: async () => {} };

const { buildSystemDelivery } = await import(join(here, "..", "src", "delivery.ts"));
const inputPayload = buildSystemDelivery(sendRes.details.message);

for (const fn of handlers.input || []) {
	await fn({ text: inputPayload, source: "interactive" }, workerCtx);
}

// Check state after input intercept: seenAt should be derived
let st = JSON.parse(readFileSync(join(scratch, ".pi/swarm/swarm-state.json"), "utf8"));
let rec = st.messages[msgId];
ok("message intercepted", rec?.status === "intercepted");
ok("seenAt stamped on steering intercept without ack", Boolean(rec?.seenAt));
ok("lifecycleStage is seen", rec?.lifecycleStage === "seen");

// Step 3: Simulate worker-1 starting a tool execution (e.g. bash or read)
for (const fn of handlers.tool_execution_start || []) {
	await fn({ tool: "bash" }, workerCtx);
}

// Check state after tool execution: processingAt should be derived
st = JSON.parse(readFileSync(join(scratch, ".pi/swarm/swarm-state.json"), "utf8"));
rec = st.messages[msgId];
ok("processingAt stamped on tool execution without ack", Boolean(rec?.processingAt));
ok("lifecycleStage is processing", rec?.lifecycleStage === "processing");
ok("lifecycleSource is tool_execution", rec?.lifecycleSource === "tool_execution");

// Step 4: Worker-1 replies with result message
const replyRes = await sendTool.execute(
	"c2",
	{
		to: "root",
		body: "Tests passed successfully",
		replyTo: msgId,
	},
	undefined,
	undefined,
	workerCtx,
);

st = JSON.parse(readFileSync(join(scratch, ".pi/swarm/swarm-state.json"), "utf8"));
rec = st.messages[msgId];
ok("respondedAt stamped on reply", Boolean(rec?.respondedAt));
ok("lifecycleStage is responded", rec?.lifecycleStage === "responded");
ok("response.status is verified", rec?.response?.status === "verified");

rmSync(scratch, { recursive: true, force: true });
console.log(`\nINFERRED-LIFECYCLE ${fail ? "FAIL" : "PASS"} (${pass} passed, ${fail} failed)`);
process.exit(fail ? 1 : 0);
