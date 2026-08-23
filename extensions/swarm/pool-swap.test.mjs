// In-process auto-swap: turn_end with stopReason "error" + provider errorMessage must
// (1) bench the failing slot per error KIND (quota/auth immediate; transient after streak),
// (2) swap the session model to a DIFFERENT healthy slot via pi.setModel — no respawn, no
//     tmux, no manual command. The agent process never exits on provider errors.
//
// Run: node extensions/swarm/pool-swap.test.mjs
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paths, readState } from "./src/state.ts";
import { registerSwarmHooks } from "./src/hooks.ts";
import { poolStatus, slotKey } from "./src/pool.ts";
import { classifyProviderError } from "./src/types.ts";

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.error("  FAIL:", name); } };

// --- error classification ---
ok("429 quota text -> quota", classifyProviderError("Error 429: You exceeded your current quota, please check your plan and billing details") === "quota");
ok("rate limit -> rate_limit", classifyProviderError("429 Too Many Requests: rate limit exceeded") === "rate_limit");
ok("bad key -> auth", classifyProviderError("401 Invalid API key provided") === "auth");
ok("network -> transient", classifyProviderError("fetch failed: ECONNREFUSED 127.0.0.1:443") === "transient");
ok("context overflow -> unknown", classifyProviderError("Prompt is too long: 390000 tokens > 200000 maximum") === "unknown");

// --- fixture project with a model pool ---
const dir = await mkdtemp(join(tmpdir(), "pool-swap-"));
await mkdir(join(dir, ".pi"), { recursive: true });
await writeFile(join(dir, ".pi", "settings.json"), JSON.stringify({
	swarm: {
		defaultModel: "glm-5.1",
		defaultProvider: "zai-coding-cn",
		modelPool: [
			{ model: "glm-5.1", provider: "zai-coding-cn", weight: 50 },
			{ model: "gpt-5.4-mini", provider: "openai", weight: 30 },
			{ model: "claude-sonnet-4", provider: "anthropic", weight: 0 },
		],
		rotation: { strategy: "round-robin", cooldownMs: 300_000, maxRetries: 2 },
	},
}));
process.chdir(dir);
const p = paths(dir);
// Seed agent record so currentAgentId resolves (spawn env sim).
process.env.PI_SWARM_AGENT_ID = "worker-a";
const st = await readState(p, dir);
const ts = new Date().toISOString();
st.agents["worker-a"] = {
	id: "worker-a", role: "worker", roleKind: "worker", capabilities: [], activeTaskIds: [], maxConcurrentTasks: 1,
	status: "running", runtimeStatus: "idle", health: "healthy",
	tmuxSession: "sess", tmuxWindow: "worker-a", tmuxTarget: "sess:worker-a.0",
	model: "glm-5.1", provider: "zai-coding-cn", cwd: dir, mailbox: ".pi/swarm/mailboxes/x.jsonl",
	createdAt: ts, updatedAt: ts,
};
const { writeState } = await import("./src/state.ts");
await writeState(p, st);

// --- fake pi capturing setModel + sendMessage ---
const setModelCalls = [];
const sentMessages = [];
const handlers = {};
const fakePi = {
	on: (ev, fn) => { (handlers[ev] ||= []).push(fn); },
	registerTool: () => {}, registerCommand: () => {},
	setModel: async (m) => { setModelCalls.push(`${m.provider}/${m.id}`); return true; },
	sendMessage: (m, o) => { sentMessages.push({ m, o }); },
	exec: async () => ({ code: 0, stdout: "", stderr: "" }),
};
const fakeModelGlm = { id: "glm-5.1", provider: "zai-coding-cn" };
const fakeModelGpt = { id: "gpt-5.4-mini", provider: "openai" };
const fakeModelClaude = { id: "claude-sonnet-4", provider: "anthropic" };
const ctx = {
	cwd: dir, mode: "tui", isIdle: () => true, model: fakeModelGlm,
	modelRegistry: { find: (provider, id) => {
		if (id === "gpt-5.4-mini") return fakeModelGpt;
		if (id === "claude-sonnet-4") return fakeModelClaude;
		if (id === "glm-5.1") return fakeModelGlm;
		return undefined;
	} },
};

registerSwarmHooks(fakePi);
const turnEnd = handlers["turn_end"][0];

// Simulate a QUOTA error turn from glm/zai.
await turnEnd({ type: "turn_end", turnIndex: 1, message: {
	role: "assistant", model: "glm-5.1", provider: "zai-coding-cn",
	stopReason: "error", errorMessage: "Error 429: You exceeded your current quota, please check your plan and billing details",
}, toolResults: [] }, ctx);

ok("quota error swapped model in-process", setModelCalls.length === 1);
ok("swapped to a DIFFERENT slot", setModelCalls[0] !== "zai-coding-cn/glm-5.1");
let ps = await poolStatus(p);
const glm = ps.slots.find((s) => s.model === "glm-5.1");
ok("quota benched glm immediately", glm.inCooldown && /quota/.test(glm.health.lastError));
ok("swap note sent to the agent", sentMessages.some((s) => /MODEL POOL/.test(s.m.content) && /quota/.test(s.m.content)));

// Non-provider errors must NOT swap (e.g. context overflow).
const before = setModelCalls.length;
await turnEnd({ type: "turn_end", turnIndex: 2, message: {
	role: "assistant", model: "gpt-5.4-mini", provider: "openai",
	stopReason: "error", errorMessage: "Prompt is too long: 390000 tokens > 200000 maximum",
}, toolResults: [] }, { ...ctx, model: fakeModelGpt });
ok("context overflow does NOT swap", setModelCalls.length === before);

// Transient errors need a streak (maxRetries=2) before benching — but swap happens every provider error.
await turnEnd({ type: "turn_end", turnIndex: 3, message: {
	role: "assistant", model: "gpt-5.4-mini", provider: "openai",
	stopReason: "error", errorMessage: "fetch failed: ECONNREFUSED",
}, toolResults: [] }, { ...ctx, model: fakeModelGpt });
ps = await poolStatus(p);
const gpt = ps.slots.find((s) => s.model === "gpt-5.4-mini");
ok("1st transient does NOT bench", !gpt.inCooldown && gpt.health.failures === 1);

// Guest sessions never rotate.
const guestCalls = setModelCalls.length;
process.env.PI_SWARM_AGENT_ID = "swarm-guest";
await turnEnd({ type: "turn_end", turnIndex: 4, message: {
	role: "assistant", model: "glm-5.1", provider: "zai-coding-cn",
	stopReason: "error", errorMessage: "429 quota exceeded",
}, toolResults: [] }, ctx);
ok("guest session does not rotate", setModelCalls.length === guestCalls);
delete process.env.PI_SWARM_AGENT_ID;

console.log(`\n${fail === 0 ? "PASS" : "FAIL"}: ${pass} passed, ${fail} failed`);
process.chdir("/");
await rm(dir, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
