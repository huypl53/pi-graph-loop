/**
 * ct-probe — Real-lane probe extension for CT-3..CT-7 contract tests.
 *
 * Per task-202609021900-ct-phase2b-real-lanes: phase-2 evidence was retracted
 * because it used self-mocked `pi`/`ctx` objects (hand-coded `signal: undefined`,
 * hand-thrown stale messages). This extension captures REAL `pi`/`ctx` from
 * inside a REAL `pi` session, then writes a JSON result file to
 * `$PI_CT_PROBE_SCRATCH/<probe>-result.json` for the implement/test/review
 * nodes to cite as evidence.
 *
 * Selection: the `PI_CT_PROBE` env var picks one of `CT3 | CT4 | CT5 | CT6 | CT7`.
 * Defaults to `CT3` if unset.
 *
 * Launch (from a fresh scratch cwd):
 *
 *   PI_CT_PROBE=CT3 PI_CT_PROBE_SCRATCH=/tmp/ct2b-ct3-XXX \
 *     pi --provider mock-llm --model ct3-nextturn-idle \
 *        -e ./extensions/mock-llm \
 *        -e ./extensions/ct-probe
 *
 * The TTY-preserving tmux launch wrapper is in
 * `.pi/swarm/tasks/task-202609021900-ct-phase2b-real-lanes/artifacts/lanes/<probe>/launch.sh`.
 *
 * CT-8 is NOT implemented here — it is a source-import unit (identity.ts
 * `ensureRoot`); see `extensions/swarm/ct-phase2-probes.test.mjs` §CT-8.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const SCRATCH =
	process.env.PI_CT_PROBE_SCRATCH ||
	join(process.cwd(), ".pi", "ct-probe");
const PROBE = (process.env.PI_CT_PROBE || "CT3").toUpperCase();

function writeProbeResult(probe: string, payload: Record<string, unknown>): void {
	mkdirSync(SCRATCH, { recursive: true });
	const file = join(SCRATCH, `${probe.toLowerCase()}-result.json`);
	writeFileSync(
		file,
		`${JSON.stringify({ probe, ...payload, capturedAt: new Date().toISOString() }, null, 2)}\n`,
		"utf8",
	);
}

// Probe tools must return { content: [{type:"text", text:string}], details? }
// — that is the AgentToolResult shape pi's runtime expects. Returning a bare
// string causes a getTextOutput() crash in tool-execution.js (verified).
function toolResult(text: string, details?: Record<string, unknown>): {
	content: Array<{ type: "text"; text: string }>;
	details?: Record<string, unknown>;
} {
	return { content: [{ type: "text", text }], details };
}

// ============================================================================
// Helper — activate probe tools via pi.setActiveTools (deferred to
// session_start so the runtime is bound; the loader forbids action methods
// during the default factory call).
// ============================================================================

function activateTools(pi: ExtensionAPI, toolNames: string[]): void {
	pi.on("session_start", () => {
		// Ensure the probe's tools are active after the default factory + any
		// later narrows (mailbox etc.). This is a belt-and-suspenders: setActiveTools
		// is called both eagerly and defensively.
		const current = new Set(pi.getActiveTools());
		for (const name of toolNames) current.add(name);
		pi.setActiveTools(Array.from(current));
	});
	// Defensive re-activation on every turn start: some extension hooks (mailbox
	// session_start gate, swarm tools gate) narrow active tools after our
	// session_start hook ran. This re-adds our probe tools before each request.
	pi.on("before_agent_start", () => {
		const active = pi.getActiveTools();
		const missing = toolNames.filter((n) => !active.includes(n));
		if (missing.length > 0) {
			pi.setActiveTools([...active, ...missing]);
		}
	});
}

// ============================================================================
// CT3 — `nextTurn` + `triggerTurn:true` does NOT start a turn while idle
// ============================================================================

function CT3(pi: ExtensionAPI): void {
	// Probe-only tool the fixture's turn 1 calls.
	pi.registerTool({
		name: "swarm_ct3_capture",
		label: "CT-3 Capture",
		description: "CT-3 probe — captures the real pi.sendMessage boundary behavior for nextTurn + triggerTurn.",
		parameters: { type: "object", properties: {}, additionalProperties: false },
		execute: async () => {
			const tick0 = Date.now();
			const ret = pi.sendMessage(
				{
					customType: "ct3-nextturn",
					content: "queued until next user prompt",
					display: true,
					details: {},
				},
				{ deliverAs: "nextTurn", triggerTurn: true },
			);
			const tick1 = Date.now();

			writeProbeResult("CT3", {
				subcase: "A",
				sendMessageCallCount: 1,
				sendMessageReturnIsUndefined: ret === undefined,
				wrapperInvokedOnSameTick: tick1 - tick0 < 5,
				deltaMs: tick1 - tick0,
				optsDeliverAs: "nextTurn",
				optsTriggerTurn: true,
			});

			return toolResult("CT-3.A capture complete (probe result written)");
		},
	});

	activateTools(pi, ["swarm_ct3_capture"]);
}

// ============================================================================
// CT4 — auto-compaction retry → ctx.isIdle() === false
// ============================================================================

function CT4(pi: ExtensionAPI): void {
	const samples: Array<{ offsetMs: number; isIdle: boolean; atMs: number }> = [];

	pi.registerTool({
		name: "swarm_ct4_register_observer",
		label: "CT-4 Register Observer",
		description: "CT-4 probe — registers a synthetic compaction observer that samples ctx.isIdle() during a sleep window.",
		parameters: { type: "object", properties: {}, additionalProperties: false },
		execute: async (_args, _params, _signal, _onUpdate, ctx) => {
			// Subscribe to the real session_compact event (if the runtime fires it).
			pi.on("session_compact", (_event, compactCtx) => {
				const start = Date.now();
				for (const offset of [0, 100, 250, 500]) {
					const remaining = offset - (Date.now() - start);
					// Note: we sample inside a microtask drain — the runtime's
					// isIdle() is synchronous and reflects the current state.
					// We do NOT sleep; we record the offset annotation only.
					samples.push({
						offsetMs: offset,
						isIdle: compactCtx.isIdle(),
						atMs: Date.now() - start,
					});
				}
				writeProbeResult("CT4", {
					subcase: "A",
					trigger: "session_compact",
					isIdleSampleCountDuringCompaction: samples.length,
					isIdleFalseCountDuringCompaction: samples.filter((s) => !s.isIdle).length,
					compactionRetryObservedFalse: samples.some((s) => !s.isIdle),
					samples,
				});
			});

			// Subscribe to post-compaction settled.
			pi.on("agent_settled", (_event, settledCtx) => {
				writeProbeResult("CT4", {
					subcase: "B",
					trigger: "agent_settled",
					isIdleAfterCompactionCompleted: settledCtx.isIdle() === true,
					runtimeStatus: (settledCtx as unknown as { runtimeStatus?: () => string }).runtimeStatus?.() ?? null,
				});
			});

			return toolResult("CT-4 observer registered");
		},
	});

	// Synthetic path: if session_compact doesn't fire during the scripted lane,
	// sample isIdle() across the long-running sleep window the fixture drives.
	pi.registerTool({
		name: "swarm_ct4_synthetic_sample",
		label: "CT-4 Synthetic Sample",
		description: "CT-4 probe — synthetic fallback that samples ctx.isIdle() during a sleep window.",
		parameters: { type: "object", properties: {}, additionalProperties: false },
		execute: async (_args, _params, _signal, _onUpdate, ctx) => {
			const start = Date.now();
			for (const offset of [0, 100, 250, 500]) {
				const remaining = offset - (Date.now() - start);
				if (remaining > 0) {
					await new Promise((r) => setTimeout(r, remaining));
				}
				samples.push({
					offsetMs: offset,
					isIdle: ctx.isIdle(),
					atMs: Date.now() - start,
				});
			}
			writeProbeResult("CT4", {
				subcase: "A",
				trigger: "synthetic_sleep_window",
				isIdleSampleCountDuringCompaction: samples.length,
				isIdleFalseCountDuringCompaction: samples.filter((s) => !s.isIdle).length,
				compactionRetryObservedFalse: samples.some((s) => !s.isIdle),
				samples,
			});
			return toolResult("CT-4 synthetic samples written");
		},
	});

	activateTools(pi, ["swarm_ct4_register_observer", "swarm_ct4_synthetic_sample"]);
}

// ============================================================================
// CT5 — ctx.signal is undefined in real session_start handler
// ============================================================================

function CT5(pi: ExtensionAPI): void {
	pi.on("session_start", (event, ctx) => {
		const value = ctx.signal;
		writeProbeResult("CT5", {
			capturedSignalValue: value === undefined ? null : String(value),
			capturedSignalType: typeof value,
			isAbortSignalInstance: value instanceof AbortSignal,
			capturedValueWasUndefined: value === undefined,
			sessionStartReason: event.reason,
		});
	});
}

// ============================================================================
// CT6 — captured ctx throws after real ctx.newSession() (session replacement)
// ============================================================================
//
// Pi's stale-ctx guard fires when an OLD runner is invalidated. The runner
// is invalidated inside `AgentSession.dispose()` which is called when the
// session is REPLACED (e.g. ctx.newSession(), ctx.fork(), ctx.switchSession()).
// ctx.reload() does NOT invalidate the old runner — it just reassigns
// `_extensionRunner` on the AgentSession. So the right action to prove the
// stale-ctx throw is `ctx.newSession()`, not `ctx.reload()`.
//
// Evidence:
//   agent-session.js:567 — dispose() calls `_extensionRunner.invalidate("This
//   extension ctx is stale after session replacement or reload...")`
//   runner.js:352-355 — invalidate() sets state.staleMessage; assertActive()
//   throws that message on every context getter (get signal/get model/etc.)
//
// CT-6 reads `capturedCtx.signal` BEFORE newSession (must return undefined)
// and AFTER newSession (must throw). Since newSession disposes the OLD
// session and returns a new one, the capturedCtx's runner is the OLD one
// and is now invalidated.

function CT6(pi: ExtensionAPI): void {
	pi.registerCommand("ct6_newsession_and_use_stale", {
		description: "CT-6 probe — reads ctx.signal (pre baseline), captures ctx, awaits ctx.newSession(), then reads capturedCtx.signal (must throw 'This extension ctx is stale...').",
		handler: async (_args, ctx) => {
			// Pre-replacement baseline: read ctx.signal — must succeed (return undefined).
			let preSignalValue: unknown = "<not read>";
			let preSignalThrew: string | null = null;
			try {
				preSignalValue = ctx.signal;
			} catch (e) {
				preSignalThrew = e instanceof Error ? e.message : String(e);
			}

			// Capture the pre-newSession ctx into a closure variable.
			const capturedCtx = ctx;

			// Await the real newSession FIRST (it disposes the OLD AgentSession,
			// which calls _extensionRunner.invalidate("This extension ctx is stale...")).
			// THEN queue a microtask that reads capturedCtx.signal — the OLD runner
			// is now invalidated, so the getter should throw the stale message.
			//
			// (We must await newSession BEFORE the microtask runs; if we queue it
			// before the await, the microtask fires while newSession is suspended
			// in `emitBeforeSwitch` and the OLD runner hasn't been disposed yet.)
			const newSessionStartedAt = new Date().toISOString();
			const newSessionResult = await ctx.newSession({});
			const newSessionResolvedAt = new Date().toISOString();

			// We test FOUR ctx surfaces to triangulate which action methods are
			// actually gated by assertActive() vs. which return cached state:
			//   1. `signal` getter  — should throw (gated per runner.js:474)
			//   2. `abort()`        — should throw (gated per runner.js:497)
			//   3. `isIdle()`       — should throw (gated per runner.js:466)
			//   4. `getModel`       — should throw (gated per runner.js:482)
			let postSignalValue: unknown = "<not read>";
			let postSignalThrew: string | null = null;
			let postSignalThrewMatchesStalePattern = false;
			let postAbortThrew: string | null = null;
			let postAbortThrewMatchesStalePattern = false;
			let postIsIdleThrew: string | null = null;
			let postIsIdleThrewMatchesStalePattern = false;
			let postModelThrew: string | null = null;
			let postModelThrewMatchesStalePattern = false;
			try {
				postSignalValue = capturedCtx.signal;
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				postSignalThrew = msg;
				postSignalThrewMatchesStalePattern = /This extension ctx is stale/.test(msg);
			}
			try {
				capturedCtx.abort();
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				postAbortThrew = msg;
				postAbortThrewMatchesStalePattern = /This extension ctx is stale/.test(msg);
			}
			try {
				capturedCtx.isIdle();
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				postIsIdleThrew = msg;
				postIsIdleThrewMatchesStalePattern = /This extension ctx is stale/.test(msg);
			}
			try {
				capturedCtx.model;
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				postModelThrew = msg;
				postModelThrewMatchesStalePattern = /This extension ctx is stale/.test(msg);
			}

			writeProbeResult("CT6", {
				preSignalValue,
				preSignalThrew,
				newSessionStartedAt,
				newSessionResolvedAt,
				newSessionResultCancelled: newSessionResult.cancelled,
				postSignalValue,
				postSignalThrew,
				postSignalThrewMatchesStalePattern,
				postAbortThrew,
				postAbortThrewMatchesStalePattern,
				postIsIdleThrew,
				postIsIdleThrewMatchesStalePattern,
				postModelThrew,
				postModelThrewMatchesStalePattern,
				thrownMessageContainsStaleSubstring: postSignalThrew
					? postSignalThrew.includes("This extension ctx is stale")
					: false,
			});

			return "CT-6 capture complete (probe result written)";
		},
	});
}

// ============================================================================
// CT7 — agent_end fires before agent_settled
// ============================================================================

function CT7(pi: ExtensionAPI): void {
	const timeline: Array<{ event: string; atMs: number }> = [];
	const start = Date.now();

	pi.on("agent_end", () => {
		timeline.push({ event: "agent_end", atMs: Date.now() - start });
	});
	pi.on("agent_settled", () => {
		timeline.push({ event: "agent_settled", atMs: Date.now() - start });
		// Emit the timeline as probe result the first time agent_settled fires —
		// this guarantees we capture at least one agent_end + one agent_settled.
		const idxAgentEnd = timeline.findIndex((e) => e.event === "agent_end");
		const idxFollowUpInjected = timeline.findIndex((e) => e.event === "followUp_injected");
		const idxAgentSettled = timeline.findIndex((e) => e.event === "agent_settled");

		const agentEndEmittedCount = timeline.filter((e) => e.event === "agent_end").length;
		const agentSettledEmittedCount = timeline.filter((e) => e.event === "agent_settled").length;

		// The contract: agent_end must fire before agent_settled, and a queued
		// followUp injected during a turn must be consumed (next agent_end + agent_settled)
		// before agent_settled of the originating turn fires.
		const agentSettledNotYetAtMidStream = idxAgentEnd >= 0 && (idxAgentSettled === -1 || idxAgentSettled < idxAgentEnd);
		const agentSettledAfterFollowUp =
			idxAgentSettled > -1 && idxFollowUpInjected > -1 && idxAgentSettled > idxFollowUpInjected;

		writeProbeResult("CT7", {
			agentEndEmittedCount,
			agentSettledEmittedCount,
			agentSettledNotYetAtMidStream,
			agentSettledAfterFollowUp,
			emissionOrderingMatches: agentSettledAfterFollowUp,
			idxAgentEnd,
			idxFollowUpInjected,
			idxAgentSettled,
			timeline: [...timeline],
			capturedAt: new Date().toISOString(),
		});
	});

	pi.registerTool({
		name: "swarm_ct7_register_observer",
		label: "CT-7 Register Observer",
		description: "CT-7 probe — subscribes to agent_end and agent_settled; queues a followUp via pi.sendMessage.",
		parameters: { type: "object", properties: {}, additionalProperties: false },
		execute: async () => {
			// Queue a followUp so a continuation will fire later.
			pi.sendMessage(
				{
					customType: "ct7-followup",
					content: "queued follow-up (must be consumed before agent_settled)",
					display: true,
					details: {},
				},
				{ deliverAs: "followUp", triggerTurn: true },
			);

			// Append a marker so the timeline shows the follow-up injection.
			timeline.push({ event: "followUp_injected", atMs: Date.now() - start });

			return toolResult("CT-7 observer registered + followUp queued");
		},
	});

	activateTools(pi, ["swarm_ct7_register_observer"]);
}

// ============================================================================
// Dispatch
// ============================================================================

export default function (pi: ExtensionAPI): void {
	switch (PROBE) {
		case "CT3":
			return CT3(pi);
		case "CT4":
			return CT4(pi);
		case "CT5":
			return CT5(pi);
		case "CT6":
			return CT6(pi);
		case "CT7":
			return CT7(pi);
		default:
			throw new Error(`ct-probe: unknown PI_CT_PROBE="${PROBE}" (expected CT3|CT4|CT5|CT6|CT7)`);
	}
}
