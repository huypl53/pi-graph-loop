// depath-tool-outputs.test.mjs — RED→GREEN reproduction for task depath-swarm-tool-outputs.
//
// Incident p9-dossier-runtime-debug2: a worker read a raw .pi/swarm path from a model-visible
// tool output and started polling the file directly. This test asserts that NO swarm tool
// output (text content, tool descriptions, param descriptions) leaks a raw .pi/swarm path or
// path-shaped hint, while programmatic `details` RETAIN the paths (harness escape hatch —
// negative controls).
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const mod = await import(join(here, "..", "index.ts"));
const factory = mod.default;

let pass = 0,
	fail = 0;
const ok = (name, cond, info) => {
	if (cond) {
		pass++;
		console.log("  ok  ", name);
	} else {
		fail++;
		console.error("  FAIL:", name, info !== undefined ? JSON.stringify(info).slice(0, 400) : "");
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

const scratch = mkdtempSync(join(tmpdir(), "swarm-depath-"));
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
				"worker-1": { id: "worker-1", role: "worker", roleKind: "worker", status: "running", runtimeStatus: "idle", tmuxPane: "%1" },
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
delete process.env.PI_SWARM_IS_ROOT;
const ctx = { cwd: scratch, mode: "tui", hasUI: false, isIdle: () => true };

const textOf = (r) => r?.content?.[0]?.text ?? "";
const run = (name, params) => toolDefs.get(name).execute("call-x", params, undefined, undefined, ctx);

// ---------- descriptions (system-prompt-advertised, model-visible on every session) ----------
const PATH_PATTERNS = [/\.pi\/swarm/, /task\.json/, /events\.jsonl/, /swarm-state\.json/, /swarm\.ya?ml/];
const leakIn = (s) => (s ? PATH_PATTERNS.filter((re) => re.test(s)).map((re) => re.source) : []);

for (const [tool, badFragments] of [
	["swarm_agent_status", ["swarm-state.json", "read .pi/swarm"]],
	["swarm_list_agents", ["mailbox paths"]],
	["swarm_send_message", ["mailbox JSONL"]],
	["swarm_check_mailbox", ["mailbox JSONL"]],
	["swarm_reconcile", ["task.json"]],
	["swarm_task_status", ["task.json"]],
	["swarm_assign_task", ["task.json"]],
	["swarm_update_task", ["task.json"]],
	["swarm_create_task", [".pi/swarm/tasks", "task.md", "events.jsonl"]],
	["swarm_spawn_agent", [".pi/swarm.yaml"]],
]) {
	const def = toolDefs.get(tool);
	ok(`${tool} registered`, Boolean(def));
	if (!def) continue;
	ok(`${tool} description has no path leak`, leakIn(def.description).length === 0, def.description?.slice(0, 200));
	for (const frag of badFragments) {
		ok(`${tool} description drops "${frag}"`, !def.description?.includes(frag));
	}
}

// Finding J param descriptions (model/provider) — no .pi/swarm.yaml
const spawnDef = toolDefs.get("swarm_spawn_agent");
const spawnParams = spawnDef?.parameters?.properties ?? {};
for (const key of ["model", "provider"]) {
	const d = spawnParams?.[key]?.description ?? "";
	ok(`swarm_spawn_agent ${key} param drops .pi/swarm.yaml`, !d.includes(".pi/swarm.yaml"), d);
}

// ---------- Site 1 + Site 8: send receipt text ----------
const sendRes = await run("swarm_send_message", { to: "worker-1", body: "hi", subject: "s1" });
const sendText = textOf(sendRes);
ok("Site 1: send receipt has no Mailbox: <path>", !/Mailbox: \S*\.jsonl/.test(sendText), sendText);
ok("Site 1: send receipt text has no .pi/swarm path", !sendText.includes(".pi/swarm"), sendText);
// negative control: details.receipt.mailboxPath STAYS
ok("Site 1 NC: details.receipt.mailboxPath retained", typeof sendRes?.details?.receipt?.mailboxPath === "string" && sendRes.details.receipt.mailboxPath.endsWith("worker-1.jsonl"));

const sendRootRes = await run("swarm_send_message", { to: "root", body: "hi root", subject: "s8" });
const rootText = textOf(sendRootRes);
ok("Site 8: root mailbox-only note drops 'durable in mailbox'", !rootText.includes("durable in mailbox"), rootText);
ok("Site 8: root note states the behavioral contract", rootText.includes("swarm_check_mailbox"), rootText);

// ---------- Site 2: fullBody truncation hint ----------
const bigBody = "x".repeat(25000);
await run("swarm_send_message", { from: "worker-1", to: "worker-1", body: bigBody, subject: "big" });
// root reads own mailbox? default agentId=root; send to root instead
await run("swarm_send_message", { to: "root", body: bigBody, subject: "big-root" });
const mbRes = await run("swarm_check_mailbox", { fullBody: true, limit: 50 });
const mbText = textOf(mbRes);
ok("Site 2: truncation hint has no mailbox file path", !mbText.includes("mailbox JSONL") && !mbText.includes(".pi/swarm"), mbText.slice(0, 300));
ok("Site 2: truncation hint names the bounded re-read", mbText.includes("fullBody:true and a smaller limit"), mbText.slice(0, 400));
// negative control: raw full body still available in details.messages
const bigMsg = (mbRes?.details?.messages ?? []).find((m) => m?.body?.length > 20000);
ok("Site 2 NC: details.messages keeps raw full body", Boolean(bigMsg));

// ---------- Sites 5 + 6: audit source block ----------
const auditDef = toolDefs.get("swarm_audit");
if (auditDef) {
	const evRes = await run("swarm_audit", { mode: "events", limit: 5 });
	let evTextSrc = null;
	try { evTextSrc = JSON.parse(textOf(evRes)).source; } catch {}
	ok("Site 5: audit events TEXT source block has no file field", evTextSrc !== null && !("file" in evTextSrc), evTextSrc);
	ok("Site 5 NC: details.source.file retained", typeof evRes?.details?.source?.file === "string");
	const tlRes = await run("swarm_audit", { mode: "timeline", messageId: "msg-nonexistent" });
	ok("Site 6: audit timeline TEXT has no file field", !textOf(tlRes).includes('"file"'), textOf(tlRes).slice(0, 200));
	ok("Site 6 NC: details.source.file retained", typeof tlRes?.details?.source?.file === "string");
	ok("Site 6 NC: timeline still returned", textOf(tlRes).includes("timeline") || tlRes?.details?.timeline !== undefined);
} else {
	// fall back: assert on source text of module if tool not registered in this lane
	ok("swarm_audit registered", false);
}

// ---------- Site 7 + Finding I: create task ----------
const createRes = await run("swarm_create_task", { taskId: "depath-selftest", title: "t", goal: "g" });
const createText = textOf(createRes);
ok("Site 7: create task text has no .pi/swarm path", !createText.includes(".pi/swarm"), createText);
ok("Site 7: create text steers to swarm_task_status", createText.includes("swarm_task_status"), createText);
ok("Site 7 NC: details.taskJson retained", typeof createRes?.details?.taskJson === "string" && createRes.details.taskJson.includes("task.json"));
ok("Site 7 NC: details.taskMd retained", typeof createRes?.details?.taskMd === "string");

// ---------- Site 4: status view:"full" guard error ----------
try {
	await run("swarm_agent_status", { view: "full" });
	ok("Site 4: view:full rejected", false, "no throw");
} catch (e) {
	ok("Site 4: view:full rejected", true);
	ok("Site 4: guard error has no .pi/swarm path", !String(e?.message).includes(".pi/swarm"), String(e?.message).slice(0, 200));
	ok("Site 4: guard error steers to bounded tools", String(e?.message).includes("swarm_audit") || String(e?.message).includes("swarm_reconcile"), String(e?.message).slice(0, 200));
}

// ---------- Finding J negative control: lifecycle warning strings byte-identical ----------
const lifecycleSrc = (await import("node:fs")).readFileSync(join(here, "..", "src", "tools", "agents", "lifecycle.ts"), "utf8");
ok("Finding J NC: spawn warning 69 byte-identical", lifecycleSrc.includes('[Swarm] Warning: .pi/swarm.yaml is not configured. Spawning with fallback defaults. Please configure .pi/swarm.yaml.'));
ok("Finding J NC: spawn warning 87 byte-identical", lifecycleSrc.includes("[WARNING: .pi/swarm.yaml is not configured. Worker spawned with fallback defaults. Configure .pi/swarm.yaml to set model & provider.]"));

// === Follow-up Finding L (goal-epoch health-check body) — RED before fix ===
{
	const { readFileSync: rsf } = await import("node:fs");
	const src = rsf(join(here, "..", "src", "nudges", "goal-epoch.ts"), "utf8");
	ok(
		"Finding L: goal-epoch health-check body has no Mailbox: <path> line",
		!/`Mailbox: \$\{/.test(src),
		"goal-epoch.ts still embeds `Mailbox: ${mbPath}` in the model-visible health-check body",
	);
}

rmSync(scratch, { recursive: true, force: true });
console.log(`\nDEPATH-TOOL-OUTPUTS ${fail ? "FAIL" : "PASS"} (${pass} passed, ${fail} failed)`);
process.exit(fail ? 1 : 0);
