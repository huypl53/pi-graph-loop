// === swarm/nudges/loop-detect.ts — read-streak guard v1.1 (task loop-read-streak-guard) ===
// Detects an agent burning consecutive native-READ tool calls (read/grep/find/ls ONLY — every
// other tool, bash included, is OTHER and resets the whole streak, fail-closed) and self-nudges
// the looping agent mid-run via the turn_end custom_message continuation (delivery contract
// §10 F-BUSY-NUDGE, VERIFIED by r10-1-busy-nudge-probe.test.mjs).
//
// Design (plan §1 Phase 3, IDEAS §7 v1.1 — user-locked):
// - Milestone k (k=1..3) fires only when BOTH gates hold: readCallCount >= 6k AND
//   accumulatedActiveMs >= 5·60_000·k (D1: no tokens in trigger; D6: both gates).
// - Active time = active segments: first READ tool_result of a streak opens a segment;
//   agent_settled freezes the segment into the accumulator; next READ opens a new one (D2).
// - State persisted in the swarm state file keyed `agentId\u0000activeTaskId`; deleted on OTHER
//   tool / task change. Every event re-reads the toggle fresh from the state file (M3).
// - After nudge 3, milestone-4 boundary with streak still unbroken → reconcile to root ONCE per
//   streak (persisted `escalated` flag). No abort, no auto-reassign.
//
// R10-1 (loop-read-streak): the ONLY send is the custom_message/continue object returned from
// the turn_end hook in hooks/turns.ts (the injection site) — this module NEVER imports
// pi.sendMessage / ctx.abort. Escalation goes through deliverMessageLocked (the locked,
// pre-existing sink).

import { createHash, randomUUID } from "node:crypto";
import { LOOP_REPEAT_MAX_NUDGES, READ_STREAK_MAX_NUDGES, loopRepeatCalls, loopRepeatSpanMs, loopRepeatWindowMs, readStreakCalls, readStreakMs } from "../constants.ts";
import { currentAgentId } from "../session.ts";
import { paths, readState, trace, withLock, writeState } from "../state.ts";
import { logSwarmError } from "../errorlog.ts";
import type { LoopRepeatMilestone, LoopRepeatRing, LoopRepeatState, Paths, ReadStreakMilestone, ReadStreakState, SwarmState } from "../types.ts";
import { now } from "../utils.ts";

// Native read-class tools (exact lowercase names). ALL other tools are OTHER (fail-closed).
export const READ_TOOLS: ReadonlySet<string> = new Set(["read", "grep", "find", "ls"]);

export function classifyTool(name: unknown): "read" | "other" {
	return typeof name === "string" && READ_TOOLS.has(name) ? "read" : "other";
}

function streakKey(agentId: string, taskId: string): string {
	return `${agentId}\u0000${taskId}`;
}

export function guardEnabled(st: SwarmState): boolean {
	// Toggle is read fresh from the state object (which every caller re-reads from disk under
	// the state lock) — never cached at import (M3). Absent === ON (default).
	return st.readStreakGuard?.enabled !== false;
}

function freshStreak(agentId: string, taskId: string): ReadStreakState {
	return {
		streakId: randomUUID(),
		agentId,
		taskId,
		readCallCount: 0,
		accumulatedActiveMs: 0,
		segmentStartedAt: null,
		nudges: 0,
		milestones: [],
		escalated: false,
		lastReadAtMs: 0,
	};
}

export type ObserveResult = {
	action: "ignored" | "counted" | "reset";
	milestone?: ReadStreakMilestone;
	/** Milestone-4 boundary escalation (post-nudge-3, once per streak). */
	escalated?: boolean;
	streak: ReadStreakState | null;
};

export type ObserveReadDeps = {
	/** Active task for the observing agent (first activeTaskId or the taskKey override). */
	taskId?: string | null;
	nowMs?: number;
};

/**
 * Observe one completed tool call. READ → count toward the streak; OTHER → delete the streak.
 * Runs under the swarm state lock; toggle re-read fresh (M3). Errors are caught by the hook
 * callers and routed to logSwarmError — this function only throws if the lock itself fails
 * (which the caller must treat as fatal to the observe, never to the tool loop).
 */
