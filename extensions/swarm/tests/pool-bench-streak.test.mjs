// D1/D4 (plan 2026-10-14-pool-dead-slot-stuck-and-streak-runaway):
//   D1 — no re-bench while already benched (carry-over + severity escalation + failures:0)
//   D4 — bench ceiling: min(base × 2^(streak-1), rotation.benchMaxMs default 1h); auth included (no 6h floor)
//
// RED-first: every assertion below fails against current source (written before the fix).
// Run: node extensions/swarm/tests/pool-bench-streak.test.mjs
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paths } from "../src/state.ts";
import { recordProviderError, recordSlotSuccess, setSlotCooldown, readPoolHealth, writePoolHealth, _clearQuotaResetCacheForTests } from "../src/pool.ts";
import { validateSwarmSettings } from "../src/pool.ts";
import { handlePoolCommand } from "../src/commands/pool.ts";

let pass = 0,
	fail = 0;
const ok = (name, cond, info) => {
	if (cond) {
		pass++;
		console.log("  ok  ", name);
	} else {
		fail++;
		console.error("  FAIL", name, info ?? "");
	}
};

// Minimal fake env: no env overrides leaking in
delete process.env.PI_SWARM_QUOTA_RESET_MS;
delete process.env.PI_SWARM_BENCH_MAX_MS;
delete process.env.PI_SWARM_BENCH_STREAK_DECAY_MS;

const dir = await mkdtemp(join(tmpdir(), "pool-bench-streak-"));
await mkdir(join(dir, ".pi"), { recursive: true });
await writeFile(
	join(dir, ".pi", "swarm.yml"),
	`modelPool:\n  - model: m-a\n    provider: p\n  - model: m-b\n    provider: p\n`,
);
// effectiveConfig() reads swarm.yml from process.cwd() (same pattern as pool-quota.test.mjs).
process.chdir(dir);
const p = paths(dir);
const SLOT_A = { model: "m-a", provider: "p" };
const SLOT_B = { model: "m-b", provider: "p" };
const readSlot = async (slot) => (await readPoolHealth(p)).slots["p/" + slot.model] || {};
const events = async () =>
	(await readFile(join(dir, ".pi/swarm/traces/events.jsonl"), "utf8").catch(() => ""))
		.split("\n")
		.filter(Boolean)
		.map((l) => {
			try {
				return JSON.parse(l);
			} catch {
				return {};
			}
		});

// ---- S1 THE REPRODUCTION (D1): re-bench while benched rolls cooldown + inflates streak ----
{
	await rm(join(dir, ".pi/swarm/pool-state.json"), { force: true });
	// Seed: slot benched 2h from now for quota, streak 3 (the live-incident shape)
	const now = Date.now();
	const h = await readPoolHealth(p);
	h.slots["p/m-a"] = {
		failures: 0,
		cooldownUntil: new Date(now + 2 * 3600_000).toISOString(),
		benchStreak: 3,
		lastBenchReason: "quota",
		lastBenchMs: 3600_000,
		lastError: "quota: prior",
		lastErrorAt: new Date(now - 60_000).toISOString(),
	};
	const { writePoolHealth } = await import("../src/pool.ts");
	await writePoolHealth(p, h);

	await recordProviderError(p, SLOT_A, "quota", "You have hit your ChatGPT usage limit.");
	const s = await readSlot(SLOT_A);
	ok(
		"S1 cooldownUntil carried over unchanged (no rolling re-bench)",
		s.cooldownUntil === h.slots["p/m-a"].cooldownUntil,
		`got ${s.cooldownUntil}, want ${h.slots["p/m-a"].cooldownUntil}`,
	);
	ok("S1 benchStreak still 3 (not inflated)", s.benchStreak === 3, `got ${s.benchStreak}`);
	ok("S1 failures forced to 0 while benched", s.failures === 0, `got ${s.failures}`);
	ok("S1 lastError updated (error still recorded)", String(s.lastError || "").includes("usage limit"));
	const ev = await events();
	const last = ev.filter((e) => e.event === "pool.slot_failure").at(-1);
	ok("S1 trace carries benchedAlready:true", last?.benchedAlready === true, JSON.stringify(last));
}

