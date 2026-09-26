// delivery-receipt.test.mjs — verify synchronous delivery receipt from swarm_send_message
import { rmSync, mkdtempSync, mkdirSync } from "node:fs";
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
const pi = {
	registerTool: (def) => {
		toolDefs.set(def.name, def);
		activeTools.add(def.name);
	},
	registerCommand: () => {},
	on: () => {},
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

const scratch = mkdtempSync(join(tmpdir(), "swarm-delivery-receipt-"));
mkdirSync(join(scratch, ".pi/swarm"), { recursive: true });
import { writeFileSync } from "node:fs";
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

process.env.PI_SWARM_AGENT_ID = "root";
const ctx = { cwd: scratch, mode: "tui", hasUI: false, isIdle: () => true };

const sendTool = toolDefs.get("swarm_send_message");
ok("swarm_send_message registered", Boolean(sendTool));

const result = await sendTool.execute(
	"call-1",
	{
		to: "worker-1",
		body: "Hello worker",
		subject: "Test subject",
	},
	undefined,
	undefined,
	ctx,
);

console.log("Tool result text:", result?.content?.[0]?.text);
console.log("Tool result details:", result?.details);

const receipt = result?.details?.receipt;
ok("receipt object present in details", Boolean(receipt));
ok("receipt.messageId present", typeof receipt?.messageId === "string" && receipt.messageId.startsWith("msg-"));
ok(
	"receipt.deliveryStatus is queued_in_mailbox or delivered_to_pane",
	["queued_in_mailbox", "delivered_to_pane"].includes(receipt?.deliveryStatus),
);
ok(
	"receipt.mailboxPath points to worker-1.jsonl",
	typeof receipt?.mailboxPath === "string" && receipt.mailboxPath.endsWith("worker-1.jsonl"),
);
ok("text content includes Delivery status", result?.content?.[0]?.text?.includes("Delivery status:"));

rmSync(scratch, { recursive: true, force: true });
console.log(`\nDELIVERY-RECEIPT ${fail ? "FAIL" : "PASS"} (${pass} passed, ${fail} failed)`);
process.exit(fail ? 1 : 0);