export async function observeToolCall(pi: any, cwd: string, toolName: unknown, deps: ObserveReadDeps = {}): Promise<ObserveResult> {
	const agentId = deps.taskId !== undefined ? currentAgentId() : currentAgentId();
	const kind = classifyTool(toolName);
	const p: Paths = paths(cwd);
	const atMs = deps.nowMs ?? Date.now();
	return withLock(p, async () => {
		const st = await readState(p, cwd);
		if (!guardEnabled(st)) return { action: "ignored", streak: null } as ObserveResult;
		const taskId = deps.taskId ?? null;
		if (!agentId || agentId === "guest" || !taskId) return { action: "ignored", streak: null } as ObserveResult;
		const key = streakKey(agentId, taskId);
		// D5: a task/attempt change resets the agent's previous streak (drop stale keys).
		if (st.readStreaks) {
			for (const other of Object.keys(st.readStreaks)) {
				if (other !== key && other.startsWith(`${agentId}\u0000`)) {
					delete st.readStreaks[other];
					await trace(p, "loop_streak.reset", {
						reason: "task_change",
						agentId,
						taskId,
						prevKey: other,
					}).catch(() => {});
				}
			}
		}
		if (kind === "other") {
			const had = st.readStreaks?.[key];
			if (had) {
				delete st.readStreaks![key];
				await trace(p, "loop_streak.reset", {
					reason: "other_tool",
					tool: String(toolName ?? "unknown"),
					agentId,
					taskId,
					streakId: had.streakId,
					readCallCount: had.readCallCount,
				});
				await writeState(p, st);
			}
			return { action: "reset", streak: null } as ObserveResult;
		}
		// READ: open/resume the streak.
		st.readStreaks ||= {};
		let s = st.readStreaks[key];
		if (!s || s.streakId === undefined) {
			s = freshStreak(agentId, taskId);
			st.readStreaks[key] = s;
		}
		// Open the active segment if paused.
		if (s.segmentStartedAt === null || s.segmentStartedAt === undefined) s.segmentStartedAt = atMs;
		s.readCallCount += 1;
		s.lastReadAtMs = atMs;
		// Freeze the open segment into the accumulator before evaluating gates.
		const activeMs = s.accumulatedActiveMs + Math.max(0, atMs - (s.segmentStartedAt ?? atMs));
		const perCall = readStreakCalls();
		const perMs = readStreakMs();
		const firedK = s.milestones.length; // milestones fired so far; next k = firedK + 1
		let milestone: ReadStreakMilestone | undefined;
		if (firedK < READ_STREAK_MAX_NUDGES) {
			const k = firedK + 1;
			if (s.readCallCount >= perCall * k && activeMs >= perMs * k) {
				milestone = { k, atMs, readCallCount: s.readCallCount, accumulatedActiveMs: activeMs };
				s.milestones.push(milestone);
				s.nudges += 1;
				s.milestoneJustFired = milestone;
			}
		} else if (!s.escalated) {
			// Milestone-4 boundary: streak unbroken past nudge cap → reconcile to root ONCE.
			s.escalated = true;
			s.escalatedAt = now();
		}
		s.accumulatedActiveMs = activeMs;
		await writeState(p, st);
		return { action: "counted", milestone, escalated: s.escalated && !milestone, streak: s } as ObserveResult;
	});
}

/**
 * agent_settled: freeze the open active segment into the accumulator (idle gap excluded).
 * Toggle-off → no-op (state untouched).
 */
export async function pauseAtSettled(cwd: string, taskId: string | null, nowMs = Date.now()): Promise<void> {
	const agentId = currentAgentId();
	if (!agentId || agentId === "guest" || !taskId) return;
	const p: Paths = paths(cwd);
	try {
		await withLock(p, async () => {
			const st = await readState(p, cwd);
			if (!guardEnabled(st)) return;
			const s = st.readStreaks?.[streakKey(agentId, taskId)];
			if (!s) return;
			if (s.segmentStartedAt !== null && s.segmentStartedAt !== undefined) {
				s.accumulatedActiveMs += Math.max(0, nowMs - s.segmentStartedAt);
				s.segmentStartedAt = null;
				await writeState(p, st);
			}
		});
	} catch (err) {
		await logSwarmError(cwd, "loop-detect", "pause_at_settled_failed", err, { agentId, taskId });
	}
}

