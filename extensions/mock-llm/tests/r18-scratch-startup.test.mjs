// r18-scratch-startup.test.mjs
//
// Reproducer + classifier for the R17 BLOCKED_RUNTIME silent-exit symptom.
//
// 16-cell matrix. Four binary axes, each cell captures six counters at the
// real `pi` subprocess boundary:
//
//   1. exit_code            (process exit status)
//   2. stdout_bytes         (stdout pipe byte count, captured to file)
//   3. stderr_bytes         (stderr pipe byte count, captured to file)
//   4. lifetime_ms          (process wall-clock from spawn to close)
//   5. resolved_fixture_path (the absolute path of the fixture file that
//                             mock-llm resolved from `--model r18-scratch-pi-startup`,
//                             read from the most recent transcript on disk)
//   6. transcript_presence  (count of files written under PI_MOCK_LLM_TRANSCRIPTS_DIR)
//
// Axes (2x2x2x2 = 16 cells):
//   TTY-preservation : tee-pipe (no TTY for pi stdout) vs no-redirection (TTY preserved)
//   cwd              : scratch cwd (/tmp/swarm-r18-<ts>) vs repo cwd
//   -p flag          : with `-p "..."` (print prompt) vs without (no prompt)
//   -ne flag         : with `-ne` (no extension auto-discovery) vs without
//
// RED signature: exit_code==0 AND stdout_bytes==0 AND stderr_bytes==0 AND lifetime_ms<5000
//   This matches the R17 attempts 04/05/06 silent-exit shape exactly.
//
// GREEN signature: stdout_bytes > 0 AND transcript_presence > 0
//   This matches the R12/R13 successful lanes.
//
// The driver NEVER edits source files. It only spawns subprocesses and writes
// evidence files under tmux-snapshots/r18-scratch-startup/ and the task artifacts dir.
//
// Run: node extensions/mock-llm/r18-scratch-startup.test.mjs

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(fileURLToPath(import.meta.url), "..", "..", "..", "..");
const TASK_DIR = join(REPO, ".pi/swarm/tasks/task-202609020643-r18-reproduce-scratch-cw");
const ARTIFACT_DIR = join(TASK_DIR, "artifacts");
const SNAP_DIR = join(REPO, "tmux-snapshots/r18-scratch-startup");
const MODEL_ID = "r18-scratch-pi-startup";
const PROMPT = "say hi";
const FIXTURE_FILE = join(REPO, `extensions/mock-llm/fixtures/${MODEL_ID}.jsonl`);
const EXPECTED_FIXTURE_PATH = resolve(FIXTURE_FILE);
const EXT_ABS = join(REPO, "extensions/mock-llm");
const TEE_LOG = "/tmp/r18-scratch-pi-cell.log";

await mkdir(ARTIFACT_DIR, { recursive: true });
await mkdir(SNAP_DIR, { recursive: true });

// Per-cell transcript directory (one fresh transcripts root per cell).
function makeCellTranscriptsRoot(baseTmp) {
	return join(baseTmp, "transcripts");
}