// ---- S2: EXPIRED bench → normal re-bench path, D4 ceiling applied ----
{
	await rm(join(dir, ".pi/swarm/pool-state.json"), { force: true });
	const { writePoolHealth } = await import("../src/pool.ts");
	const h = await readPoolHealth(p);
	h.slots["p/m-a"] = { failures: 0, cooldownUntil: new Date(Date.now() - 1000).toISOString(), benchStreak: 3 };
	await writePoolHealth(p, h);
	await recordProviderError(p, SLOT_A, "quota", "q err");
	const s = await readSlot(SLOT_A);
	const until = new Date(s.cooldownUntil).getTime();
	const gotMs = until - Date.now();
	// base = max(cooldownMs=15m, quotaReset=0) = 15m; raw backoff 15m×2³=2h but ceiling 1h
	ok("S2 streak 3→4 on expired-bench re-bench", s.benchStreak === 4, `got ${s.benchStreak}`);
	ok("S2 D4 ceiling: bench ≈ 1h (not 2h raw backoff)", gotMs > 55 * 60_000 && gotMs <= 60 * 60_000 + 5000, `got ${Math.round(gotMs / 60000)}m`);
}

// ---- S2b (R3): severity escalation while benched ----
{
	await rm(join(dir, ".pi/swarm/pool-state.json"), { force: true });
	const { writePoolHealth } = await import("../src/pool.ts");
	const h = await readPoolHealth(p);
	h.slots["p/m-a"] = { failures: 0, cooldownUntil: new Date(Date.now() + 15 * 60_000).toISOString(), benchStreak: 1, lastBenchReason: "rate_limit" };
	await writePoolHealth(p, h);
	await recordProviderError(p, SLOT_A, "auth", "invalid api key");
	const s = await readSlot(SLOT_A);
	const until = new Date(s.cooldownUntil).getTime();
	ok("S2b auth escalates: cooldownUntil extends past the 15m rate_limit bench", until > Date.now() + 20 * 60_000, `got ${Math.round((until - Date.now()) / 60000)}m`);
	ok("S2b lastBenchReason upgraded to auth", s.lastBenchReason === "auth", `got ${s.lastBenchReason}`);
	ok("S2b streak 1→2 (escalation is a real bench)", s.benchStreak === 2, `got ${s.benchStreak}`);

	// mirror: long quota bench + rate_limit error → carried over unchanged
	await rm(join(dir, ".pi/swarm/pool-state.json"), { force: true });
	const h2 = await readPoolHealth(p);
	h2.slots["p/m-a"] = {
		failures: 0,
		cooldownUntil: new Date(Date.now() + 24 * 3600_000).toISOString(),
		benchStreak: 7,
		lastBenchReason: "quota",
	};
	await writePoolHealth(p, h2);
	await recordProviderError(p, SLOT_A, "rate_limit", "429 too many requests");
	const s2 = await readSlot(SLOT_A);
	ok("S2b mirror: shorter-severity error carried over (cooldown unchanged)", s2.cooldownUntil === h2.slots["p/m-a"].cooldownUntil);
	ok("S2b mirror: streak unchanged", s2.benchStreak === 7, `got ${s2.benchStreak}`);
}