/** Task change resets the streak (T3). */
export async function resetForTaskChange(cwd: string, oldTaskId: string | null, newTaskId: string | null): Promise<void> {
	const agentId = currentAgentId();
	if (!agentId || agentId === "guest") return;
	const p: Paths = paths(cwd);
	try {
		await withLock(p, async () => {
			const st = await readState(p, cwd);
			if (oldTaskId) {
				const key = streakKey(agentId, oldTaskId);
				if (st.readStreaks?.[key]) {
					delete st.readStreaks[key];
				}
			}
			await writeState(p, st);
		});
	} catch (err) {
		await logSwarmError(cwd, "loop-detect", "task_change_reset_failed", err, { agentId, oldTaskId, newTaskId });
	}
}

/** Pure: build the mid-run self-nudge text (self-contained evidence). */
export function buildNudgeText(s: ReadStreakState, m: ReadStreakMilestone, opts: { perCalls: number; perMs: number }): string {
	const activeMinutes = Math.round(m.accumulatedActiveMs / 60_000);
	const minsPerMilestone = Math.round(opts.perMs / 60_000);
	return [
		`[READ-STREAK nudge ${s.nudges}/${READ_STREAK_MAX_NUDGES} — milestone ${m.k}]`,
		`You have made ${m.readCallCount} consecutive read-class tool calls (read/grep/find/ls) across ${activeMinutes} min of active time without a non-read action (bash/edit/write/messages).`,
		`Threshold: ${opts.perCalls} reads per ${minsPerMilestone} active minutes. This is nudge ${s.nudges} of ${READ_STREAK_MAX_NUDGES} for streak ${s.streakId}.`,
		`Before the next read: re-read your task.json + plan, check whether you are stuck in a scan loop, and either act on what you already have (edit/write/bash) or report a blocker to root via swarm_send_message.`,
		`After ${READ_STREAK_MAX_NUDGES} nudges without a reset, root will be reconciled with your streak evidence.`,
	].join("\n");
}

/** Pure: build the one-per-streak root escalation body. */
export function buildEscalationText(s: ReadStreakState): string {
	const ms = s.milestones.map((m) => `k=${m.k}@${m.readCallCount}reads/${Math.round(m.accumulatedActiveMs / 60_000)}min`).join(", ");
	return [
		`[READ-STREAK escalation — agent ${s.agentId}, task ${s.taskId}]`,
		`Streak ${s.streakId} crossed the milestone-4 boundary with ${s.readCallCount} consecutive read-class calls / ${Math.round(s.accumulatedActiveMs / 60_000)} active minutes and no reset (bash/edit/write/messages).`,
		`Milestones: ${ms || "(none recorded)"}; nudges delivered: ${s.nudges}.`,
		`The agent may be loop-locked in read-only scanning. Consider a direct pane nudge, task re-scope, or /swarm attention.`,
	].join(" ");
}

/**
 * turn_end consumption: returns the nudge text to inject when a milestone just fired and
 * clears the transient flag (continuation guard — exactly one continuation per milestone).
 * Returns null when nothing to inject. Runs under the state lock.
 */
