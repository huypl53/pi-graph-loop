#!/usr/bin/env node
/**
 * r10-1-busy-nudge-probe.test.mjs — R10-1 probe for F-BUSY-NUDGE (task loop-read-streak-guard Phase 1).
 *
 * THE PROBE RUNS BEFORE ANY DETECTOR CODE (plan §1 Phase 1 — mandatory order).
 *
 * Claim under probe (pi-runtime-contract.md §10 row F-BUSY-NUDGE, UNPROVEN):
 *   A `turn_end` boundary handler returning `{ entries: [{ type: "custom_message", ... }],
 *   continue: true }` reaches the BUSY agent's model as part of the NEXT model request in the
 *   SAME run — mid-run continuation injection, no agent_settled in between.
 *
 * Probe design (plan §2 acceptance P1–P4):
 *   - P1: a transcript request includes the MID marker AND follows a request that streamed a
 *     scripted `read` toolcall (mid-run, after a toolResult, not post-settle).
 *   - P2: the STOP marker request exists ONLY because of `continue: true` — the turn before it
 *     had stopReason=stop and would have ended the run (control lane ends at 4 requests;
 *     probe lane needs 6 = 4 scripted + 2 continuation requests, exactly-once each).
 *   - P3 (zero-send control): identical fixture, hook injects nothing → ZERO marker
 *     occurrences, request count == 4 scripted turns, zero inject events, exactly 1 settle.
 *   - P4: no agent_settled before the MID marker request fired (timeline ordering), and the
 *     whole probe lane settles exactly once (single run — both continuations stayed in-run).
 *
 * Any FAIL → per plan §1 Phase 1 step 3: HALT before detector code; §10 row flips to FALSE.
 *
 * ISOLATION: runs the REAL pi binary + REAL mock-llm provider in a scratch cwd (live-lane
 * recipe mirrors extensions/mock-llm/tests/goal-escalation-deadpane.test.mjs).
 * PI_READ_STREAK_PROBE_LIVE=0 skips the live lanes (fixture-shape assertions only).
 *
 * Run: node extensions/swarm/tests/r10-1-busy-nudge-probe.test.mjs
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const fixturePath = join(repoRoot, "extensions", "mock-llm", "fixtures", "loop-probe-turnend-continue.jsonl");

let pass = 0;
let fail = 0;
const ok = (name, cond, info) => {
	if (cond) {
		pass++;
		console.log("  ok  ", name);
	} else {
		fail++;
		console.error("  FAIL", name, info !== undefined ? JSON.stringify(info).slice(0, 500) : "");
	}
};

const MARKER_MID = "READ-STREAK-NUDGE-PROBE-MARKER";
const MARKER_STOP = "READ-STREAK-NUDGE-PROBE-STOP-MARKER";
const MARKER_FAMILY = "READ-STREAK-NUDGE-PROBE";
const MODEL = "loop-probe-turnend-continue";

// ============================================================================
// Fixture shape assertions (always run — cheap, deterministic)
// ============================================================================
console.log("== fixture shape ==");
ok("probe fixture exists", existsSync(fixturePath));
const scriptedTurns = existsSync(fixturePath)
	? readFileSync(fixturePath, "utf8")
			.split("\n")
			.filter((l) => l.trim() && !l.startsWith("#"))
			.map((l) => JSON.parse(l))
	: [];
ok("fixture scripts 6 turns (4 control + 2 continuation-consumed)", scriptedTurns.length === 6, { turns: scriptedTurns.length });
ok("turns 1-3 each script one native read toolcall with stopReason toolUse", scriptedTurns.slice(0, 3).every((t) => t.stopReason === "toolUse" && t.events.some((e) => e.type === "toolcall" && e.name === "read")));
ok("turns 4-5 are terminal stops", scriptedTurns.slice(3).every((t) => t.stopReason === "stop"));
ok("fixture contains no markers (markers come from the hook, not the script)", !readFileSync(fixturePath, "utf8").includes(MARKER_FAMILY));

// ============================================================================
// Probe hook extension — written to the scratch cwd, loaded via -e.
// MID injection: exactly once, at the turn_end whose toolResults completed the 2nd scripted
//   read while the turn is still toolUse (mid-run injection point).
// STOP injection: exactly once, at the turn_end whose message stopReason === "stop" — the run
//   would otherwise END there, so a next request can ONLY exist because of continue:true.
// ============================================================================
function probeExtensionSource({ inject }) {
	return `
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const SCRATCH = process.env.PI_READ_STREAK_PROBE_SCRATCH || process.cwd();
const INJECT = ${inject};
const MARKER_MID = ${JSON.stringify(MARKER_MID)};
const MARKER_STOP = ${JSON.stringify(MARKER_STOP)};

const timeline = [];
const start = Date.now();

function record(event, extra = {}) {
	timeline.push({ event, atMs: Date.now() - start, ...extra });
	try {
		writeFileSync(join(SCRATCH, "probe-timeline.json"), JSON.stringify(timeline, null, 2));
	} catch {}
}

export default function (pi) {
	pi.on("tool_result", (event) => {
		record("tool_result", { toolName: event?.toolName });
	});
	pi.on("agent_settled", () => {
		record("agent_settled");
	});
	pi.on("agent_end", () => {
		record("agent_end");
	});
	let readResultsSeen = 0;
	let injectedMid = false;
	let injectedStop = false;
	pi.on("turn_end", async (event) => {
		const toolResults = Array.isArray(event?.toolResults) ? event.toolResults : [];
		readResultsSeen += toolResults.filter((tr) => tr?.toolName === "read").length;
		const stopReason = event?.message?.stopReason;
		if (!INJECT) {
			record("turn_end_no_inject", { readResultsSeen, stopReason });
			return;
		}
		if (!injectedMid && readResultsSeen >= 2 && stopReason === "toolUse") {
			injectedMid = true;
			record("turn_end_inject_mid", { readResultsSeen });
			return {
				entries: [
					{
						type: "custom_message",
						customType: "read-streak-probe",
						content: MARKER_MID + " mid-run nudge: re-check your task and land an increment.",
						display: true,
					},
				],
				continue: true,
			};
		}
		if (!injectedStop && stopReason === "stop") {
			injectedStop = true;
			record("turn_end_inject_stop", { readResultsSeen });
			return {
				entries: [
					{
						type: "custom_message",
						customType: "read-streak-probe",
						content: MARKER_STOP + " stop-boundary nudge: this request exists only because of continue.",
						display: true,
					},
				],
				continue: true,
			};
		}
		record("turn_end_plain", { readResultsSeen, stopReason });
	});
}
`;
}

function runLane(scratch, { inject }) {
	rmSync(scratch, { recursive: true, force: true });
	mkdirSync(join(scratch, "ext"), { recursive: true });
	mkdirSync(join(scratch, "transcripts"), { recursive: true });
	writeFileSync(join(scratch, "ext", "probe-ext.ts"), probeExtensionSource({ inject }));

	const env = { ...process.env };
	env.PI_SWARM_AGENT_ID = "worker-probe";
	delete env.PI_SWARM_IS_ROOT;
	env.PI_MOCK_LLM_TRANSCRIPTS_DIR = join(scratch, "transcripts");
	env.PI_READ_STREAK_PROBE_SCRATCH = scratch;

	const r = spawnSync(
		"pi",
		[
			"-ne",
			"-e",
			join(repoRoot, "extensions/mock-llm"),
			"-e",
			join(scratch, "ext/probe-ext.ts"),
			"--provider",
			"mock-llm",
			"--model",
			MODEL,
			"-p",
			"run the probe lane",
		],
		{ cwd: scratch, env, timeout: 120_000, encoding: "utf8" },
	);
	return r;
}

function readTranscripts(scratch) {
	const dir = join(scratch, "transcripts", MODEL);
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((f) => f.endsWith(".json"))
		.sort()
		.map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")));
}

function requestHasMarker(t, marker) {
	return (t?.request?.messages ?? []).some(
		(m) => m.role === "user" && typeof m.preview === "string" && m.preview.includes(marker),
	);
}

if (process.env.PI_READ_STREAK_PROBE_LIVE === "0") {
	console.log("\n(skipping live lanes — PI_READ_STREAK_PROBE_LIVE=0; fixture-shape assertions only)");
	console.log(`R10-1 BUSY-NUDGE PROBE ${fail === 0 ? "PASS (shape-only)" : "FAIL"} (${fail} failed, ${pass} passed)`);
	process.exit(fail === 0 ? 0 : 1);
}

// ============================================================================
// P3 control lane FIRST (zero-send control): same fixture, hook injects nothing.
// ============================================================================
console.log("\n== P3 control lane (hook returns nothing) ==");
const controlScratch = join(tmpdir(), `read-streak-probe-control-${process.pid}-${Date.now()}`);
const controlRun = runLane(controlScratch, { inject: false });
const controlTranscripts = readTranscripts(controlScratch);
ok("control lane produced transcripts", controlTranscripts.length > 0, { stderr: controlRun.stderr?.slice(0, 300) });
const controlMarkerHits = controlTranscripts.filter((t) => JSON.stringify(t).includes(MARKER_FAMILY)).length;
ok("P3: control transcript contains ZERO marker occurrences", controlMarkerHits === 0, { controlMarkerHits });
const controlRequestCount = controlTranscripts.length;
ok("P3: control request count == 4 scripted turns consumed", controlRequestCount === 4, { controlRequestCount });
const controlTimeline = existsSync(join(controlScratch, "probe-timeline.json"))
	? JSON.parse(readFileSync(join(controlScratch, "probe-timeline.json"), "utf8"))
	: [];
ok("P3: control lane recorded zero inject events", controlTimeline.every((e) => !String(e.event).startsWith("turn_end_inject")), controlTimeline.map((e) => e.event));
ok("P3: control lane settled exactly once", controlTimeline.filter((e) => e.event === "agent_settled").length === 1, controlTimeline.map((e) => e.event));

// ============================================================================
// P1/P2/P4 probe lane: hook injects MID + STOP markers with continue:true.
// ============================================================================
console.log("\n== P1/P2/P4 probe lane (hook injects marker + continue) ==");
const probeScratch = join(tmpdir(), `read-streak-probe-live-${process.pid}-${Date.now()}`);
const probeRun = runLane(probeScratch, { inject: true });
const probeTranscripts = readTranscripts(probeScratch);
ok("probe lane produced transcripts", probeTranscripts.length > 0, { stderr: probeRun.stderr?.slice(0, 300) });
const probeRequestCount = probeTranscripts.length;

// P2 (strong form): the STOP marker reached a model request that would not otherwise exist —
// the turn before it had stopReason=stop and would have ended the run (control ends at 4
// requests; probe runs 5 = the 5th request is the STOP continuation consuming scripted turn 5;
// the MID continuation rides the natural toolUse loop and consumes scripted turn 3).
const stopMarkerTranscript = probeTranscripts.find((t) => requestHasMarker(t, MARKER_STOP)) ?? null;
ok("P2: STOP-boundary marker reached a model request (continuation past a stop)", stopMarkerTranscript !== null);
ok("P2: probe request count == control + 1 (the STOP continuation request)", probeRequestCount === controlRequestCount + 1, {
	probeRequestCount,
	controlRequestCount,
});

// P1: the MID marker transcript follows a request that streamed a read toolcall.
let markerIdx = probeTranscripts.findIndex((t) => requestHasMarker(t, MARKER_MID));
const markerTranscript = markerIdx >= 0 ? probeTranscripts[markerIdx] : null;
ok("P1: probe transcript contains the MID marker", markerTranscript !== null, { probeRequestCount, markerIdx });

let precedingIsReadToolResultTurn = false;
if (markerTranscript !== null && markerIdx > 0) {
	const prev = probeTranscripts[markerIdx - 1];
	// The preceding request must have streamed a read toolcall (toolcall_end for name=read) —
	// meaning the marker request follows a toolResult inside the same run.
	precedingIsReadToolResultTurn = JSON.stringify(prev.events ?? []).includes('"name":"read"');
}
ok("P1: marker request follows a read toolResult request within the same run", precedingIsReadToolResultTurn, { markerIdx });

// P1 (strong form): the marker is in the REQUEST message list with role=user (convertToLlm
// renders custom_message as a user-role message; the marker sits at the front of the content).
const markerInRequestMessages = markerTranscript !== null && requestHasMarker(markerTranscript, MARKER_MID);
ok("P1: marker present in the request message list with role=user", markerInRequestMessages, {
	markerIdx,
	requestMessages: markerTranscript?.request?.messages?.length,
});

// P4: no agent_settled before the MID marker request fired; the whole lane settles exactly
// once (single run — both continuations stayed in-run, never crossing a settle boundary).
const probeTimeline = existsSync(join(probeScratch, "probe-timeline.json"))
	? JSON.parse(readFileSync(join(probeScratch, "probe-timeline.json"), "utf8"))
	: [];
const firstSettled = probeTimeline.find((e) => e.event === "agent_settled");
let markerRequestBeforeSettle = false;
if (markerTranscript !== null && firstSettled) {
	const markerStartedAtMs = Date.parse(markerTranscript.startedAt);
	const laneStartMs = Date.parse(probeTranscripts[0]?.startedAt ?? markerTranscript.startedAt);
	markerRequestBeforeSettle = markerStartedAtMs - laneStartMs <= firstSettled.atMs;
} else if (markerTranscript !== null) {
	markerRequestBeforeSettle = true; // no settle ever recorded — trivially before
}
ok("P4: MID marker request started at or before the first agent_settled (mid-run, not post-settle)", markerRequestBeforeSettle, {
	timeline: probeTimeline.map((e) => e.event),
});
ok("P4: probe lane settled exactly once (both continuations stayed in-run)", probeTimeline.filter((e) => e.event === "agent_settled").length === 1, probeTimeline.map((e) => e.event));
ok("P4: timeline ordering — inject_mid fired before inject_stop fired before settle", (() => {
	const mid = probeTimeline.findIndex((e) => e.event === "turn_end_inject_mid");
	const stop = probeTimeline.findIndex((e) => e.event === "turn_end_inject_stop");
	const settled = probeTimeline.findIndex((e) => e.event === "agent_settled");
	return mid >= 0 && stop > mid && settled > stop;
})(), probeTimeline.map((e) => e.event));

// ============================================================================
// Verdict + §10 evidence pointers
// ============================================================================
const probeVerdict = fail === 0 ? "CONTRACT_CONFIRMED" : "PROBE_FAILED_FLIP_ROW_TO_FALSE";
console.log(`\nProbe verdict: ${probeVerdict}`);
console.log(`Evidence: transcripts at ${join(probeScratch, "transcripts", MODEL)} (keep for §10 F-BUSY-NUDGE row)`);
console.log(`R10-1 BUSY-NUDGE PROBE ${fail === 0 ? "PASS" : "FAIL"} (${fail} failed, ${pass} passed)`);

// Cleanup scratch dirs unless the caller wants the evidence kept.
if (process.env.PI_READ_STREAK_PROBE_KEEP !== "1") {
	rmSync(controlScratch, { recursive: true, force: true });
	rmSync(probeScratch, { recursive: true, force: true });
}
process.exit(fail === 0 ? 0 : 1);