// ---- S2c (R3): manual bench conversion ----
{
	await rm(join(dir, ".pi/swarm/pool-state.json"), { force: true });
	await setSlotCooldown(p, "p/m-a", 5 * 60_000); // manual 5m bench, no reason
	await recordProviderError(p, SLOT_A, "quota", "You have hit your ChatGPT usage limit.");
	const s = await readSlot(SLOT_A);
	ok("S2c quota error converts manual bench to error-driven (extends)", new Date(s.cooldownUntil).getTime() > Date.now() + 5 * 60_000);
	ok("S2c lastBenchReason stamped quota", s.lastBenchReason === "quota", `got ${s.lastBenchReason}`);

	await rm(join(dir, ".pi/swarm/pool-state.json"), { force: true });
	await setSlotCooldown(p, "p/m-a", 30 * 60_000); // manual 30m
	await recordProviderError(p, SLOT_A, "rate_limit", "429 rate limit");
	const s2 = await readSlot(SLOT_A);
	ok("S2c rate_limit while manually benched stays manual (no reason stamp)", s2.lastBenchReason === undefined, `got ${s2.lastBenchReason}`);
	ok("S2c manual cooldown unchanged", new Date(s2.cooldownUntil).getTime() <= Date.now() + 30 * 60_000 + 5000);
}

// ---- S2d (D4): auth follows the same ceiling as every kind (plan §1.3 amendment) ----
{
	// fresh auth bench === cooldownMs (15m): the historical "auth 6h floor" existed only in a
	// comment — pool-single-strike F2 + pool-retry-preserve-cache-no-6h pin this behavior.
	await rm(join(dir, ".pi/swarm/pool-state.json"), { force: true });
	await recordProviderError(p, SLOT_B, "auth", "no auth available");
	const s = await readSlot(SLOT_B);
	const until = new Date(s.cooldownUntil).getTime();
	ok("S2d auth bench === cooldownMs (no phantom 6h floor)", Math.abs(until - Date.now() - 15 * 60_000) < 60_000, `got ${Math.round((until - Date.now()) / 60000)}m`);

	// high-streak auth also capped at 1h
	await rm(join(dir, ".pi/swarm/pool-state.json"), { force: true });
	{
		const { writePoolHealth } = await import("../src/pool.ts");
		const h = await readPoolHealth(p);
		h.slots["p/m-b"] = { failures: 0, cooldownUntil: new Date(Date.now() - 1000).toISOString(), benchStreak: 10 };
		await writePoolHealth(p, h);
	}
	await recordProviderError(p, SLOT_B, "auth", "no auth available");
	const s2 = await readSlot(SLOT_B);
	const until2 = new Date(s2.cooldownUntil).getTime();
	ok("S2d high-streak auth capped at benchMaxMs (1h)", until2 > Date.now() + 58 * 60_000 && until2 <= Date.now() + 60 * 60_000 + 5000, `got ${Math.round((until2 - Date.now()) / 60000)}m`);

	// custom ceiling via yaml — seed a high streak so the ceiling (not the base) governs
	await rm(join(dir, ".pi/swarm/pool-state.json"), { force: true });
	await writeFile(
		join(dir, ".pi", "swarm.yml"),
		`modelPool:\n  - model: m-a\n    provider: p\nrotation:\n  cooldownMs: 600000\n  benchMaxMs: 1200000\n`,
	);
	_clearQuotaResetCacheForTests();
	{
		const { writePoolHealth } = await import("../src/pool.ts");
		const h = await readPoolHealth(p);
		h.slots["p/m-a"] = { failures: 0, cooldownUntil: new Date(Date.now() - 1000).toISOString(), benchStreak: 5 };
		await writePoolHealth(p, h);
	}
	await recordProviderError(p, SLOT_A, "quota", "q");
	let sa = await readSlot(SLOT_A);
	let ms = new Date(sa.cooldownUntil).getTime() - Date.now();
	ok("S2d custom benchMaxMs=20m respected", ms > 18 * 60_000 && ms <= 20 * 60_000 + 5000, `got ${Math.round(ms / 60000)}m`);

	// env override
	process.env.PI_SWARM_BENCH_MAX_MS = "1800000"; // 30m
	_clearQuotaResetCacheForTests();
	await rm(join(dir, ".pi/swarm/pool-state.json"), { force: true });
	{
		const { writePoolHealth } = await import("../src/pool.ts");
		const h = await readPoolHealth(p);
		h.slots["p/m-a"] = { failures: 0, cooldownUntil: new Date(Date.now() - 1000).toISOString(), benchStreak: 5 };
		await writePoolHealth(p, h);
	}
	await recordProviderError(p, SLOT_A, "quota", "q");
	sa = await readSlot(SLOT_A);
	ms = new Date(sa.cooldownUntil).getTime() - Date.now();
	ok("S2d env PI_SWARM_BENCH_MAX_MS override respected", ms > 28 * 60_000 && ms <= 30 * 60_000 + 5000, `got ${Math.round(ms / 60000)}m`);
	delete process.env.PI_SWARM_BENCH_MAX_MS;

	// streak 100 → still ceiling (reset yaml to defaults first)
	await writeFile(join(dir, ".pi", "swarm.yml"), `modelPool:\n  - model: m-a\n    provider: p\n`);
	_clearQuotaResetCacheForTests();
	const { writePoolHealth } = await import("../src/pool.ts");
	await rm(join(dir, ".pi/swarm/pool-state.json"), { force: true });
	const h = await readPoolHealth(p);
	h.slots["p/m-a"] = { failures: 0, cooldownUntil: new Date(Date.now() - 1000).toISOString(), benchStreak: 100 };
	await writePoolHealth(p, h);
	await recordProviderError(p, SLOT_A, "quota", "q");
	sa = await readSlot(SLOT_A);
	ms = new Date(sa.cooldownUntil).getTime() - Date.now();
	ok("S2d streak 100 → bench exactly ceiling (1h default)", ms > 58 * 60_000 && ms <= 60 * 60_000 + 5000, `got ${Math.round(ms / 60000)}m`);
}

