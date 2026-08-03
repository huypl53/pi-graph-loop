/**
 * compact-resume — Auto-continue the in-progress task after compaction.
 *
 * Problem this fixes:
 *   pi auto-compacts when the context window fills up (`reason: "threshold"`)
 *   or when you run `/compact` (`reason: "manual"`). In BOTH of those cases
 *   pi sets `willRetry: false` and just goes idle afterwards — even if the
 *   agent was mid-task. Only `reason: "overflow"` (a hard context-overflow
 *   error caught mid-run) auto-retries. So after an ordinary auto-compact the
 *   agent stops and you have to type "continue" yourself.
 *
 *   Source of truth (dist/core/agent-session.js):
 *     - _checkCompaction: threshold → _runAutoCompaction("threshold", false)
 *     - _runAutoCompaction: after compacting, `if (willRetry) {...} else
 *       return this.agent.hasQueuedMessages();`
 *   i.e. pi only keeps going if a message is already queued.
 *
 *   Delivery differs by trigger:
 *     - threshold compact fires *during* the agent run (isStreaming===true),
 *       so a `deliverAs:"followUp"` message is queued and pi's continuation
 *       loop drains it.
 *     - manual `/compact` fires while idle (isStreaming===false), so we must use
 *       `triggerTurn:true` to actually start a turn — a followUp alone would be
 *       appended with no turn. We branch on `ctx.isIdle()`.
 *
 * How it works (all verified against the source):
 *   The `session_compact` event fires *inside* `_runAutoCompaction`, right
 *   before the `hasQueuedMessages()` check. At that moment the agent run is
 *   still active (`isStreaming === true`, only cleared in `_emitAgentSettled`),
 *   so `pi.sendMessage(msg, { deliverAs: "followUp" })` routes to
 *   `agent.followUp(msg)` — which makes `hasQueuedMessages()` return true, so
 *   pi's own continuation loop (`while (_handlePostAgentRun()) agent.continue()`)
 *   drains the queue and starts a fresh turn. No re-entrancy, no new API — we
 *   just feed one message into pi's existing continuation path.
 *
 *   Empirical hardening: `scripts/compact_resume_followup_probe.ts` queues one
 *   followUp from a `turn_end` hook and confirms pi continues into that queued
 *   turn without any extra user input.
 *
 * Loop safety (the important part):
 *   A naive "always resume after compact" loops forever: after the task is done
 *   the context can still be over threshold, so each agent_end → compact →
 *   resume → agent_end → compact → … To avoid that:
 *     1. Only resume on threshold (overflow already retries; manual is opt-in).
 *     2. Hard cap: at most MAX consecutive resumes since the last REAL user
 *        message (auto-injected messages don't reset the counter).
 *     3. Stop early once a resume turn produced NO tool results — that means the
 *        agent had nothing left to do, so the next compaction shouldn't kick it
 *        again. (Hard cap is the backstop; this is the smart guard.)
 *
 * Config precedence (highest first):
 *   1. Env vars:
 *      PI_COMPACT_RESUME          "0" disables the extension entirely.
 *      PI_COMPACT_RESUME_MANUAL   "1" to ALSO resume after an explicit `/compact`.
 *      PI_COMPACT_RESUME_MAX      max consecutive auto-resumes per real user turn.
 *   2. Project-local `.pi/settings.json`:
 *      {
 *        "extensions": {
 *          "compact-resume": { "enabled": true, "manual": false, "max": 5 }
 *        }
 *      }
 *      A top-level `compactResume` object is also accepted for convenience.
 *   3. Defaults:
 *      enabled=true (intentional: this extension exists to close a project-wide
 *      usability gap), manual=false, max=5.
 *
 * Project-local: loads after the project is trusted. `/reload` hot-reloads.
 */