export async function consumeTurnEndNudge(cwd: string, taskId: string | null): Promise<{ text: string; milestone: ReadStreakMilestone; streak: ReadStreakState } | null> {
	const agentId = currentAgentId();
	if (!agentId || agentId === "guest" || !taskId) return null;
	const p: Paths = paths(cwd);
	return withLock(p, async () => {
		const st = await readState(p, cwd);
		if (!guardEnabled(st)) return null;
		const s = st.readStreaks?.[streakKey(agentId, taskId)];
		if (!s?.milestoneJustFired) return null;
		const m = s.milestoneJustFired;
		delete s.milestoneJustFired;
		const text = buildNudgeText(s, m, { perCalls: readStreakCalls(), perMs: readStreakMs() });
		await trace(p, "loop_streak.nudge", {
			agentId,
			taskId,
			streakId: s.streakId,
			k: m.k,
			nudge: s.nudges,
			readCallCount: m.readCallCount,
			accumulatedActiveMs: m.accumulatedActiveMs,
		});
		await writeState(p, st);
		return { text, milestone: m, streak: s };
	});
}

/**
 * Milestone-4 escalation check (called from turn_end AFTER the nudge consumption): when the
 * cap is reached and the boundary condition holds, reconcile to root ONCE per streak via the
 * locked deliverMessage path. Idempotent through the persisted `escalated` flag.
 */
export async function maybeEscalateToRoot(pi: any, cwd: string, taskId: string | null): Promise<boolean> {
	const agentId = currentAgentId();
	if (!agentId || agentId === "guest" || !taskId) return false;
	const p: Paths = paths(cwd);
	let escalated = false;
	try {
		await withLock(p, async () => {
			const st = await readState(p, cwd);
			if (!guardEnabled(st)) return;
			const s = st.readStreaks?.[streakKey(agentId, taskId)];
			if (!s || !s.escalated || s.escalatedNotified) return;
			s.escalatedNotified = true;
			await writeState(p, st);
			escalated = true;
		});
		if (!escalated) return false;
		const st = await readState(p, cwd);
		const s = st.readStreaks?.[streakKey(agentId, taskId)];
		if (!s) return false;
		// The ONE legitimate root send: the locked deliverMessage path (existing sink —
		// NOT a new message surface). Idempotency key keeps duplicates out even across
		// process restarts (escalatedNotified guards the fast path).
		const { deliverMessageLocked } = await import("../mailbox.ts");
		const fresh = await readState(p, cwd);
		await deliverMessageLocked(pi, cwd, p, fresh, {
			to: "root",
			body: buildEscalationText(s),
			subject: `[swarm] read-streak escalation: ${agentId} on ${taskId}`,
			priority: "low",
			idempotencyKey: `read-streak-escalation:${s.streakId}`,
		});
		await trace(p, "loop_streak.escalated", { agentId, taskId, streakId: s.streakId, readCallCount: s.readCallCount });
		return true;
	} catch (err) {
		// Roll the notify latch back so a transient delivery failure can retry later — the
		// persisted `escalated` boundary flag itself stays (the boundary WAS crossed).
		if (escalated) {
			try {
				await withLock(p, async () => {
					const st = await readState(p, cwd);
					const s = st.readStreaks?.[streakKey(agentId, taskId)];
					if (s) delete s.escalatedNotified;
					await writeState(p, st);
				});
			} catch (rollbackErr) {
				await logSwarmError(cwd, "loop-detect", "escalation_rollback_failed", rollbackErr, { agentId, taskId });
			}
		}
		await logSwarmError(cwd, "loop-detect", "escalation_failed", err, { agentId, taskId });
		return false;
	}
}

/** Test hook: read the persisted streak (no lock mutation). */
export async function readStreakFor(cwd: string, agentId: string, taskId: string): Promise<ReadStreakState | null> {
	const p: Paths = paths(cwd);
	const st = await readState(p, cwd);
	return st.readStreaks?.[streakKey(agentId, taskId)] ?? null;
}