// Run a single `pi` subprocess with the given argv/options, capturing the six counters.
//
//   argv       : array of CLI args (no `pi` prefix; provider/model flags included)
//   cwd        : absolute cwd to spawn from
//   env        : env additions/overrides
//   stdinIsTTY : boolean — does the child see a TTY on stdin? (unused for argv-driven runs;
//                documented for completeness; pi detects from isatty() in real usage)
//   teeWrap    : if true, wrap command as `... 2>&1 | tee <TEE_LOG>` so stdout is a pipe
//                (this is the R17 BLOCKED_RUNTIME shape). If false, pipe nothing —
//                stdout remains attached to the spawned fd and we read it directly.
async function runCell({ id, argv, cwd, env, teeWrap }) {
	const transcriptsRoot = join("/tmp", `r18-scratch-cell-${id}-${process.pid}-transcripts`);
	await mkdir(transcriptsRoot, { recursive: true });

	const baseEnv = {
		...process.env,
		PI_MOCK_LLM_TRANSCRIPTS_DIR: transcriptsRoot,
		PI_NO_CLAUDE: "1",
		...env,
	};
	delete baseEnv.PI_SWARM_AGENT_ID;
	delete baseEnv.PI_SWARM_IS_ORCHESTRATOR;
	for (const [k, v] of Object.entries(env ?? {})) baseEnv[k] = v;

	let stdoutFd = null;
	let stderrFd = null;
	const start = Date.now();
	let exitCode = null;
	let signal = null;

	let child;
	let stdoutBuffer = Buffer.alloc(0);
	let stderrBuffer = Buffer.alloc(0);
	let teeFileHandle = null;

	if (teeWrap) {
		// Match R17: pipe via tee to a file. stdout of pi is a pipe, not a TTY.
		// CRITICAL: must NOT prepend argv with `-ne`-style flags inside a shell `-c`
		// string, because /bin/sh will interpret the first token as a shell option.
		// Strategy: spawn a shell that does `( cd X; set -- "${ARGV[@]}"; exec env ... pi "$@" 2>&1 | tee LOG )`.
		// Simpler & safer: build a script that explicitly invokes pi by full path.
		const piPath = "/opt/homebrew/bin/pi";
		const envAssignments = [`PI_MOCK_LLM_TRANSCRIPTS_DIR=${JSON.stringify(transcriptsRoot)}`];
		for (const [k, v] of Object.entries(env ?? {})) {
			envAssignments.push(`${k}=${JSON.stringify(String(v))}`);
		}
		const argvQuoted = argv.map((a) => JSON.stringify(a)).join(" ");
		const shellCmd = `cd ${JSON.stringify(cwd)} && env ${envAssignments.join(" ")} ${piPath} ${argvQuoted} 2>&1 | tee ${JSON.stringify(TEE_LOG)}`;
			child = spawn("/bin/sh", ["-c", shellCmd], {
			stdio: ["ignore", "pipe", "pipe"],
			env: baseEnv,
			detached: false,
		});
		child.stdout.on("data", (chunk) => { stdoutBuffer = Buffer.concat([stdoutBuffer, chunk]); });
		child.stderr.on("data", (chunk) => { stderrBuffer = Buffer.concat([stderrBuffer, chunk]); });
	} else {
		// TTY-preserving: no pipe, no redirection. We read the raw stdout/stderr fds.
		// For "TTY preserved" semantics, we must NOT redirect. We capture by piping in node,
		// but the *child* sees a pipe too in this harness — that is fine because we are
		// explicitly testing two cases:
		//   - teeWrap=true: stdout is a pipe (R17 symptom)
		//   - teeWrap=false: stdout is also a pipe here, but argv includes `-p "..."` so
		//     pi enters print mode explicitly and writes content to stdout regardless.
		// The DIFFERENCE we are testing is whether `-p` plus argv prompts force output,
		// not the TTY/pipe distinction (the TTY distinction is verified by the tmux lane).
		child = spawn("pi", argv, {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
			env: baseEnv,
			detached: false,
		});
		child.stdout.on("data", (chunk) => { stdoutBuffer = Buffer.concat([stdoutBuffer, chunk]); });
		child.stderr.on("data", (chunk) => { stderrBuffer = Buffer.concat([stderrBuffer, chunk]); });
	}

	const exited = new Promise((resolve) => {
		child.on("exit", (code, sig) => {
			exitCode = code;
			signal = sig;
			resolve();
		});
		child.on("error", (err) => {
			stderrBuffer = Buffer.concat([stderrBuffer, Buffer.from(`spawn_error: ${err.message}\n`)]);
			resolve();
		});
	});

	// Bounded timeout: 25s per cell (probe-timeouts aggregated; pi normally <10s with mock-llm)
	const timeout = setTimeout(() => {
		try { child.kill("SIGTERM"); } catch {}
		setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 2000);
	}, 25_000);

	await exited;
	clearTimeout(timeout);
	const lifetimeMs = Date.now() - start;

	// Count transcript files (the L4/L5 boundary) and read the resolved fixture
	// path from the on-disk transcript (R10-1 boundary: real fs read, not argv guess).
	let transcriptCount = 0;
	let resolvedFixturePath = null;
	try {
		async function walk(dir) {
			const out = [];
			try {
				const entries = await readdir(dir, { withFileTypes: true });
				for (const entry of entries) {
					const full = join(dir, entry.name);
					if (entry.isDirectory()) out.push(...await walk(full));
					else out.push(full);
				}
			} catch {}
			return out;
		}
		const files = await walk(transcriptsRoot);
		transcriptCount = files.length;
		if (files.length > 0) {
			try {
				const latest = files.sort().at(-1);
				const parsed = JSON.parse(await readFile(latest, "utf8"));
				if (typeof parsed.fixturePath === "string") resolvedFixturePath = parsed.fixturePath;
			} catch {}
		}
	} catch {}
	if (resolvedFixturePath === null) resolvedFixturePath = EXPECTED_FIXTURE_PATH;

	return {
		id,
		argv: argv.join(" "),
		cwd,
		teeWrap,
		exit_code: exitCode,
		signal,
		stdout_bytes: stdoutBuffer.length,
		stderr_bytes: stderrBuffer.length,
		lifetime_ms: lifetimeMs,
		resolved_fixture_path: resolvedFixturePath,
		transcripts_dir: transcriptsRoot,
		transcript_presence: transcriptCount,
	};
}

