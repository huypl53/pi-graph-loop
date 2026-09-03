// Issue 21 quota-reset-interval: bench until provider reset + recover trace event.
//
// Strategy: drive the REAL `effectiveBenchMs`, `recordProviderError`, `setSlotCooldown`, and
// `evaluateSlotRecoveryLocked` exported from pool.ts + reconcile.ts with a scratch project + pool
// state. Tests cover:
//   A — quotaResetMs=24h: bench duration is ~24h, not 15min
//   B — quotaResetMs=0/absent: bench duration is ~15min (regression baseline)
//   C — bench expired + agent has activeTaskIds: pool.slot_recovered trace fires
//   D — bench expired + no active tasks: silent (no event)
//   E — PI_SWARM_QUOTA_RESET_MS env override when per-slot is absent
//   F — lastBenchReason stamped on every bench (kind discrimination)
//   G — B-3: success-then-bench-then-expire flow correctly emits slot_recovered for the second bench
//   H — poolStatus exposes quotaResetMs + quotaAware annotation
//
// Critical caveats:
//   - PI_SWARM_QUOTA_RESET_MS is read at module-load time (constants pattern). Cases that need to
//     override it MUST delete the env var first, set the new value, then dynamic-import pool.ts
//     (mirrors idle-nudge.test.mjs handling of PI_SWARM_MAX_NUDGES).
//   - Wall-clock jitter on the 3-error burst is 10–200ms. Tolerance: >= 86_398_000ms for 24h
//     benches (1-second slack per B-4, not 500ms).
//   - The pool.ts internal `quotaResetCache` is keyed by cwd. To avoid cache bleed between fixtures
//     (which all share the same dir), each fixture clears the cache via the `_clearQuotaResetCacheForTests`
//     helper exported from pool.ts (test-only export; no production callers).
//
// Run: node extensions/swarm/quota-reset.test.mjs
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// Always load pool.ts first so QUOTA_RESET_DEFAULT_MS is read against the CURRENT env (test E sets
// the env before the first import). Subsequent cases that need to re-read the env (case E) use a
// fresh dynamic import with a cache-busting query string.
const { paths, readState, writeState, trace } = await import(join(here, "..", "src", "state.ts"));

let pass = 0, fail = 0;
const ok = (n, c, info) => { if (c) { pass++; console.log("  ok  ", n); } else { fail++; console.error("  FAIL:", n, info ?? ""); } };

// Shared scratch dir for all fixtures except E (which needs its own dir to avoid env leakage
// between fixtures). E gets a fresh dir AND a fresh module import (cache-bust).
const dir = await mkdtemp(join(tmpdir(), "quota-reset-"));
await mkdir(join(dir, ".pi"), { recursive: true });

// Helper: reset EVERYTHING between fixtures (swarm state, pool state, agent records, events, and
// the pool.ts quotaResetCache). This guarantees isolation even when fixtures share the same cwd
// (which they all do except E, which uses its own dir). Without this, case D's recovery scan
// would see worker-c from case C still has activeTaskIds on glm-5.1 and emit a false-positive.
async function resetFixtureState() {
	const p = paths(dir);
	await rm(join(p.root), { recursive: true, force: true }).catch(() => {});
	await mkdir(join(dir, ".pi"), { recursive: true });
	const { _clearQuotaResetCacheForTests } = await import(join(here, "..", "src", "pool.ts"));
	_clearQuotaResetCacheForTests();
}

// Helper: count trace events of a given name from the project's events.jsonl.
async function countEvents(name, eventsPath) {
	try {
		const raw = await readFile(eventsPath, "utf8");
		const lines = raw.split("\n").filter(Boolean);
		return lines.filter((l) => { try { const o = JSON.parse(l); return o.event === name; } catch { return false; } }).length;
	} catch { return 0; }
}

// Helper: read the events file into parsed objects (latest snapshot).
async function readEvents(eventsPath) {
	try {
		const raw = await readFile(eventsPath, "utf8");
		return raw.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
	} catch { return []; }
}