// ============================================================================
// === Loop-repeat guard v1.2 (task loop-repeat-guard) ===
// ============================================================================
// Detects an agent burning identical bash (or any tool) calls with the same args — the
// 2026-10-12 incident (`p9-dossier-runtime-debug2` polled `sleep 165; tail -1 root.jsonl`
// every ~2m45s for hours). v1.1 read-streak guard is fail-closed on bash (bash = OTHER
// resets the streak), so it cannot catch this. v1.2 adds a parallel detector.
//
// Design (IDEAS §8, v1.2 revision commit 4a2cc39):
// - fp = hash(toolName + normalizedArgs) — NO result-hash. The motivating incident's poll
//   prints a fresh timestamp every iteration, so result-hash would make every fingerprint
//   unique and defeat the detector. Args-identical is the stable signal.
// - Ring per (agent, task, fp): {fp, toolName, normalizedArgs, firstSeenAt, lastSeenAt,
//   count, consecutiveCount}. Other tools do NOT reset the ring (anti-evasion poll→ls→poll)
//   but they DO break consecutiveCount (TDD interleaves edit between test runs).
// - Milestone k (k=1..3) fires only when BOTH gates hold: count >= PI_SWARM_LOOP_REPEAT_CALLS*k
//   AND span(firstSeen→last) >= PI_SWARM_LOOP_REPEAT_SPAN_MS*k. PI_SWARM_LOOP_REPEAT_WINDOW_MS=0
//   disables the time-span gate (lane command only — never in fixtures).
// - After nudge 3, milestone-4 boundary with streak unbroken → reconcile to root ONCE per
//   streak (persisted `escalated` flag). No abort, no auto-reassign.
// - State persisted in swarm state file keyed `agentId\u0000activeTaskId`; deleted on task
//   change. Every event re-reads the toggle fresh from the state file (M3).
// - Toggle shared with v1.1: `readStreakGuard.enabled` (both detectors share the same toggle).
//
// R10-1 (loop-repeat): the ONLY send is the custom_message/continue object returned from
// the turn_end hook in hooks/turns.ts (the injection site) — this module NEVER imports
// pi.sendMessage / ctx.abort. Escalation goes through deliverMessageLocked (the locked,
// pre-existing sink).

/** Normalize tool args to a canonical string for fingerprint hashing. */
function normalizeArgs(args: unknown): string {
	if (args === undefined || args === null) return "";
	if (typeof args === "string") return args;
	try {
		// Sort keys for deterministic hashing regardless of property order.
		const sorted = sortKeysDeep(args);
		return JSON.stringify(sorted);
	} catch {
		return String(args);
	}
}

function sortKeysDeep(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortKeysDeep);
	if (value && typeof value === "object") {
		const obj = value as Record<string, unknown>;
		const sorted: Record<string, unknown> = {};
		for (const k of Object.keys(obj).sort()) sorted[k] = sortKeysDeep(obj[k]);
		return sorted;
	}
	return value;
}

/** Compute the fingerprint hash for a tool call. */
export function computeFingerprint(toolName: string, args: unknown): string {
	const normalized = normalizeArgs(args);
	return createHash("sha256").update(`${toolName}\u0000${normalized}`).digest("hex").slice(0, 16);
}

function freshRepeatStreak(agentId: string, taskId: string): LoopRepeatState {
	return {
		streakId: randomUUID(),
		agentId,
		taskId,
		rings: {},
		nudges: 0,
		milestones: [],
		escalated: false,
	};
}

export type ObserveRepeatResult = {
	action: "ignored" | "counted" | "reset";
	milestone?: LoopRepeatMilestone;
	escalated?: boolean;
	streak: LoopRepeatState | null;
};

export type ObserveRepeatDeps = {
	taskId?: string | null;
	nowMs?: number;
	args?: unknown;
};

/**
 * Observe one completed tool call for the loop-repeat guard. Every tool call updates the
 * ring for its fingerprint; other tools do NOT reset the ring (anti-evasion) but they DO
 * break consecutiveCount (TDD interleaves edit between test runs). Runs under the swarm
 * state lock; toggle re-read fresh (M3). Errors are caught by the hook callers and routed
 * to logSwarmError.
 */