// ---- S3: validateSwarmSettings rejects bad new keys ----
{
	await writeFile(join(dir, ".pi", "swarm.yml"), `modelPool:\n  - model: m-a\n    provider: p\n`);
	_clearQuotaResetCacheForTests();
	let v = validateSwarmSettings(dir);
	ok("S3 baseline valid", v.ok === true, JSON.stringify(v.errors));

	await writeFile(
		join(dir, ".pi", "swarm.yml"),
		`modelPool:\n  - model: m-a\n    provider: p\nrotation:\n  benchMaxMs: 0\n`,
	);
	_clearQuotaResetCacheForTests();
	v = validateSwarmSettings(dir);
	ok("S3 benchMaxMs: 0 rejected", v.ok === false && v.errors.some((e) => e.kind === "rotation_bad_bench_max"), JSON.stringify(v.errors.map((e) => e.kind)));

	await writeFile(
		join(dir, ".pi", "swarm.yml"),
		`modelPool:\n  - model: m-a\n    provider: p\nrotation:\n  benchStreakDecayMs: -5\n`,
	);
	_clearQuotaResetCacheForTests();
	v = validateSwarmSettings(dir);
	ok("S3 negative benchStreakDecayMs rejected", v.ok === false && v.errors.some((e) => e.kind === "rotation_bad_bench_decay"), JSON.stringify(v.errors.map((e) => e.kind)));

	await writeFile(
		join(dir, ".pi", "swarm.yml"),
		`modelPool:\n  - model: m-a\n    provider: p\nrotation:\n  roleFallbackOnSwap: "yes"\n`,
	);
	_clearQuotaResetCacheForTests();
	v = validateSwarmSettings(dir);
	ok("S3 roleFallbackOnSwap non-boolean rejected", v.ok === false && v.errors.some((e) => e.kind === "rotation_bad_role_fallback"), JSON.stringify(v.errors.map((e) => e.kind)));
}