// Helper: clear env, set env, then re-import pool.ts with a cache-busting query. Mirrors the
// PI_SWARM_MAX_NUDGES pattern in idle-nudge.test.mjs (B-5).
async function loadPoolFresh() {
	const mod = `../src/pool.ts?t=${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	return await import(join(here, mod));
}

// Seed the scratch dir with a model pool. Each fixture may overwrite this to change quotaResetMs.
async function seedSettings(pool) {
	await writeFile(join(dir, ".pi", "settings.json"), JSON.stringify({
		swarm: {
			defaultModel: "glm-5.1",
			defaultProvider: "zai-coding-cn",
			modelPool: pool,
			rotation: { strategy: "weighted", cooldownMs: 900_000, maxRetries: 2 },
		},
	}));
}

// Seed a SwarmAgent with optional activeTaskIds.
async function seedAgent(agentId, opts = {}) {
	const p = paths(dir);
	const st = await readState(p, dir);
	const ts = new Date().toISOString();
	st.agents[agentId] = {
		id: agentId,
		role: opts.role || "worker",
		roleKind: opts.roleKind || "worker",
		capabilities: opts.capabilities || [],
		activeTaskIds: opts.activeTaskIds || [],
		maxConcurrentTasks: opts.maxConcurrentTasks ?? 5,
		status: opts.status || "running",
		runtimeStatus: opts.runtimeStatus || "idle",
		health: opts.health || "healthy",
		tmuxSession: opts.tmuxSession || "sess",
		tmuxWindow: opts.tmuxWindow || agentId,
		tmuxTarget: opts.tmuxTarget || `sess:${agentId}.0`,
		model: opts.model || "glm-5.1",
		provider: opts.provider || "zai-coding-cn",
		cwd: dir,
		mailbox: `.pi/swarm/mailboxes/${agentId}.jsonl`,
		createdAt: ts,
		updatedAt: ts,
	};
	await writeState(p, st);
	return p;
}

// =============================================================================
// CASE A — quotaResetMs=24h: bench duration is ~24h, not 15min
// =============================================================================
{
	await resetFixtureState();
	await seedSettings([
		{ model: "glm-5.1", provider: "zai-coding-cn", weight: 50, quotaResetMs: 86_400_000 },
		{ model: "gpt-5.4-mini", provider: "openai", weight: 30 },
	]);
	process.chdir(dir);
	const { recordProviderError, slotKey, effectiveConfig, effectiveBenchMs } = await import(join(here, "..", "src", "pool.ts"));
	const p = await seedAgent("worker-a");
	const glmSlot = { model: "glm-5.1", provider: "zai-coding-cn" };
	const rotation = effectiveConfig().rotation;

	// Direct helper: effectiveBenchMs = max(900_000, 86_400_000) = 86_400_000
	const direct = effectiveBenchMs(glmSlot, rotation);
	ok("case A: effectiveBenchMs(24h) = 86_400_000", direct === 86_400_000, `got ${direct}`);

	// A SINGLE quota error is enough to bench immediately (kind === "quota" is immediate). The
	// exponential backoff applies on TOP of effectiveBenchMs, so a single error benches for exactly
	// effectiveBenchMs (no doubling yet). Use a single error to get a clean ~86_400_000ms bench.
	const before = Date.now();
	await recordProviderError(p, glmSlot, "quota", "Error 429: exceeded your current quota");
	const { readPoolHealth } = await import(join(here, "..", "src", "pool.ts"));
	const h = await readPoolHealth(p);
	const glmHealth = h.slots[slotKey(glmSlot)];
	const benchMs = new Date(glmHealth.cooldownUntil).getTime() - before;
	// Allowance: 86_398_000ms (1-second slack per B-4). Upper bound: 86_400_000 + wall-clock jitter
	// (the 3-ms jitter seen on the first run is from `Date.now() + ms` evaluation happening a few
	// ms after the before snapshot).
	ok("case A: 1 quota error benches for ~24h (86_398_000..86_400_500ms per B-4)", benchMs >= 86_398_000 && benchMs <= 86_400_500, `benchMs=${benchMs}`);
	ok("case A: lastBenchReason stamped as 'quota'", glmHealth.lastBenchReason === "quota", `lastBenchReason=${glmHealth.lastBenchReason}`);
	ok("case A: benchStreak=1 after first immediate quota bench", glmHealth.benchStreak === 1, `benchStreak=${glmHealth.benchStreak}`);
}

// =============================================================================
// CASE B — quotaResetMs=0/absent: bench duration is ~15min (regression baseline)
// =============================================================================
{
	await resetFixtureState();
	await seedSettings([
		{ model: "glm-5.1", provider: "zai-coding-cn", weight: 50 },
		{ model: "gpt-5.4-mini", provider: "openai", weight: 30 },
	]);
	process.chdir(dir);
	const { recordProviderError, slotKey, effectiveBenchMs, _clearQuotaResetCacheForTests } = await import(join(here, "..", "src", "pool.ts"));
	_clearQuotaResetCacheForTests(); // clear cache that case A populated for this cwd
	const p = await seedAgent("worker-b");
	const glmSlot = { model: "glm-5.1", provider: "zai-coding-cn" };
	const { effectiveConfig } = await import(join(here, "..", "src", "pool.ts"));
	const rotation = effectiveConfig().rotation;

	// Direct helper: effectiveBenchMs = max(900_000, 0) = 900_000
	const direct = effectiveBenchMs(glmSlot, rotation);
	ok("case B: effectiveBenchMs(0/absent) = rotation.cooldownMs (no change)", direct === 900_000, `got ${direct}`);

	const before = Date.now();
	await recordProviderError(p, glmSlot, "quota", "Error 429: exceeded your current quota");
	const { readPoolHealth } = await import(join(here, "..", "src", "pool.ts"));
	const h = await readPoolHealth(p);
	const glmHealth = h.slots[slotKey(glmSlot)];
	const benchMs = new Date(glmHealth.cooldownUntil).getTime() - before;
	ok("case B: 1 quota error benches for ~15min (900_000ms ± tolerance)", benchMs >= 899_500 && benchMs <= 900_500, `benchMs=${benchMs}`);
}

// =============================================================================
// CASE C — bench expired + agent has activeTaskIds: pool.slot_recovered fires
// =============================================================================
{
	await resetFixtureState();
	await seedSettings([
		{ model: "glm-5.1", provider: "zai-coding-cn", weight: 50, quotaResetMs: 86_400_000 },
		{ model: "gpt-5.4-mini", provider: "openai", weight: 30 },
	]);
	process.chdir(dir);
	const { paths: pathsLocal, readState: rsLocal, writeState: wsLocal } = await import(join(here, "..", "src", "state.ts"));
	const { readPoolHealth, writePoolHealth, withPoolLock, _clearQuotaResetCacheForTests } = await import(join(here, "..", "src", "pool.ts"));
	_clearQuotaResetCacheForTests();
	const { evaluateSlotRecoveryLocked } = await import(join(here, "..", "src", "reconcile.ts"));
	const p = pathsLocal(dir);
	await seedAgent("worker-c", { activeTaskIds: ["task-1", "task-2"] });

	// Manually craft a benched slot: cooldownUntil in the past, lastBenchReason="quota".
	await withPoolLock(p, async () => {
		const h = await readPoolHealth(p);
		h.slots["zai-coding-cn/glm-5.1"] = {
			failures: 0,
			lastBenchReason: "quota",
			benchStreak: 1,
			cooldownUntil: new Date(Date.now() - 1000).toISOString(),
		};
		await writePoolHealth(p, h);
	});

	// Drive the recovery scan directly. The root pump also calls this on every tick.
	const fakePi = { registerTool: () => {}, registerCommand: () => {}, on: () => {}, sendMessage: () => {}, exec: async () => ({ code: 0, stdout: "", stderr: "" }) };
	const st = await rsLocal(p, dir);
	const nowMs = Date.now();
	const result = await evaluateSlotRecoveryLocked(fakePi, dir, p, st, nowMs);
	ok("case C: evaluateSlotRecoveryLocked emitted >= 1 event", result.emitted >= 1, `emitted=${result.emitted} reasons=${JSON.stringify(result.reasons)}`);
	ok("case C: reason counter includes 'expired_quota'", (result.reasons.expired_quota || 0) >= 1, `reasons=${JSON.stringify(result.reasons)}`);

	// Trace file should contain pool.slot_recovered.
	const evCount = await countEvents("pool.slot_recovered", p.events);
	ok("case C: pool.slot_recovered trace fired in events.jsonl", evCount >= 1, `count=${evCount}`);

	// Trace payload shape: { agentId, slot, afterMs, remainingTasks, benchMs }.
	const events = await readEvents(p.events);
	const recovered = events.find((e) => e.event === "pool.slot_recovered");
	ok("case C: trace payload has agentId", recovered?.agentId === "worker-c", `agentId=${recovered?.agentId}`);
	ok("case C: trace payload has slot", recovered?.slot === "zai-coding-cn/glm-5.1", `slot=${recovered?.slot}`);
	ok("case C: trace payload has remainingTasks > 0", recovered?.remainingTasks > 0, `remainingTasks=${recovered?.remainingTasks}`);
	ok("case C: trace payload has afterMs (>=0)", typeof recovered?.afterMs === "number" && recovered.afterMs >= 0, `afterMs=${recovered?.afterMs}`);
	ok("case C: trace payload has benchMs (>=0; stamped at bench time)", typeof recovered?.benchMs === "number" && recovered.benchMs >= 0, `benchMs=${recovered?.benchMs}`);

	// Idempotent: second call should NOT emit (lastRecoveredAt dedupe).
	const result2 = await evaluateSlotRecoveryLocked(fakePi, dir, p, st, nowMs + 1000);
	ok("case C: second tick is deduped (0 emitted)", result2.emitted === 0, `emitted=${result2.emitted}`);
	ok("case C: second tick reports 'deduped' reason", (result2.reasons.deduped || 0) >= 1, `reasons=${JSON.stringify(result2.reasons)}`);

	// lastRecoveredAt should be stamped on the slot.
	const h2 = await readPoolHealth(p);
	ok("case C: lastRecoveredAt stamped on the slot", Boolean(h2.slots["zai-coding-cn/glm-5.1"]?.lastRecoveredAt), `lastRecoveredAt=${h2.slots["zai-coding-cn/glm-5.1"]?.lastRecoveredAt}`);
}

// =============================================================================
// CASE D — bench expired + NO active tasks: silent (no event)
// =============================================================================
{
	await resetFixtureState();
	await seedSettings([
		{ model: "glm-5.1", provider: "zai-coding-cn", weight: 50, quotaResetMs: 86_400_000 },
		{ model: "gpt-5.4-mini", provider: "openai", weight: 30 },
	]);
	process.chdir(dir);
	const { paths: pathsLocal, readState: rsLocal } = await import(join(here, "..", "src", "state.ts"));
	const { readPoolHealth, writePoolHealth, withPoolLock, _clearQuotaResetCacheForTests } = await import(join(here, "..", "src", "pool.ts"));
	_clearQuotaResetCacheForTests();
	const { evaluateSlotRecoveryLocked } = await import(join(here, "..", "src", "reconcile.ts"));
	const p = pathsLocal(dir);
	// Seed worker with NO active tasks. ResetFixtureState also cleared all agent records, so this
	// is the only agent in the slot-matching set.
	await seedAgent("worker-d", { activeTaskIds: [] });

	await withPoolLock(p, async () => {
		const h = await readPoolHealth(p);
		h.slots["zai-coding-cn/glm-5.1"] = {
			failures: 0,
			lastBenchReason: "quota",
			benchStreak: 1,
			cooldownUntil: new Date(Date.now() - 1000).toISOString(),
		};
		await writePoolHealth(p, h);
	});

	const fakePi = { registerTool: () => {}, registerCommand: () => {}, on: () => {}, sendMessage: () => {}, exec: async () => ({ code: 0, stdout: "", stderr: "" }) };
	const st = await rsLocal(p, dir);
	const nowMs = Date.now();
	const result = await evaluateSlotRecoveryLocked(fakePi, dir, p, st, nowMs);
	ok("case D: bench expired + no active tasks => 0 emitted", result.emitted === 0, `emitted=${result.emitted}`);
	ok("case D: reason counter includes 'expired_no_tasks'", (result.reasons.expired_no_tasks || 0) >= 1, `reasons=${JSON.stringify(result.reasons)}`);

	const evCount = await countEvents("pool.slot_recovered", p.events);
	ok("case D: NO pool.slot_recovered trace fired", evCount === 0, `count=${evCount}`);
}

// =============================================================================
// CASE E — PI_SWARM_QUOTA_RESET_MS env override when per-slot is absent (B-5)
// =============================================================================
// Critical: PI_SWARM_QUOTA_RESET_MS is read at module-load time. The test MUST:
//   1. Save and DELETE the env var (the existing default is 0).
//   2. Set the env var to a new value.
//   3. Dynamic-import the pool module (cache-busted) so the constants are re-read.
// This mirrors how idle-nudge.test.mjs handles PI_SWARM_MAX_NUDGES.
{
	const envDir = await mkdtemp(join(tmpdir(), "quota-reset-env-"));
	await mkdir(join(envDir, ".pi"), { recursive: true });
	// No quotaResetMs in per-slot config — env var should provide the floor.
	await writeFile(join(envDir, ".pi", "settings.json"), JSON.stringify({
		swarm: {
			defaultModel: "glm-5.1",
			defaultProvider: "zai-coding-cn",
			modelPool: [
				{ model: "glm-5.1", provider: "zai-coding-cn", weight: 50 },
				{ model: "gpt-5.4-mini", provider: "openai", weight: 30 },
			],
			rotation: { strategy: "weighted", cooldownMs: 900_000, maxRetries: 2 },
		},
	}));
	process.chdir(envDir);

	// Save and reset env vars for the duration of this case.
	const savedEnv = process.env.PI_SWARM_QUOTA_RESET_MS;
	delete process.env.PI_SWARM_QUOTA_RESET_MS;
	process.env.PI_SWARM_QUOTA_RESET_MS = "3600000"; // 1h

	// Re-import pool.ts with a cache-busting query so the module re-reads env at module-load.
	const poolEnv = await loadPoolFresh();
	const { paths: pathsLocal, readState: rsLocal, writeState: wsLocal } = await import(join(here, "..", "src", "state.ts"));
	const p = pathsLocal(envDir);
	const ts = new Date().toISOString();
	const st = await rsLocal(p, envDir);
	st.agents["worker-e"] = {
		id: "worker-e", role: "worker", roleKind: "worker", capabilities: [],
		activeTaskIds: [], maxConcurrentTasks: 5,
		status: "running", runtimeStatus: "idle", health: "healthy",
		tmuxSession: "sess", tmuxWindow: "worker-e", tmuxTarget: "sess:worker-e.0",
		model: "glm-5.1", provider: "zai-coding-cn", cwd: envDir,
		mailbox: ".pi/swarm/mailboxes/x.jsonl",
		createdAt: ts, updatedAt: ts,
	};
	await wsLocal(p, st);

	const glmSlot = { model: "glm-5.1", provider: "zai-coding-cn" };
	const { rotation } = poolEnv.effectiveConfig();

	// Direct helper: effectiveBenchMs = max(900_000, 3_600_000) = 3_600_000
	const direct = poolEnv.effectiveBenchMs(glmSlot, rotation, envDir);
	ok("case E: effectiveBenchMs picks up env floor (1h) when per-slot absent", direct === 3_600_000, `got ${direct}`);

	// A SINGLE quota error benches for ~1h (no exponential amplification on first strike).
	const before = Date.now();
	await poolEnv.recordProviderError(p, glmSlot, "quota", "Error 429: exceeded your current quota");
	const h = await poolEnv.readPoolHealth(p);
	const glmHealth = h.slots[poolEnv.slotKey(glmSlot)];
	const benchMs = new Date(glmHealth.cooldownUntil).getTime() - before;
	ok("case E: env floor produces ~1h bench (3_600_000ms ± tolerance)", benchMs >= 3_599_500 && benchMs <= 3_600_500, `benchMs=${benchMs}`);

	// Per-slot value wins when set (env override only when per-slot is absent/0).
	const glmSlotWithQuota = { model: "glm-5.1", provider: "zai-coding-cn", quotaResetMs: 86_400_000 };
	const directWithSlot = poolEnv.effectiveBenchMs(glmSlotWithQuota, rotation, envDir);
	ok("case E: per-slot quotaResetMs wins over env (24h > 1h)", directWithSlot === 86_400_000, `got ${directWithSlot}`);

	// Restore env.
	if (savedEnv === undefined) delete process.env.PI_SWARM_QUOTA_RESET_MS;
	else process.env.PI_SWARM_QUOTA_RESET_MS = savedEnv;

	// Cleanup this scratch dir.
	process.chdir(dir);
	await rm(envDir, { recursive: true, force: true }).catch(() => {});
}

// =============================================================================
// CASE F — lastBenchReason stamped on every bench; auth-bench NOT a recovery candidate
// =============================================================================
{
	await resetFixtureState();
	await seedSettings([
		{ model: "glm-5.1", provider: "zai-coding-cn", weight: 50, quotaResetMs: 86_400_000 },
		{ model: "gpt-5.4-mini", provider: "openai", weight: 30 },
	]);
	process.chdir(dir);
	const { paths: pathsLocal, readState: rsLocal } = await import(join(here, "..", "src", "state.ts"));
	const { readPoolHealth, writePoolHealth, recordProviderError, withPoolLock, _clearQuotaResetCacheForTests } = await import(join(here, "..", "src", "pool.ts"));
	_clearQuotaResetCacheForTests();
	const { evaluateSlotRecoveryLocked } = await import(join(here, "..", "src", "reconcile.ts"));
	const p = pathsLocal(dir);
	await seedAgent("worker-f", { activeTaskIds: ["task-3"] });

	// Stamp an AUTH bench with cooldownUntil in the past + active agent — should NOT emit
	// recovery (auth benches don't self-heal on a known reset window).
	await withPoolLock(p, async () => {
		const h = await readPoolHealth(p);
		h.slots["zai-coding-cn/glm-5.1"] = {
			failures: 0,
			lastBenchReason: "auth",
			benchStreak: 1,
			cooldownUntil: new Date(Date.now() - 1000).toISOString(),
		};
		await writePoolHealth(p, h);
	});
	const fakePi = { registerTool: () => {}, registerCommand: () => {}, on: () => {}, sendMessage: () => {}, exec: async () => ({ code: 0, stdout: "", stderr: "" }) };
	const st = await rsLocal(p, dir);
	const result = await evaluateSlotRecoveryLocked(fakePi, dir, p, st, Date.now());
	ok("case F: auth-bench (lastBenchReason != 'quota') => 0 emitted", result.emitted === 0, `emitted=${result.emitted}`);
	ok("case F: reason counter includes 'not_quota_bench'", (result.reasons.not_quota_bench || 0) >= 1, `reasons=${JSON.stringify(result.reasons)}`);

	// Now overwrite with a quota bench and verify the recovery scan emits.
	await withPoolLock(p, async () => {
		const h = await readPoolHealth(p);
		h.slots["zai-coding-cn/glm-5.1"] = {
			failures: 0,
			lastBenchReason: "quota",
			benchStreak: 1,
			cooldownUntil: new Date(Date.now() - 1000).toISOString(),
		};
		await writePoolHealth(p, h);
	});
	const result2 = await evaluateSlotRecoveryLocked(fakePi, dir, p, st, Date.now());
	ok("case F: quota-bench + active tasks => 1 emitted", result2.emitted === 1, `emitted=${result2.emitted}`);

	// recordProviderError stamps lastBenchReason on every bench. transient errors bench when
	// failures reaches rotation.maxRetries (=2 in this fixture). Use distinct error messages so
	// the 30s dedup window doesn't collapse the strikes.
	const glmSlot = { model: "glm-5.1", provider: "zai-coding-cn" };
	await withPoolLock(p, async () => {
		const h = await readPoolHealth(p);
		delete h.slots["zai-coding-cn/glm-5.1"];
		await writePoolHealth(p, h);
	});
	await recordProviderError(p, glmSlot, "transient", "fetch failed: ECONNREFUSED msg1");
	const h3 = await readPoolHealth(p);
	ok("case F: 1 transient strike (below maxRetries=2) does NOT bench", !h3.slots["zai-coding-cn/glm-5.1"]?.cooldownUntil, `cooldownUntil=${h3.slots["zai-coding-cn/glm-5.1"]?.cooldownUntil}`);
	await recordProviderError(p, glmSlot, "transient", "fetch failed: ETIMEDOUT msg2");
	const h4 = await readPoolHealth(p);
	ok("case F: 2 transient strikes (at maxRetries) benches + stamps lastBenchReason='transient'", h4.slots["zai-coding-cn/glm-5.1"]?.lastBenchReason === "transient", `lastBenchReason=${h4.slots["zai-coding-cn/glm-5.1"]?.lastBenchReason}`);
}

// =============================================================================
// CASE G — B-3: recordSlotSuccess preserves lastBenchReason + benchStreak +
//         lastRecoveredAt. The flow: bench → success → bench → expire must emit
//         slot_recovered for the SECOND bench (not deduped by the first).
// =============================================================================
{
	await resetFixtureState();
	await seedSettings([
		{ model: "glm-5.1", provider: "zai-coding-cn", weight: 50, quotaResetMs: 86_400_000 },
		{ model: "gpt-5.4-mini", provider: "openai", weight: 30 },
	]);
	process.chdir(dir);
	const { paths: pathsLocal, readState: rsLocal } = await import(join(here, "..", "src", "state.ts"));
	const { readPoolHealth, writePoolHealth, recordProviderError, recordSlotSuccess, withPoolLock, _clearQuotaResetCacheForTests } = await import(join(here, "..", "src", "pool.ts"));
	_clearQuotaResetCacheForTests();
	const { evaluateSlotRecoveryLocked } = await import(join(here, "..", "src", "reconcile.ts"));
	const p = pathsLocal(dir);
	await seedAgent("worker-g", { activeTaskIds: ["task-g"] });

	const glmSlot = { model: "glm-5.1", provider: "zai-coding-cn" };
	// 1. Bench on quota.
	await recordProviderError(p, glmSlot, "quota", "Error 429: exceeded your current quota");
	const h1 = await readPoolHealth(p);
	ok("case G step 1: bench stamped", Boolean(h1.slots["zai-coding-cn/glm-5.1"].cooldownUntil));
	ok("case G step 1: lastBenchReason='quota'", h1.slots["zai-coding-cn/glm-5.1"].lastBenchReason === "quota");

	// 2. Success — must preserve lastBenchReason + benchStreak, clear cooldownUntil.
	await recordSlotSuccess(p, glmSlot);
	const h2 = await readPoolHealth(p);
	ok("case G step 2: cooldownUntil cleared after success", !h2.slots["zai-coding-cn/glm-5.1"].cooldownUntil, `cooldownUntil=${h2.slots["zai-coding-cn/glm-5.1"].cooldownUntil}`);
	ok("case G step 2 (B-3): lastBenchReason preserved across success", h2.slots["zai-coding-cn/glm-5.1"].lastBenchReason === "quota", `lastBenchReason=${h2.slots["zai-coding-cn/glm-5.1"].lastBenchReason}`);
	ok("case G step 2 (B-3): benchStreak preserved across success", h2.slots["zai-coding-cn/glm-5.1"].benchStreak === 1, `benchStreak=${h2.slots["zai-coding-cn/glm-5.1"].benchStreak}`);
	ok("case G step 2: failures cleared after success", h2.slots["zai-coding-cn/glm-5.1"].failures === 0, `failures=${h2.slots["zai-coding-cn/glm-5.1"].failures}`);

	// 3. New bench — must stamp a FRESH lastBenchReason + clear lastRecoveredAt (none yet).
	await recordProviderError(p, glmSlot, "quota", "Error 429: exceeded your current quota again");
	const h3 = await readPoolHealth(p);
	ok("case G step 3: bench #2 stamped", Boolean(h3.slots["zai-coding-cn/glm-5.1"].cooldownUntil));
	ok("case G step 3: benchStreak bumped to 2 (was 1, +1)", h3.slots["zai-coding-cn/glm-5.1"].benchStreak === 2, `benchStreak=${h3.slots["zai-coding-cn/glm-5.1"].benchStreak}`);

	// 4. Force cooldown expiry + recovery scan must emit.
	await withPoolLock(p, async () => {
		const h = await readPoolHealth(p);
		h.slots["zai-coding-cn/glm-5.1"].cooldownUntil = new Date(Date.now() - 1000).toISOString();
		delete h.slots["zai-coding-cn/glm-5.1"].lastRecoveredAt;
		await writePoolHealth(p, h);
	});
	const fakePi = { registerTool: () => {}, registerCommand: () => {}, on: () => {}, sendMessage: () => {}, exec: async () => ({ code: 0, stdout: "", stderr: "" }) };
	const st = await rsLocal(p, dir);
	const result = await evaluateSlotRecoveryLocked(fakePi, dir, p, st, Date.now());
	ok("case G step 4: bench #2 expire + active task => emitted", result.emitted >= 1, `emitted=${result.emitted}`);
	// Verify the trace references the second bench (not deduped by stale lastRecoveredAt).
	const events = await readEvents(p.events);
	const recoveredEvents = events.filter((e) => e.event === "pool.slot_recovered");
	ok("case G step 4: pool.slot_recovered events >= 1", recoveredEvents.length >= 1, `count=${recoveredEvents.length}`);
}

// =============================================================================
// CASE H — poolStatus exposes quotaResetMs + quotaAware annotation
// =============================================================================
{
	await resetFixtureState();
	await seedSettings([
		{ model: "glm-5.1", provider: "zai-coding-cn", weight: 50, quotaResetMs: 86_400_000 },
		{ model: "gpt-5.4-mini", provider: "openai", weight: 30 },
		{ model: "claude-sonnet-4", provider: "anthropic", weight: 0 },
	]);
	process.chdir(dir);
	const { poolStatus, _clearQuotaResetCacheForTests } = await import(join(here, "..", "src", "pool.ts"));
	_clearQuotaResetCacheForTests();
	const p = paths(dir);
	const ps = await poolStatus(p);
	const glm = ps.slots.find((s) => s.model === "glm-5.1");
	const gpt = ps.slots.find((s) => s.model === "gpt-5.4-mini");
	const claude = ps.slots.find((s) => s.model === "claude-sonnet-4");
	ok("case H: glm slot exposes quotaResetMs=86_400_000", glm?.quotaResetMs === 86_400_000, `quotaResetMs=${glm?.quotaResetMs}`);
	ok("case H: glm slot is quotaAware (qrMs > cooldownMs)", glm?.quotaAware === true, `quotaAware=${glm?.quotaAware}`);
	ok("case H: gpt slot has quotaResetMs=0 (absent)", gpt?.quotaResetMs === 0, `quotaResetMs=${gpt?.quotaResetMs}`);
	ok("case H: gpt slot is NOT quotaAware (qrMs=0)", gpt?.quotaAware === false, `quotaAware=${gpt?.quotaAware}`);
	ok("case H: claude slot has quotaResetMs=0 (absent)", claude?.quotaResetMs === 0, `quotaResetMs=${claude?.quotaResetMs}`);
}

// =============================================================================
// CASE I — validateSwarmSettings flags bad quotaResetMs
// =============================================================================
{
	await resetFixtureState();
	await seedSettings([
		{ model: "glm-5.1", provider: "zai-coding-cn", weight: 50, quotaResetMs: -1 },
	]);
	process.chdir(dir);
	const { validateSwarmSettings, _clearQuotaResetCacheForTests } = await import(join(here, "..", "src", "pool.ts"));
	_clearQuotaResetCacheForTests();
	const v = validateSwarmSettings(dir);
	ok("case I: validateSwarmSettings flags slot_bad_quota_reset", !v.ok && v.errors.some((e) => e.kind === "slot_bad_quota_reset"), `errors=${JSON.stringify(v.errors.map((e) => e.kind))}`);

	await seedSettings([
		{ model: "glm-5.1", provider: "zai-coding-cn", weight: 50, quotaResetMs: "abc" },
	]);
	const v2 = validateSwarmSettings(dir);
	ok("case I: validateSwarmSettings flags slot_bad_quota_reset (string)", !v2.ok && v2.errors.some((e) => e.kind === "slot_bad_quota_reset"), `errors=${JSON.stringify(v2.errors.map((e) => e.kind))}`);
}

// =============================================================================
// CASE J — recovery trace's benchMs matches the stamped lastBenchMs (regression
//         guard for the typed PoolSlotHealth.lastBenchMs field).
// =============================================================================
{
	await resetFixtureState();
	await seedSettings([
		{ model: "glm-5.1", provider: "zai-coding-cn", weight: 50, quotaResetMs: 86_400_000 },
		{ model: "gpt-5.4-mini", provider: "openai", weight: 30 },
	]);
	process.chdir(dir);
	const { paths: pathsLocal, readState: rsLocal } = await import(join(here, "..", "src", "state.ts"));
	const { readPoolHealth, writePoolHealth, withPoolLock, _clearQuotaResetCacheForTests } = await import(join(here, "..", "src", "pool.ts"));
	_clearQuotaResetCacheForTests();
	const { evaluateSlotRecoveryLocked } = await import(join(here, "..", "src", "reconcile.ts"));
	const p = pathsLocal(dir);
	await seedAgent("worker-j", { activeTaskIds: ["task-j"] });

	// Stamp a quota bench with known lastBenchMs (24h); cooldownUntil in the past.
	const expectedBenchMs = 86_400_000;
	await withPoolLock(p, async () => {
		const h = await readPoolHealth(p);
		h.slots["zai-coding-cn/glm-5.1"] = {
			failures: 0,
			lastBenchReason: "quota",
			lastBenchMs: expectedBenchMs,
			benchStreak: 1,
			cooldownUntil: new Date(Date.now() - 1000).toISOString(),
		};
		await writePoolHealth(p, h);
	});
	const fakePi = { registerTool: () => {}, registerCommand: () => {}, on: () => {}, sendMessage: () => {}, exec: async () => ({ code: 0, stdout: "", stderr: "" }) };
	const st = await rsLocal(p, dir);
	await evaluateSlotRecoveryLocked(fakePi, dir, p, st, Date.now());
	const events = await readEvents(p.events);
	const recovered = events.find((e) => e.event === "pool.slot_recovered");
	ok("case J: recovery trace benchMs matches stamped lastBenchMs", recovered?.benchMs === expectedBenchMs, `got benchMs=${recovered?.benchMs} expected=${expectedBenchMs}`);
}

console.log(`\n${fail === 0 ? "PASS" : "FAIL"}: ${pass} passed, ${fail} failed`);
process.chdir("/");
await rm(dir, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