export async function observeRepeat(pi: any, cwd: string, toolName: unknown, deps: ObserveRepeatDeps = {}): Promise<ObserveRepeatResult> {
	const agentId = currentAgentId();
	const name = typeof toolName === "string" ? toolName : "unknown";
	const p: Paths = paths(cwd);
	const atMs = deps.nowMs ?? Date.now();
	return withLock(p, async () => {
		const st = await readState(p, cwd);
		if (!guardEnabled(st)) return { action: "ignored", streak: null } as ObserveRepeatResult;
		const taskId = deps.taskId ?? null;
		if (!agentId || agentId === "guest" || !taskId) return { action: "ignored", streak: null } as ObserveRepeatResult;
		const key = streakKey(agentId, taskId);
		// D5: a task/attempt change resets the agent's previous repeat state (drop stale keys).
		if (st.loopRepeats) {
			for (const other of Object.keys(st.loopRepeats)) {
				if (other !== key && other.startsWith(`${agentId}\u0000`)) {
					delete st.loopRepeats[other];
					await trace(p, "loop_repeat.reset", {
						reason: "task_change",
						agentId,
						taskId,
						prevKey: other,
					}).catch(() => {});
				}
			}
		}
		st.loopRepeats ||= {};
		let s = st.loopRepeats[key];
		if (!s || s.streakId === undefined) {
			s = freshRepeatStreak(agentId, taskId);
			st.loopRepeats[key] = s;
		}
		const fp = computeFingerprint(name, deps.args);
		const normalized = normalizeArgs(deps.args);
		const windowMs = loopRepeatWindowMs();
		// Prune occurrences older than the window cap (60 min default).
		// PI_SWARM_LOOP_REPEAT_WINDOW_MS=0 means "disable window cap" (lane command only).
		const cutoff = windowMs > 0 ? atMs - windowMs : Number.POSITIVE_INFINITY;
		// Update or create the ring for this fingerprint.
		let ring = s.rings[fp];
		if (!ring) {
			ring = {
				fp,
				toolName: name,
				normalizedArgs: normalized,
				firstSeenAt: atMs,
				lastSeenAt: atMs,
				count: 0,
				consecutiveCount: 0,
			};
			s.rings[fp] = ring;
		}
		// If the ring's firstSeenAt is older than the window, reset it (occurrence cap).
		// Skip reset when windowMs is 0 (lane command: disable window cap).
		if (windowMs > 0 && ring.firstSeenAt < cutoff) {
			ring.firstSeenAt = atMs;
			ring.count = 0;
			ring.consecutiveCount = 0;
		}
		ring.count += 1;
		ring.lastSeenAt = atMs;
		ring.consecutiveCount += 1;
		// Break consecutiveCount for all OTHER rings (interleaved tool breaks TDD streak).
		for (const otherFp of Object.keys(s.rings)) {
			if (otherFp !== fp) {
				s.rings[otherFp].consecutiveCount = 0;
			}
		}
		// Evaluate milestone gates.
		const perCall = loopRepeatCalls();
		const perMs = loopRepeatSpanMs();
		const spanMs = ring.lastSeenAt - ring.firstSeenAt;
		const firedK = s.milestones.length;
		let milestone: LoopRepeatMilestone | undefined;
		if (firedK < LOOP_REPEAT_MAX_NUDGES) {
			const k = firedK + 1;
			// AND-gate: count >= perCall*k AND span >= perMs*k.
			// PI_SWARM_LOOP_REPEAT_WINDOW_MS=0 disables the span gate (lane command only).
			const spanOk = windowMs === 0 || spanMs >= perMs * k;
			if (ring.count >= perCall * k && spanOk) {
				milestone = { k, atMs, count: ring.count, spanMs };
				s.milestones.push(milestone);
				s.nudges += 1;
				s.milestoneJustFired = milestone;
			}
		} else if (!s.escalated) {
			// Milestone-4 boundary: streak unbroken past nudge cap → reconcile to root ONCE.
			s.escalated = true;
			s.escalatedAt = now();
		}
		await writeState(p, st);
		return { action: "counted", milestone, escalated: s.escalated && !milestone, streak: s } as ObserveRepeatResult;
	});
}

