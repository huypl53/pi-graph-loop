// === swarm/pool.ts — model pool: weighted rotation + health cooldown + failover picks ===
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { ModelSlot, Paths, PoolHealthState, PoolSlotHealth, ProviderErrorKind, RotationConfig, RotationStrategy } from "./types.ts";
import { POOL_COOLDOWN_MS, POOL_MAX_RETRIES } from "./constants.ts";
import { readSwarmSettings } from "./session.ts";
import { atomicWriteFile, trace } from "./state.ts";

// Health state lives next to swarm-state.json so every swarm process (orchestrator, workers,
// spawned agents) shares one view of which slots are benched.
export function poolHealthFile(p: Paths) {
	return join(p.root, "pool-state.json");
}

export async function readPoolHealth(p: Paths): Promise<PoolHealthState> {
	const file = poolHealthFile(p);
	if (!existsSync(file)) return { slots: {} };
	try {
		const st = JSON.parse(await readFile(file, "utf8")) as PoolHealthState;
		st.slots ||= {};
		st.rrCursor = typeof st.rrCursor === "number" ? st.rrCursor : 0;
		return st;
	} catch {
		return { slots: {} };
	}
}

export async function writePoolHealth(p: Paths, h: PoolHealthState) {
	await atomicWriteFile(poolHealthFile(p), `${JSON.stringify(h, null, 2)}\n`);
}

export function slotKey(slot: Pick<ModelSlot, "model" | "provider">): string {
	return `${slot.provider || "(default)"}/${slot.model}`;
}

export function effectiveConfig(): { slots: ModelSlot[]; rotation: Required<RotationConfig> } {
	const settings = readSwarmSettings();
	const slots = settings.modelPool && settings.modelPool.length ? settings.modelPool : [];
	const r = settings.rotation || {};
	return {
		slots,
		rotation: {
			strategy: (r.strategy || "weighted") as RotationStrategy,
			cooldownMs: r.cooldownMs ?? POOL_COOLDOWN_MS,
			maxRetries: r.maxRetries ?? POOL_MAX_RETRIES,
		},
	};
}

function inCooldown(h: PoolSlotHealth | undefined, nowMs: number): boolean {
	if (!h?.cooldownUntil) return false;
	return new Date(h.cooldownUntil).getTime() > nowMs;
}

function weightedPick<T extends { weight: number }>(items: T[]): T {
	const total = items.reduce((s, i) => s + i.weight, 0);
	let roll = Math.random() * total;
	for (const item of items) {
		roll -= item.weight;
		if (roll <= 0) return item;
	}
	return items[items.length - 1];
}

function stickyIndex(key: string, n: number): number {
	const hash = createHash("sha256").update(key).digest();
	return hash.readUInt32BE(0) % n;
}

export type PickResult = {
	slot: ModelSlot;
	index: number;
	fromPool: true;
	reason: string;
};

// Pick a slot from the pool. Tries: eligible weighted slots (weight>0, not in cooldown) ->
// fallback-only slots (weight=0, not in cooldown) -> any slot at all (all benched: best effort).
// `stickyKey` (agent id) pins sticky strategy; `avoidKey` (the slot that just failed) is deprioritized
// for round-robin so a failover restart doesn't land back on the same benched slot.
export async function pickSlot(p: Paths, opts: { stickyKey?: string; avoidKey?: string } = {}): Promise<PickResult | undefined> {
	const { slots, rotation } = effectiveConfig();
	if (!slots.length) return undefined;
	const h = await readPoolHealth(p);
	const nowMs = Date.now();

	const eligible = slots
		.map((slot, index) => ({ slot, index }))
		.filter(({ slot }) => (slot.weight ?? 1) > 0 && !inCooldown(h.slots[slotKey(slot)], nowMs));
	const fallbacks = slots
		.map((slot, index) => ({ slot, index }))
		.filter(({ slot }) => (slot.weight ?? 1) === 0 && !inCooldown(h.slots[slotKey(slot)], nowMs));

	if (eligible.length) {
		if (rotation.strategy === "sticky" && opts.stickyKey) {
			const { slot, index } = eligible[stickyIndex(opts.stickyKey, eligible.length)];
			return { slot, index, fromPool: true, reason: `sticky(${opts.stickyKey})` };
		}
		if (rotation.strategy === "round-robin") {
			let cursor = ((h.rrCursor ?? 0) % eligible.length + eligible.length) % eligible.length;
			if (opts.avoidKey && eligible.length > 1 && slotKey(eligible[cursor].slot) === opts.avoidKey) {
				cursor = (cursor + 1) % eligible.length;
			}
			h.rrCursor = cursor + 1;
			await writePoolHealth(p, h).catch(() => {});
			const { slot, index } = eligible[cursor];
			return { slot, index, fromPool: true, reason: `round-robin(${cursor})` };
		}
		const { slot, index } = weightedPick(eligible.map((e) => ({ ...e, weight: e.slot.weight ?? 1 })));
		return { slot, index, fromPool: true, reason: `weighted(w=${slot.weight ?? 1})` };
	}

	if (fallbacks.length) {
		const { slot, index } = fallbacks[0];
		return { slot, index, fromPool: true, reason: "fallback-only (all weighted slots benched)" };
	}

	// Everything is in cooldown: return the slot whose cooldown expires soonest rather than failing.
	const soonest = slots
		.map((slot, index) => ({ slot, index, until: new Date(h.slots[slotKey(slot)]?.cooldownUntil || 0).getTime() }))
		.sort((a, b) => a.until - b.until)[0];
	return { slot: soonest.slot, index: soonest.index, fromPool: true, reason: "all slots benched; soonest cooldown" };
}