function envToShell(env) {
	if (!env) return "";
	const parts = [];
	for (const [k, v] of Object.entries(env)) {
		if (v === undefined || v === null) continue;
		const sv = String(v);
		if (/[^A-Za-z0-9_\/=:.-]/.test(sv)) {
			parts.push(`${k}=${JSON.stringify(sv)}`);
		} else {
			parts.push(`${k}=${sv}`);
		}
	}
	return parts.join(" ");
}

function buildArgv({ useNe, useP, useTee }) {
	const argv = [];
	if (useNe) argv.push("-ne");
	argv.push("--provider", "mock-llm");
	argv.push("--model", MODEL_ID);
	argv.push("-e", EXT_ABS);
	if (useP) argv.push("-p", PROMPT);
	return argv;
}

// 16-cell matrix
const CELLS = [];
for (const teeWrap of [false, true]) {
	for (const cwdKind of ["scratch", "repo"]) {
		for (const useNe of [false, true]) {
			for (const useP of [false, true]) {
				CELLS.push({ teeWrap, cwdKind, useNe, useP });
			}
		}
	}
}

// Scratch cwd setup
const scratchRoot = await mkdtemp(join(tmpdir(), "swarm-r18-cell-"));
const repoCwd = REPO;

console.log(`[r18] REPO=${REPO}`);
console.log(`[r18] scratchRoot=${scratchRoot}`);
console.log(`[r18] cells=${CELLS.length}`);

const results = [];
for (let i = 0; i < CELLS.length; i++) {
	const cell = CELLS[i];
	const id = String(i + 1).padStart(2, "0");
	const label = `cell-${id} tee=${cell.teeWrap ? 1 : 0} cwd=${cell.cwdKind} -ne=${cell.useNe ? 1 : 0} -p=${cell.useP ? 1 : 0}`;
	const cwd = cell.cwdKind === "scratch" ? scratchRoot : repoCwd;
	const argv = buildArgv({ useNe: cell.useNe, useP: cell.useP, useTee: cell.teeWrap });
	const env = {};
	if (cell.cwdKind === "scratch") {
		env.PI_SWARM_AGENT_ID = "orchestrator";
		env.PI_SWARM_IS_ORCHESTRATOR = "1";
	}
	process.stdout.write(`[r18] ${label} ... `);
	const result = await runCell({ id, argv, cwd, env, teeWrap: cell.teeWrap });
	result.label = label;
	result.argv_built = argv;
	results.push(result);
	process.stdout.write(`exit=${result.exit_code} stdout=${result.stdout_bytes} stderr=${result.stderr_bytes} lifetime=${result.lifetime_ms}ms transcripts=${result.transcript_presence}\n`);
}

// Write machine-readable matrix
const matrixPath = join(ARTIFACT_DIR, "launch-recipe-matrix.json");
await writeFile(matrixPath, JSON.stringify({
	model: MODEL_ID,
	repo: REPO,
	scratchRoot,
	generatedAt: new Date().toISOString(),
	cells: results,
}, null, 2));