/** Pure: build the mid-run self-nudge text for the loop-repeat guard. */
export function buildRepeatNudgeText(s: LoopRepeatState, m: LoopRepeatMilestone, ring: LoopRepeatRing, opts: { perCalls: number; perMs: number }): string {
	const spanMinutes = Math.round(m.spanMs / 60_000);
	const minsPerMilestone = Math.round(opts.perMs / 60_000);
	const argsPreview = ring.normalizedArgs.length > 120 ? ring.normalizedArgs.slice(0, 117) + "..." : ring.normalizedArgs;
	return [
		`[LOOP-REPEAT nudge ${s.nudges}/${LOOP_REPEAT_MAX_NUDGES} — milestone ${m.k}]`,
		`You have called \`${ring.toolName}\` with identical args ${m.count} times across ${spanMinutes} min of active time.`,
		`Args: ${argsPreview}`,
		`Threshold: ${opts.perCalls} identical calls per ${minsPerMilestone} active minutes. This is nudge ${s.nudges} of ${LOOP_REPEAT_MAX_NUDGES} for streak ${s.streakId}.`,
		`Before the next identical call: re-read your task.json + plan, check whether you are stuck in a polling loop, and either act on what you already have (edit/write/messages) or report a blocker to root via swarm_send_message.`,
		`After ${LOOP_REPEAT_MAX_NUDGES} nudges without a reset, root will be reconciled with your streak evidence.`,
	].join("\n");
}

/** Pure: build the one-per-streak root escalation body for the loop-repeat guard. */
export function buildRepeatEscalationText(s: LoopRepeatState, ring: LoopRepeatRing): string {
	const ms = s.milestones.map((m) => `k=${m.k}@${m.count}calls/${Math.round(m.spanMs / 60_000)}min`).join(", ");
	const argsPreview = ring.normalizedArgs.length > 120 ? ring.normalizedArgs.slice(0, 117) + "..." : ring.normalizedArgs;
	return [
		`[LOOP-REPEAT escalation — agent ${s.agentId}, task ${s.taskId}]`,
		`Streak ${s.streakId} crossed the milestone-4 boundary with ${ring.count} identical \`${ring.toolName}\` calls / ${Math.round((ring.lastSeenAt - ring.firstSeenAt) / 60_000)} active minutes and no reset.`,
		`Args: ${argsPreview}`,
		`Milestones: ${ms || "(none recorded)"}; nudges delivered: ${s.nudges}.`,
		`The agent may be loop-locked in an identical-call polling loop. Consider a direct pane nudge, task re-scope, or /swarm attention.`,
	].join(" ");
}

/**
 * turn_end consumption for the loop-repeat guard: returns the nudge text to inject when a
 * milestone just fired and clears the transient flag. Returns null when nothing to inject.
 * Runs under the state lock. Arbitration: if BOTH read-streak and loop-repeat have a
 * pending milestone on the same turn_end, the caller (turns.ts) emits exactly ONE
 * continuation and consumes both pending flags.
 */
export async function consumeRepeatTurnEndNudge(cwd: string, taskId: string | null): Promise<{ text: string; milestone: LoopRepeatMilestone; streak: LoopRepeatState; ring: LoopRepeatRing } | null> {
	const agentId = currentAgentId();
	if (!agentId || agentId === "guest" || !taskId) return null;
	const p: Paths = paths(cwd);
	return withLock(p, async () => {
		const st = await readState(p, cwd);
		if (!guardEnabled(st)) return null;
		const s = st.loopRepeats?.[streakKey(agentId, taskId)];
		if (!s?.milestoneJustFired) return null;
		const m = s.milestoneJustFired;
		delete s.milestoneJustFired;
		// Find the ring that triggered this milestone (the one with the highest count at fire time).
		let ring: LoopRepeatRing | undefined;
		let maxCount = -1;
		for (const r of Object.values(s.rings)) {
			if (r.count >= m.count && r.count > maxCount) {
				ring = r;
				maxCount = r.count;
			}
		}
		if (!ring) {
			// Fallback: pick any ring.
			ring = Object.values(s.rings)[0];
		}
		if (!ring) {
			await writeState(p, st);
			return null;
		}
		const text = buildRepeatNudgeText(s, m, ring, { perCalls: loopRepeatCalls(), perMs: loopRepeatSpanMs() });
		await trace(p, "loop_repeat.nudge", {
			agentId,
			taskId,
			streakId: s.streakId,
			k: m.k,
			nudge: s.nudges,
			count: m.count,
			spanMs: m.spanMs,
			fp: ring.fp,
			toolName: ring.toolName,
		});
		await writeState(p, st);
		return { text, milestone: m, streak: s, ring };
	});
}

