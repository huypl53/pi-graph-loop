// Regression test: ensure transient errors (even with auth/proxy wrapper text)
// do NOT single-strike swap on the first error, preserving cache for engine retry.
// Also ensure auth errors are NOT benched with a 6-hour floor (rotation.cooldownMs is honored).

import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { stringify } from "yaml";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paths } from "../src/state.ts";
import { registerSwarmHooks } from "../src/hooks.ts";
import { poolStatus } from "../src/pool.ts";

let pass = 0,
	fail = 0;
const ok = (name, cond, info) => {
	if (cond) pass++;
	else {
		fail++;
		console.error("  FAIL:", name, info ?? "");
	}
};

const dir = await mkdtemp(join(tmpdir(), "pool-retry-no-6h-"));
await mkdir(join(dir, ".pi"), { recursive: true });
await writeFile(
	join(dir, ".pi", "swarm.yml"),
	stringify({
		defaultModel: "gpt-6-luna",
		defaultProvider: "cliproxyapi",
		modelPool: [
			{ model: "gpt-6-luna", provider: "cliproxyapi", weight: 50 },
			{ model: "gpt-5.6-terra", provider: "cliproxyapi", weight: 30 },
		],
		rotation: { strategy: "round-robin", cooldownMs: 300_000, maxRetries: 2 },
	}),
);
process.chdir(dir);
const p = paths(dir);

const setModelCalls = [];
const handlers = {};
const sentMessages = [];
const fakePi = {
	on: (ev, fn) => {
		(handlers[ev] ||= []).push(fn);
	},
	registerTool: () => {},
	registerCommand: () => {},
	setModel: async (m) => {
		setModelCalls.push(`${m.provider}/${m.id}`);
		return true;
	},
	sendMessage: (m, o) => {
		sentMessages.push({ m, o });
	},
	exec: async () => ({ code: 0, stdout: "", stderr: "" }),
};
const fakeModelLuna = { id: "gpt-6-luna", provider: "cliproxyapi" };
const fakeModelTerra = { id: "gpt-5.6-terra", provider: "cliproxyapi" };
const ctx = {
	cwd: dir,
	mode: "tui",
	isIdle: () => true,
	model: fakeModelLuna,
	modelRegistry: {
		find: (provider, id) => {
			if (id === "gpt-5.6-terra") return fakeModelTerra;
			if (id === "gpt-6-luna") return fakeModelLuna;
			return undefined;
		},
	},
};

registerSwarmHooks(fakePi);
const turnEnd = async (ev, c = ctx) => {
	for (const fn of handlers["turn_end"] || []) {
		await fn(ev, c);
	}
};

process.env.PI_SWARM_AGENT_ID = "test-agent";

// Test 1: Proxy error with auth_unavailable wrapper on 1st strike must NOT swap immediately.
// It must stay gated so pi engine can retry on the same model to preserve cache,
// AND Swarm actively triggers a retry turn on the same model!
const proxyError =
	"auth_unavailable: no auth available (providers=codex, model=gpt-6-luna; last upstream error: upstream connect error or disconnect/reset before headers. reset reason: connection termination)";

await turnEnd({
	type: "turn_end",
	turnIndex: 1,
	message: {
		role: "assistant",
		model: "gpt-6-luna",
		provider: "cliproxyapi",
		stopReason: "error",
		errorMessage: proxyError,
	},
	toolResults: [],
});

ok(
	"Strike 1: does NOT swap immediately on first proxy auth_unavailable error (preserves cache for retry)",
	setModelCalls.length === 0,
	`actual setModelCalls=${JSON.stringify(setModelCalls)}`,
);

const ps1 = await poolStatus(p);
const lunaSlot1 = ps1.slots.find((s) => s.model === "gpt-6-luna");
ok("Strike 1: slot is NOT benched on strike 1", !lunaSlot1?.inCooldown, `actual cooldown=${lunaSlot1?.inCooldown}`);

const retryNudge = sentMessages.find((s) => s.o?.triggerTurn === true && /retry/i.test(String(s.m?.content)));
ok(
	"Strike 1: Swarm actively sends an exponential retry trigger on the current model slot",
	Boolean(retryNudge),
	`sentMessages=${JSON.stringify(sentMessages)}`,
);

// Test 2: If retry fails again (strike 2 >= ENGINE_MAX_RETRIES), THEN it rotates
await turnEnd({
	type: "turn_end",
	turnIndex: 2,
	message: {
		role: "assistant",
		model: "gpt-6-luna",
		provider: "cliproxyapi",
		stopReason: "error",
		errorMessage: proxyError,
	},
	toolResults: [],
});

ok(
	"Strike 2: swaps to next model after retries exhausted",
	setModelCalls.length === 1 && setModelCalls[0] === "cliproxyapi/gpt-5.6-terra",
	`actual setModelCalls=${JSON.stringify(setModelCalls)}`,
);

const ps2 = await poolStatus(p);
const lunaSlot2 = ps2.slots.find((s) => s.model === "gpt-6-luna");
ok("Strike 2: slot is now benched after retries exhausted", Boolean(lunaSlot2?.inCooldown), `actual cooldown=${lunaSlot2?.inCooldown}`);

// Test 3: Bench duration must NOT have 6-hour floor (must use rotation.cooldownMs = 300,000ms)
const benchMs = lunaSlot2?.health?.lastBenchMs;
ok(
	"Bench duration honors rotation.cooldownMs (300,000ms), NOT 6-hour floor (21,600,000ms)",
	benchMs === 300_000,
	`actual lastBenchMs=${benchMs}`,
);

console.log(`\n${fail === 0 ? "PASS" : "FAIL"}: ${pass} passed, ${fail} failed`);
process.chdir("/");
await rm(dir, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