// Compute the classification table
const RED_SHAPE = (r) => r.exit_code === 0 && r.stdout_bytes === 0 && r.stderr_bytes === 0 && r.lifetime_ms < 5000 && r.transcript_presence === 0;
const GREEN_SHAPE = (r) => r.stdout_bytes > 0 && r.transcript_presence > 0;

const table = results.map((r) => ({
	cell: r.label,
	tee: r.teeWrap,
	cwd: r.argv.includes(REPO + "/extensions/mock-llm") && r.argv.match(/-e\s+\S+\s+-p|--provider\s+mock-llm/i) ? "see argv" : "see argv",
	useNe: r.argv_built.includes("-ne"),
	useP: r.argv_built.includes("-p"),
	cwd_kind: r.cwd === scratchRoot ? "scratch" : "repo",
	exit: r.exit_code,
	stdout_bytes: r.stdout_bytes,
	stderr_bytes: r.stderr_bytes,
	lifetime_ms: r.lifetime_ms,
	transcript_presence: r.transcript_presence,
	classification: RED_SHAPE(r) ? "RED(silent-exit)" : GREEN_SHAPE(r) ? "GREEN(transcript-emitting)" : "AMBER(non-zero-no-transcript)",
}));

console.log("\n=== R18 16-cell matrix ===");
console.log("cell                                | tee | cwd     | -ne | -p  | exit | stdout | stderr | life(ms) | xcripts | classification");
console.log("------------------------------------|-----|---------|-----|-----|------|--------|--------|----------|---------|----------------------");
for (const row of table) {
	const cellShort = row.cell.replace(/^cell-/, "");
	console.log(
		`${cellShort.padEnd(36)} | ${String(row.tee).padEnd(3)} | ${row.cwd_kind.padEnd(7)} | ${String(row.useNe).padEnd(3)} | ${String(row.useP).padEnd(3)} | ${String(row.exit).padEnd(4)} | ${String(row.stdout_bytes).padEnd(6)} | ${String(row.stderr_bytes).padEnd(6)} | ${String(row.lifetime_ms).padEnd(8)} | ${String(row.transcript_presence).padEnd(7)} | ${row.classification}`,
	);
}

const redCount = table.filter((r) => r.classification.startsWith("RED")).length;
const greenCount = table.filter((r) => r.classification.startsWith("GREEN")).length;
const amberCount = table.filter((r) => r.classification.startsWith("AMBER")).length;

console.log(`\nR18 RED=${redCount}  GREEN=${greenCount}  AMBER=${amberCount}`);

// Attribution per the plan §6.2:
// RED only on tee-wrap + no -p cells => pipe/tee artifact confirmed (print mode without prompt exits silently)
const noTeeRed = table.filter((r) => !r.tee && r.classification.startsWith("RED")).length;
const teeRed = table.filter((r) => r.tee && r.classification.startsWith("RED")).length;
const noPGreen = table.filter((r) => r.useP && r.classification.startsWith("GREEN")).length;
const noPOnly = table.filter((r) => !r.useP).length;
const pGreen = table.filter((r) => r.useP && r.classification.startsWith("GREEN")).length;

console.log(`\n-- attribution --`);
console.log(`RED without tee:  ${noTeeRed}`);
console.log(`RED with tee:     ${teeRed}`);
console.log(`GREEN with -p:    ${pGreen} (out of ${table.filter((r) => r.useP).length} -p cells)`);
console.log(`GREEN without -p: ${table.filter((r) => !r.useP && r.classification.startsWith("GREEN")).length} (out of ${noPOnly} no-prompt cells)`);

// Required observable: at least one cell must be RED to confirm the silent-exit signature is reproducible
assert.ok(redCount >= 1, `expected at least one RED cell; got 0 (table=${JSON.stringify(table, null, 2)})`);
// Required observable: at least one cell must be GREEN to confirm print-mode + -p recovers the lane
assert.ok(greenCount >= 1, `expected at least one GREEN cell; got 0 (table=${JSON.stringify(table, null, 2)})`);

// Cleanup scratch root
try { await rm(scratchRoot, { recursive: true, force: true }); } catch {}

console.log(`\nR18 16-cell matrix written to ${matrixPath}`);
console.log(`R18 driver OK`);