/**
 * Milestone-4 escalation check for the loop-repeat guard: when the cap is reached and the
 * boundary condition holds, reconcile to root ONCE per streak via the locked deliverMessage
 * path. Idempotent through the persisted `escalatedNotified` flag.
 */
export async function maybeEscalateRepeatToRoot(pi: any, cwd: string, taskId: string | null): Promise<boolean> {
	const agentId = currentAgentId();
	if (!agentId || agentId === "guest" || !taskId) return false;
	const p: Paths = paths(cwd);
	let escalated = false;
	try {
		await withLock(p, async () => {
			const st = await readState(p, cwd);
			if (!guardEnabled(st)) return;
			const s = st.loopRepeats?.[streakKey(agentId, taskId)];
			if (!s || !s.escalated || s.escalatedNotified) return;
			s.escalatedNotified = true;
			await writeState(p, st);
			escalated = true;
		});
		if (!escalated) return false;
		const st = await readState(p, cwd);
		const s = st.loopRepeats?.[streakKey(agentId, taskId)];
		if (!s) return false;
		// Find the ring with the highest count for the escalation body.
		let ring: LoopRepeatRing | undefined;
		let maxCount = -1;
		for (const r of Object.values(s.rings)) {
			if (r.count > maxCount) {
				ring = r;
				maxCount = r.count;
			}
		}
		if (!ring) return false;
		const { deliverMessageLocked } = await import("../mailbox.ts");
		const fresh = await readState(p, cwd);
		await deliverMessageLocked(pi, cwd, p, fresh, {
			to: "root",
			body: buildRepeatEscalationText(s, ring),
			subject: `[swarm] loop-repeat escalation: ${agentId} on ${taskId}`,
			priority: "low",
			idempotencyKey: `loop-repeat-escalation:${s.streakId}`,
		});
		await trace(p, "loop_repeat.escalated", { agentId, taskId, streakId: s.streakId, count: ring.count, fp: ring.fp });
		return true;
	} catch (err) {
		if (escalated) {
			try {
				await withLock(p, async () => {
					const st = await readState(p, cwd);
					const s = st.loopRepeats?.[streakKey(agentId, taskId)];
					if (s) delete s.escalatedNotified;
					await writeState(p, st);
				});
			} catch (rollbackErr) {
				await logSwarmError(cwd, "loop-detect", "repeat_escalation_rollback_failed", rollbackErr, { agentId, taskId });
			}
		}
		await logSwarmError(cwd, "loop-detect", "repeat_escalation_failed", err, { agentId, taskId });
		return false;
	}
}

/** Task change resets the loop-repeat state (T3). */
export async function resetRepeatForTaskChange(cwd: string, oldTaskId: string | null, newTaskId: string | null): Promise<void> {
	const agentId = currentAgentId();
	if (!agentId || agentId === "guest") return;
	const p: Paths = paths(cwd);
	try {
		await withLock(p, async () => {
			const st = await readState(p, cwd);
			if (oldTaskId) {
				const key = streakKey(agentId, oldTaskId);
				if (st.loopRepeats?.[key]) {
					delete st.loopRepeats[key];
				}
			}
			await writeState(p, st);
		});
	} catch (err) {
		await logSwarmError(cwd, "loop-detect", "repeat_task_change_reset_failed", err, { agentId, oldTaskId, newTaskId });
	}
}

/** Test hook: read the persisted loop-repeat state (no lock mutation). */
export async function readRepeatFor(cwd: string, agentId: string, taskId: string): Promise<LoopRepeatState | null> {
	const p: Paths = paths(cwd);
	const st = await readState(p, cwd);
	return st.loopRepeats?.[streakKey(agentId, taskId)] ?? null;
}
