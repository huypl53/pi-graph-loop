// Model pool: weighted/rr/sticky rotation, health cooldown, failover pick.
//
// Run: node extensions/swarm/pool.test.mjs
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paths } from "./src/state.ts";
import { pickSlot, recordProviderError, recordSlotSuccess, setSlotCooldown, poolStatus, slotKey } from "./src/pool.ts";

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.error("  FAIL:", name); } };

const dir = await mkdtemp(join(tmpdir(), "pool-test-"));
await mkdir(join(dir, ".pi"), { recursive: true });
const settings = {
	swarm: {
		modelPool: [
			{ model: "glm-5.1", provider: "zai-coding-cn", weight: 50 },
			{ model: "gpt-5.4-mini", provider: "openai", weight: 30 },
			{ model: "claude-sonnet-4", provider: "anthropic", weight: 0 },
		],
		rotation: { strategy: "weighted", cooldownMs: 60_000, maxRetries: 2 },
	},
};
await writeFile(join(dir, ".pi", "settings.json"), JSON.stringify(settings));
process.chdir(dir);
const p = paths(dir);

// Weighted pick returns eligible (weight>0) slots only.
for (let i = 0; i < 30; i++) {
	const r = await pickSlot(p);
	ok(`pick ${i} returns weighted slot`, r.slot.weight > 0);
}
const first = await pickSlot(p);
ok("pick carries model+provider", first.slot.model === "glm-5.1" && first.slot.provider === "zai-coding-cn" || first.slot.model === "gpt-5.4-mini");

// Failure streak: 1 failure -> no cooldown; 2 (maxRetries) -> benched.
const slot = { model: "glm-5.1", provider: "zai-coding-cn" };
let h = await recordProviderError(p, slot, "rate_limit", "429 rate limit exceeded (1)");
ok("1st failure no cooldown", !h.cooldownUntil);
h = await recordProviderError(p, slot, "rate_limit", "429 rate limit exceeded (2)");
ok("2nd failure benches slot", Boolean(h.cooldownUntil));

// Benched slot excluded from picks.
let sawBenched = false;
for (let i = 0; i < 40; i++) {
	const r = await pickSlot(p);
	if (slotKey(r.slot) === slotKey(slot)) sawBenched = true;
}
ok("benched slot not picked", !sawBenched);

// Status shows cooldown.
const st = await poolStatus(p);
const benched = st.slots.find((s) => slotKey(s) === slotKey(slot));
ok("poolStatus reports benched", benched.inCooldown && benched.cooldownRemainingMs > 0 && benched.health.lastError.includes("429"));

// Fallback-only slot (weight 0) becomes the pick when all weighted slots are benched.
const slot2 = { model: "gpt-5.4-mini", provider: "openai" };
await recordProviderError(p, slot2, "rate_limit", "429 rate limit (1)");
await recordProviderError(p, slot2, "rate_limit", "429 rate limit (2)");
const fb = await pickSlot(p);
ok("all benched -> fallback-only slot", fb.slot.model === "claude-sonnet-4");
ok("fallback reason recorded", fb.reason.includes("fallback"));

// Success clears the streak.
await setSlotCooldown(p, slotKey(slot), 1); // 1ms, effectively expired
await new Promise((r) => setTimeout(r, 5));
await recordSlotSuccess(p, slot);
const st2 = await poolStatus(p);
ok("success clears failures", st2.slots.find((s) => slotKey(s) === slotKey(slot)).health.failures === 0);

// Sticky strategy: same key -> same slot.
await writeFile(join(dir, ".pi", "settings.json"), JSON.stringify({ swarm: { ...settings.swarm, rotation: { strategy: "sticky", cooldownMs: 1000, maxRetries: 2 } } }));
const picks = new Set();
for (let i = 0; i < 5; i++) picks.add(slotKey((await pickSlot(p, { stickyKey: "agent-x" })).slot));
ok("sticky is deterministic", picks.size === 1);

// Dedupe: identical error within 30s counts once (pi internal retries).
{
	await rm(join(dir, ".pi", "swarm", "pool-state.json"), { force: true }); // fresh health for these blocks
	const slot3 = { model: "glm-5.1", provider: "zai-coding-cn" };
	let h3 = await recordProviderError(p, slot3, "transient", "identical boom");
	ok("dedupe: first counts", h3.failures === 1);
	h3 = await recordProviderError(p, slot3, "transient", "identical boom");
	ok("dedupe: identical within 30s does not bump", h3.failures === 1);
	h3 = await recordProviderError(p, slot3, "transient", "a different boom");
	ok("dedupe: different error bumps (benched at streak 2)", Boolean(h3.cooldownUntil));
}
// Exponential backoff: consecutive benches double the cooldown (capped 24h).
{
	await rm(join(dir, ".pi", "swarm", "pool-state.json"), { force: true }); // fresh health
	// The sticky block above rewrote settings with cooldownMs:1000; restore the 60s config.
	await writeFile(join(dir, ".pi", "settings.json"), JSON.stringify(settings));
	const slot4 = { model: "glm-5.1", provider: "zai-coding-cn" };
	await recordProviderError(p, slot4, "quota", "q1"); // immediate bench #1
	const stA = await poolStatus(p);
	const sA = stA.slots.find((s) => s.key === slotKey(slot4));
	ok("backoff: bench #1 ~60s", sA.cooldownRemainingMs > 55_000 && sA.cooldownRemainingMs <= 61_000);
	await setSlotCooldown(p, slotKey(slot4), 1); // expire now
	await new Promise((r) => setTimeout(r, 5));
	await recordProviderError(p, slot4, "quota", "q2"); // bench #2 -> 2x
	const stB = await poolStatus(p);
	const sB = stB.slots.find((s) => s.key === slotKey(slot4));
	ok("backoff: bench #2 ~120s (2x)", sB.cooldownRemainingMs > 110_000 && sB.cooldownRemainingMs <= 122_000);
}

// No pool configured -> undefined pick.
await rm(join(dir, ".pi", "settings.json"), { force: true });
await writeFile(join(dir, ".pi", "settings.json"), JSON.stringify({ swarm: { defaultModel: "glm-5.1" } }));
ok("no pool -> undefined", (await pickSlot(p)) === undefined);

console.log(`\n${fail === 0 ? "PASS" : "FAIL"}: ${pass} passed, ${fail} failed`);
process.chdir("/");
await rm(dir, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