// Record a failure for a slot. Once consecutive failures reach maxRetries, bench it for cooldownMs
// and reset the counter (so post-cooldown it gets a fresh chance). Returns the new health.
// Record a provider/turn error for a slot (the in-process turn_end hook path). Error KIND drives
// the bench policy: quota/auth bench IMMEDIATELY (retrying will not fix an exhausted quota or a
// bad key); auth benches extra-long (6h floor) because keys do not self-heal; rate_limit/transient
// follow the maxRetries streak before a normal cooldown.
export async function recordProviderError(p: Paths, slot: ModelSlot, kind: ProviderErrorKind, error: string): Promise<PoolSlotHealth> {
	const { rotation } = effectiveConfig();
	const h = await readPoolHealth(p);
	const key = slotKey(slot);
	const prev = h.slots[key] || { failures: 0 };
	const failures = (prev.failures || 0) + 1;
	const next: PoolSlotHealth = { failures, lastError: `${kind}: ${error}`.slice(0, 200), lastErrorAt: new Date().toISOString() };
	const immediate = kind === "quota" || kind === "auth";
	if (failures >= rotation.maxRetries || immediate) {
		const ms = kind === "auth" ? Math.max(rotation.cooldownMs, 6 * 60 * 60_000) : rotation.cooldownMs;
		next.cooldownUntil = new Date(Date.now() + ms).toISOString();
		next.failures = 0; // fresh chance after cooldown
	}
	h.slots[key] = next;
	await writePoolHealth(p, h);
	await trace(p, "pool.slot_failure", { slot: key, failures, kind, error: error.slice(0, 200), cooldownUntil: next.cooldownUntil }).catch(() => {});
	return next;
}

// Record a success: clears the failure streak (a healthy call proves the slot works again).
export async function recordSlotSuccess(p: Paths, slot: ModelSlot): Promise<void> {
	const h = await readPoolHealth(p);
	const key = slotKey(slot);
	const prev = h.slots[key];
	if (!prev || (!prev.failures && !prev.cooldownUntil && !prev.lastError)) return;
	h.slots[key] = { failures: 0 };
	await writePoolHealth(p, h);
	await trace(p, "pool.slot_success", { slot: key }).catch(() => {});
}

// Manual cooldown control for `/swarm pool cooldown <key> <ms|clear>`.
export async function setSlotCooldown(p: Paths, key: string, ms: number | null): Promise<boolean> {
	const h = await readPoolHealth(p);
	const slot = h.slots[key];
	if (!slot && ms === null) return false;
	h.slots[key] = slot || { failures: 0 };
	if (ms === null) delete h.slots[key].cooldownUntil;
	else h.slots[key].cooldownUntil = new Date(Date.now() + ms).toISOString();
	await writePoolHealth(p, h);
	return true;
}

export async function poolStatus(p: Paths): Promise<{ slots: Array<ModelSlot & { key: string; health: PoolSlotHealth | undefined; inCooldown: boolean; cooldownRemainingMs: number }>; rotation: Required<RotationConfig> }> {
	const { slots, rotation } = effectiveConfig();
	const h = await readPoolHealth(p);
	const nowMs = Date.now();
	return {
		rotation,
		slots: slots.map((slot) => {
			const key = slotKey(slot);
			const health = h.slots[key];
			const until = health?.cooldownUntil ? new Date(health.cooldownUntil).getTime() : 0;
			return { ...slot, key, health, inCooldown: until > nowMs, cooldownRemainingMs: Math.max(0, until - nowMs) };
		}),
	};
}