// ---- S4/S4b (D3 decay + manual stamping) — Stage 2, asserted here so the suite is complete ----
{
	const { writePoolHealth } = await import("../src/pool.ts");
	// S4: decay on the second healthy turn (early-return shape, no lastError)
	await rm(join(dir, ".pi/swarm/pool-state.json"), { force: true });
	await writeFile(join(dir, ".pi", "swarm.yml"), `modelPool:\n  - model: m-a\n    provider: p\n`);
	_clearQuotaResetCacheForTests();
	const h = await readPoolHealth(p);
	h.slots["p/m-a"] = {
		failures: 0,
		benchStreak: 5,
		lastBenchAt: new Date(Date.now() - 7 * 3600_000).toISOString(),
		lastBenchReason: "quota",
	};
	await writePoolHealth(p, h);
	await recordSlotSuccess(p, SLOT_A);
	let s = await readSlot(SLOT_A);
	ok("S4 decay fires past early-return: benchStreak 5→0", s.benchStreak === 0 || s.benchStreak === undefined, `got ${s.benchStreak}`);
	ok("S4 lastBenchReason preserved (recovery gate)", s.lastBenchReason === "quota", `got ${s.lastBenchReason}`);
	ok("S4 lastBenchAt preserved (not wiped)", !!s.lastBenchAt, JSON.stringify(s));

	// no-decay window: lastBenchAt 1h ago → streak stays
	await rm(join(dir, ".pi/swarm/pool-state.json"), { force: true });
	const h2 = await readPoolHealth(p);
	h2.slots["p/m-a"] = { failures: 0, benchStreak: 5, lastBenchAt: new Date(Date.now() - 3600_000).toISOString(), lastError: "x", lastErrorAt: new Date().toISOString() };
	await writePoolHealth(p, h2);
	await recordSlotSuccess(p, SLOT_A);
	s = await readSlot(SLOT_A);
	ok("S4 fresh bench (1h) → streak stays 5", s.benchStreak === 5, `got ${s.benchStreak}`);
	ok("S4 lastBenchAt preserved across success", !!s.lastBenchAt);

	// S4b: manual bench stamps lastBenchAt; clear deletes it
	await rm(join(dir, ".pi/swarm/pool-state.json"), { force: true });
	await setSlotCooldown(p, "p/m-a", 3600_000);
	s = await readSlot(SLOT_A);
	ok("S4b manual bench stamps lastBenchAt", !!s.lastBenchAt, JSON.stringify(s));
	await setSlotCooldown(p, "p/m-a", null);
	s = await readSlot(SLOT_A);
	ok("S4b manual clear deletes lastBenchAt", s.lastBenchAt === undefined, JSON.stringify(s));

	// S6: /swarm pool list renders streak suffix when benchStreak > 1
	await rm(join(dir, ".pi/swarm/pool-state.json"), { force: true });
	const hList = await readPoolHealth(p);
	hList.slots["p/m-a"] = {
		failures: 0,
		benchStreak: 3,
		cooldownUntil: new Date(Date.now() + 15 * 60_000).toISOString(),
	};
	await writePoolHealth(p, hList);
	const notifs = [];
	const ctx = { ui: { notify: (msg) => notifs.push(msg) }, cwd: dir };
	await handlePoolCommand("pool", ["list"], ctx, p, {});
	const listText3 = notifs.join("\n");
	ok("S6 list renders (streak 3) when benchStreak > 1", /BENCHED \d+m \(streak 3\)/.test(listText3), listText3);

	// Case 2: benchStreak 1 (<= 1) -> no (streak N) suffix
	hList.slots["p/m-a"].benchStreak = 1;
	await writePoolHealth(p, hList);
	notifs.length = 0;
	await handlePoolCommand("pool", ["list"], ctx, p, {});
	const listText1 = notifs.join("\n");
	ok("S6 list does NOT render streak suffix when benchStreak === 1", !listText1.includes("(streak"), listText1);

	// Case 3: healthy slot (not in cooldown) -> "ok"
	delete hList.slots["p/m-a"].cooldownUntil;
	await writePoolHealth(p, hList);
	notifs.length = 0;
	await handlePoolCommand("pool", ["list"], ctx, p, {});
	const listTextOk = notifs.join("\n");
	ok("S6 list renders ok for unbenched slot", listTextOk.includes("ok") && !listTextOk.includes("BENCHED"), listTextOk);
}

await rm(dir, { recursive: true, force: true });
process.chdir("/");
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