import { CONFIG_DIR_NAME, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_MAX = 5;

const RESUME_PROMPT =
	"[compact-resume] The conversation was just auto-compacted to free context " +
	"(the compaction summary above records the goal, progress, in-progress work, " +
	"and next steps). If there is unfinished in-progress work, continue it now — " +
	"pick up exactly where you left off and keep going until it's done or you need " +
	"input. If the task is already complete, briefly confirm completion and stop; " +
	"do not invent new, unplanned work.";

type CompactResumeSettings = {
	enabled?: boolean;
	manual?: boolean;
	max?: number;
};

function readSettings(): CompactResumeSettings {
	const file = join(process.cwd(), CONFIG_DIR_NAME, "settings.json");
	if (!existsSync(file)) return {};
	try {
		const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, any>;
		const fromExtensions = raw?.extensions?.["compact-resume"];
		const fromTopLevel = raw?.compactResume;
		const cfg = (fromExtensions && typeof fromExtensions === "object" ? fromExtensions : undefined) ||
			(fromTopLevel && typeof fromTopLevel === "object" ? fromTopLevel : undefined);
		if (!cfg || typeof cfg !== "object") return {};
		return {
			enabled: typeof cfg.enabled === "boolean" ? cfg.enabled : undefined,
			manual: typeof cfg.manual === "boolean" ? cfg.manual : undefined,
			max: typeof cfg.max === "number" && Number.isFinite(cfg.max) ? Math.floor(cfg.max) : undefined,
		};
	} catch {
		return {};
	}
}

function envBool(name: string): boolean | undefined {
	const v = process.env[name];
	if (v === undefined || v === "") return undefined;
	if (v === "1" || v.toLowerCase() === "true") return true;
	if (v === "0" || v.toLowerCase() === "false") return false;
	return undefined;
}

function enabled(settings: CompactResumeSettings): boolean {
	const env = envBool("PI_COMPACT_RESUME");
	if (env !== undefined) return env;
	if (settings.enabled !== undefined) return settings.enabled;
	return true; // on by default, intentionally
}

function resumeManualToo(settings: CompactResumeSettings): boolean {
	const env = envBool("PI_COMPACT_RESUME_MANUAL");
	if (env !== undefined) return env;
	return settings.manual ?? false;
}

function maxResumes(settings: CompactResumeSettings): number {
	const raw = process.env.PI_COMPACT_RESUME_MAX;
	if (raw !== undefined && raw !== "") {
		const n = Number(raw);
		if (Number.isFinite(n) && n >= 0) return Math.floor(n);
	}
	if (settings.max !== undefined && Number.isFinite(settings.max) && settings.max >= 0) return Math.floor(settings.max);
	return DEFAULT_MAX;
}

function isRealUserSource(source: string | undefined): boolean {
	return source === "interactive" || source === "rpc";
}

export default function (pi: ExtensionAPI) {
	const settings = readSettings();
	if (!enabled(settings)) return;

	const max = maxResumes(settings);

	// Per-session counters. Reset on session_start (covers /reload, /fork, resume)
	// and on any genuine user message. A closure is fine here: these are
	// best-effort loop guards, not state the LLM must reconstruct.
	let consecutiveResumes = 0;
	let lastTurnWasResume = false;
	let lastResumeHadToolResults = false;

	const resetBudget = () => {
		consecutiveResumes = 0;
		lastTurnWasResume = false;
		lastResumeHadToolResults = false;
	};

	pi.on("session_start", () => resetBudget());

	// A real human message resets the consecutive-resume budget. Our own injected
	// resume is a custom message (not an `input` event), so it won't reset it.
	pi.on("input", (event) => {
		if (isRealUserSource(event.source)) resetBudget();
	});

	// Remember whether the most recent resume turn actually did tool work.
	pi.on("turn_end", (event) => {
		if (lastTurnWasResume) {
			lastResumeHadToolResults = (event.toolResults?.length ?? 0) > 0;
			lastTurnWasResume = false;
		}
	});

	pi.on("session_compact", (_event, ctx) => {
		const event = _event as {
			reason: "manual" | "threshold" | "overflow";
			willRetry: boolean;
			compactionEntry?: { summary?: string };
		};

		// Only the gap case. Overflow already retries; manual is opt-in.
		if (event.reason === "overflow") return;
		if (event.reason === "manual" && !resumeManualToo(settings)) return;

		// Defensive: never double-trigger when pi is already going to retry.
		if (event.willRetry) return;

		// Smart guard: the previous resume turn did no tool work → task looks done.
		if (consecutiveResumes > 0 && !lastResumeHadToolResults) {
			if (ctx.hasUI) {
				ctx.ui.notify(
					"compact-resume: previous resume did no work — stopping auto-resume to avoid a loop.",
					"info",
				);
			}
			return;
		}

		// Hard cap (0 = unlimited).
		if (max > 0 && consecutiveResumes >= max) {
			if (ctx.hasUI) {
				ctx.ui.notify(
					`compact-resume: reached the cap of ${max} consecutive auto-resumes. ` +
						`Send a message to continue, or raise PI_COMPACT_RESUME_MAX.`,
					"warning",
				);
			}
			return;
		}

		consecutiveResumes++;
		lastTurnWasResume = true;

		// Feed one message into pi's continuation path. The mode depends on whether
		// we're mid-run (threshold: queue a followUp for the continuation loop) or
		// idle (manual /compact: trigger a fresh turn).
		const idle = ctx.isIdle();
		pi.sendMessage(
			{ customType: "compact-resume", content: RESUME_PROMPT, display: true },
			idle ? { triggerTurn: true } : { deliverAs: "followUp" },
		);

		if (ctx.hasUI) {
			ctx.ui.notify(
				`compact-resume: continuing the task after ${event.reason} compaction ` +
					`(${consecutiveResumes}/${max > 0 ? max : "∞"}).`,
				"info",
			);
		}
	});

	pi.registerCommand("compact-resume", {
		description: "Show the compact-resume auto-continue status and config",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;
			const where = `${CONFIG_DIR_NAME}/extensions/compact-resume.ts`;
			ctx.ui.notify(
				[
					`compact-resume: ${enabled(settings) ? "enabled" : "disabled"}`,
					`resume-after-/compact: ${resumeManualToo(settings) ? "on" : "off"}`,
					`max consecutive resumes: ${max > 0 ? max : "∞ (unlimited)"}`,
					`current consecutive resumes this turn: ${consecutiveResumes}`,
					`config precedence: env -> ${CONFIG_DIR_NAME}/settings.json -> defaults`,
					`config knobs: PI_COMPACT_RESUME / _MANUAL / _MAX  (${where})`,
				].join("\n"),
				"info",
			);
		},
	});
}
