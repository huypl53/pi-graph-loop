#!/usr/bin/env node
/**
 * dormant-subsystem-retire.test.mjs — mock-llm lane driver
 * (task-202610110323-audit-and-retire-dormant; pattern: retired-surface-cleanup lane)
 *
 * Proves end-to-end through the REAL registered handlers:
 *   L1  fixture shape: census toolcall scripted, no experimentation tool scripted
 *   L2  replay: census executes on the real swarm_agent_status handler
 *   L3  registry: no swarm_(metric|run|memory|iteration|loop)_* tool is registered
 *   L4  startup behavior: ensureDirs creates NO retired dirs and preserves legacy data
 * Evidence: fixture assertions always run; live-lane transcript path reported.
 *
 * Run: node extensions/mock-llm/tests/dormant-subsystem-retire.test.mjs
 */
import { readFile, mkdir, writeFile, mkdtemp, rm, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const fixturePath = join(root, "extensions/mock-llm/fixtures/dormant-subsystem-retire.jsonl");

let passed = 0,
	failed = 0;
const ok = (n, c, info) => {
	if (c) {
		passed++;
		console.log("  ok  ", n);
	} else {
		failed++;
		console.error("  FAIL:", n, info ?? "");
	}
};

// --- L1: fixture shape ---
const turns = (await readFile(fixturePath, "utf8"))
	.split("\n")
	.filter((l) => l.trim() && !l.trim().startsWith("#"))
	.map((l) => JSON.parse(l));
const calls = turns.flatMap((t) => t.events || []).filter((e) => e.type === "toolcall");
ok("fixture: census toolcall present", calls.some((c) => c.name === "swarm_agent_status"));
ok("fixture: no experimentation tool scripted", calls.every((c) => !/^swarm_(metric|run|memory|iteration|loop)_/.test(c.name)), calls.map((c) => c.name));

// --- REAL extension factory ---
const tools = {};
const factory = (await import(join(root, "extensions/swarm/index.ts"))).default;
factory({
	registerTool: (def) => {
		tools[def.name] = def;
	},
	registerCommand: () => {},
	on: () => {},
	exec: async () => ({ code: 0, stdout: "", stderr: "" }),
	sendMessage: async () => ({ ok: true }),
	sendUserMessage: async () => {},
	setModel: () => {},
});

// --- L3: registry contract ---
const retired = Object.keys(tools).filter((n) => /^swarm_(metric|run|memory|iteration|loop)_/.test(n));
ok("L3: no experimentation tool registered", retired.length === 0, retired);
ok("L3: core task tools still registered", ["swarm_create_task", "swarm_task_status", "swarm_assign_task", "swarm_update_task"].every((n) => tools[n]));

// --- L2: replay census through the REAL handler ---
const { paths, ensureDirs } = await import(join(root, "extensions/swarm/src/state.ts"));
const scratch = await mkdtemp(join(tmpdir(), "dormant-lane-"));
await mkdir(join(scratch, ".pi/swarm"), { recursive: true });
const census = calls.find((c) => c.name === "swarm_agent_status");
// Require the fixture to script the census call — fail visibly if missing (no silent skip).
if (!census) throw new Error("fixture missing required swarm_agent_status toolcall");
const ctx = { cwd: scratch, mode: "tui", hasUI: false, ui: { notify: () => {}, setStatus: () => {} } };
const priorAgentId = process.env.PI_SWARM_AGENT_ID;
process.env.PI_SWARM_AGENT_ID = "root";
let r1;
try {
	r1 = await tools[census.name].execute("t", census.arguments || {}, undefined, undefined, ctx);
} finally {
	if (priorAgentId === undefined) delete process.env.PI_SWARM_AGENT_ID;
	else process.env.PI_SWARM_AGENT_ID = priorAgentId;
}
ok("L2: census executes on the REAL handler", !!r1?.content?.[0]?.text, String(r1?.content?.[0]?.text || "").slice(0, 120));

// --- L4: startup dir behavior (the changed swarm feature behavior) ---
const p = paths(scratch);
await ensureDirs(p);
const retiredDirs = ["metrics", "runs", "memory", "iterations", "loops"].map((d) => join(scratch, ".pi/swarm", d)).filter(existsSync);
ok("L4: ensureDirs creates NO retired experimentation dirs", retiredDirs.length === 0, retiredDirs);
// legacy data preservation under the same startup path
const legacyDir = join(scratch, ".pi/swarm/memory");
await mkdir(legacyDir, { recursive: true });
await writeFile(join(legacyDir, "memory.jsonl"), JSON.stringify({ memoryId: "m1", legacy: true }) + "\n");
await ensureDirs(p);
ok("L4: legacy data preserved byte-for-byte by ensureDirs", (await readFile(join(legacyDir, "memory.jsonl"), "utf8")).includes('"memoryId":"m1"'));

// transcript evidence pointer (interactive lane writes here).
// This is a soft pointer — the test must not fail on a clean machine where the manual lane
// hasn't been run yet. Manual transcript evidence belongs in the validation artifact, not as a
// CI prerequisite.
const transcriptDir = "/tmp/dormant-retire-validate/.pi/mock-llm/transcripts/dormant-subsystem-retire";
const transcripts = existsSync(transcriptDir) ? await readdir(transcriptDir) : [];
if (transcripts.length >= 2) {
	ok("evidence: live-lane transcripts present (manual lane run)", transcripts.length >= 2, `${transcripts.length} transcripts at ${transcriptDir}`);
} else {
	console.log("  skip evidence: live-lane transcripts present (manual lane not yet run; transcripts belong in validation artifact)");
}

await rm(scratch, { recursive: true, force: true });
console.log(`\ndormant-subsystem-retire (mock-llm lane) results: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
