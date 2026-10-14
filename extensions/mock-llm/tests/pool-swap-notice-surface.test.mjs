#!/usr/bin/env node
/** Real pi + mock-LLM lane for task pool-event-context-leak (contract §10 F30).
 *
 * Seeds a 2-slot pool where slot B is HEALTHY, then feeds a usage-limit (quota) error burst
 * on slot A. The engine-retry gate exhausts on the 2nd strike → in-process swap A→B → the
 * 3rd scripted turn runs on B and completes.
 *
 * THE CONTRACT UNDER TEST (red-first by extensions/swarm/tests/pool-swap-nudge-content.test.mjs):
 *   - the ONLY session message a swap may produce is the continue-note (customType
 *     "swarm-message"); the operator swap warning surfaces via ctx.ui.notify (L3-only);
 *   - therefore NO request transcript may contain a "swarm-pool-event" message, and no
 *     model-visible message may carry the "⚠ Pool:" operator wording;
 *   - the post-swap request must carry the minimal "Continue your current task." note.
 *
 * Run:            node extensions/mock-llm/tests/pool-swap-notice-surface.test.mjs
 *                 (fixture-shape assertions always run offline)
 * Real pi lane:   RUN_POOL_NOTICE_LANE=1 node extensions/mock-llm/tests/pool-swap-notice-surface.test.mjs
 *                 (spawns `pi --provider mock-llm --model pool-swap-notice-surface` in a scratch dir)
 */
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const fixturePath = join(repo, "extensions/mock-llm/fixtures/pool-swap-notice-surface.jsonl");

let pass = 0;
let fail = 0;
const ok = (name, condition, info = "") => {
	if (condition) {
		pass++;
		console.log("  ok  ", name);
	} else {
		fail++;
		console.error("  FAIL", name, info);
	}
};

// ---------- A. Fixture-shape assertions (always run, offline, milliseconds) ----------
{
	const lines = readFileSync(fixturePath, "utf8")
		.split("\n")
		.filter((l) => l.trim() && !l.trim().startsWith("#"));
	const turns = lines.map((l) => JSON.parse(l));
	ok("fixture has 2 scripted turns (strike burst; recovery lives on slot B fixture)", turns.length === 2, `turns=${turns.length}`);
	ok("turn 1 is a quota error strike", turns[0]?.events?.[0]?.type === "error" && turns[0].events[0].status === 429, JSON.stringify(turns[0]?.events?.[0]));
	ok("turn 2 is the second quota strike (engine gate exhausts)", turns[1]?.events?.[0]?.type === "error", JSON.stringify(turns[1]?.events?.[0]));
	ok("slot-B fixture exists (healthy post-swap slot)", existsSync(join(repo, "extensions/mock-llm/fixtures/pool-swap-notice-b.jsonl")));
}

// ---------- B. Real pi lane (opt-in: RUN_POOL_NOTICE_LANE=1) ----------
if (process.env.RUN_POOL_NOTICE_LANE === "1") {
	const scratch = mkdtempSync(join(tmpdir(), "pool-swap-notice-lane-"));
	const transcripts = join(scratch, ".pi/mock-llm/transcripts");
	mkdirSync(join(scratch, ".pi/swarm"), { recursive: true });

	writeFileSync(
		join(scratch, ".pi", "swarm.yml"),
		`modelPool:
  - model: pool-swap-notice-surface
    provider: mock-llm
  - model: pool-swap-notice-b
    provider: mock-llm
rotation:
  strategy: round-robin
`,
	);
	// Slot B healthy (NO bench) → the strike burst performs a NORMAL swap A→B.
	writeFileSync(
		join(scratch, ".pi/swarm", "swarm-state.json"),
		JSON.stringify({
			version: 1,
			swarmId: "pool-notice-lane",
			cwd: scratch,
			tmuxSession: "t",
			agents: {
				root: {
					id: "root",
					agentId: "root",
					roleKind: "root",
					status: "running",
					createdAt: new Date().toISOString(),
				},
			},
			messages: {},
			delivered: {},
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		}),
	);

	const env = {
		...process.env,
		PI_SWARM_AGENT_ID: "root",
		PI_SWARM_IS_ROOT: "1",
		PI_MOCK_LLM_TRANSCRIPTS_DIR: transcripts,
		MOCK_LLM_API_KEY: "mock",
	};
	const run = spawnSync(
		"pi",
		[
			"-ne",
			"-e",
			join(repo, "extensions/mock-llm"),
			"-e",
			join(repo, "extensions/swarm"),
			"--provider",
			"mock-llm",
			"--model",
			"pool-swap-notice-surface",
			"-p",
			"Continue the task after any provider error; report the result.",
		],
		{ cwd: scratch, env, timeout: 120_000, encoding: "utf8" },
	);

	const eventsTxt = existsSync(join(scratch, ".pi/swarm/traces/events.jsonl"))
		? readFileSync(join(scratch, ".pi/swarm/traces/events.jsonl"), "utf8")
		: "";
	const events = eventsTxt
		.split("\n")
		.filter(Boolean)
		.map((l) => {
			try {
				return JSON.parse(l);
			} catch {
				return null;
			}
		})
		.filter(Boolean);

	ok("pi exited 0", run.status === 0, `status=${run.status} stderr=${(run.stderr || "").slice(0, 300)}`);
	const swaps = events.filter((e) => e.event === "pool.swap");
	ok("swap A→B fired in-process", swaps.length >= 1 && swaps.at(-1)?.to === "mock-llm/pool-swap-notice-b", JSON.stringify(swaps.map((e) => [e.from, e.to])));

	// L4 assertions over the REAL model-request transcripts: no pool-event line anywhere.
	let sawPostSwapRequestWithContinueNote = false;
	let sawPoolEventInAnyRequest = false;
	let sawOperatorWordingInAnyRequest = false;
	let requestCount = 0;
	const walkTranscripts = (dir) => {
		let entries = [];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return entries;
		}
		const files = [];
		for (const e of entries) {
			if (e.isDirectory()) files.push(...walkTranscripts(join(dir, e.name)));
			else if (e.name.endsWith(".json")) files.push(join(dir, e.name));
		}
		return files;
	};
	try {
		for (const f of walkTranscripts(transcripts)) {
			let t;
			try {
				t = JSON.parse(readFileSync(f, "utf8"));
			} catch {
				continue;
			}
			const req = JSON.stringify(t.request ?? t);
			requestCount++;
			if (/swarm-pool-event/.test(req)) sawPoolEventInAnyRequest = true;
			if (/⚠ Pool:/.test(req)) sawOperatorWordingInAnyRequest = true;
			const messages = t.request?.messages ?? [];
			const texts = messages
				.filter((m) => m.role === "user")
				.map((m) => {
					const c = m.content ?? m.preview ?? "";
					return typeof c === "string" ? c : JSON.stringify(c);
				});
			if (texts.some((s) => s.includes("Continue your current task") && !s.includes("retrying"))) sawPostSwapRequestWithContinueNote = true;
		}
	} catch (e) {
		console.error("  transcript scan error:", e?.message);
	}
	ok("transcripts captured (slot A + slot B lanes)", requestCount >= 3, `requestCount=${requestCount} dir=${transcripts}`);
	ok("L4: NO swarm-pool-event in any model request", !sawPoolEventInAnyRequest, `scanned=${requestCount}`);
	ok("L4: NO operator ⚠ Pool: wording in any model request", !sawOperatorWordingInAnyRequest, `scanned=${requestCount}`);
	ok("L4: post-swap request carries the continue-note", sawPostSwapRequestWithContinueNote, `scanned=${requestCount}`);

	if (fail === 0) console.log(`\nPASS: ${pass} passed, 0 failed (scratch: ${scratch})`);
	else console.log(`\nFAIL: ${pass} passed, ${fail} failed (scratch: ${scratch})`);
} else {
	console.log(`\nFIXTURE-SHAPE: ${pass} passed, ${fail} failed (offline; set RUN_POOL_NOTICE_LANE=1 for the real pi lane)`);
}
process.exit(fail ? 1 : 0);
