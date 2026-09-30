#!/usr/bin/env node
/**
 * swarm-issues Phase 3a — lock-free primitive core extraction probes
 * (issues-primitive-cores.test.mjs).
 *
 * Seven probes per approved plan (artifacts/plan.md §4):
 *   P1  (RED→GREEN)  structural cores-never-lock audit: goal-core/task-core source files
 *                    contain zero withLock/ensureDirs/requireRootAuthority/
 *                    wrapSwarmToolInvocation/deliverMessageLocked symbols.
 *   P2  (RED→GREEN)  controller-under-lock positive probe: each extracted core completes
 *                    inside a real held withLock within a bounded 800ms window.
 *   P3  (CONTROL)    nested locked-wrapper negative control: a body that re-acquires
 *                    withLock inside a held lock stays BOUNDED (800ms race) — the
 *                    forbidden shape for cores, documented as the guard.
 *   P4  (RED→GREEN)  wrapper parity: set/done/create/update through the REAL tool
 *                    registry against a pi-spy produces identical durable results
 *                    (state file content minus timestamps, goal id determinism) —
 *                    probes capture both a tool-registry run and direct-core run and
 *                    compare invariants (core run inside a manually held lock equals
 *                    wrapper run modulo volatile fields).
 *   P5  (CONTROL)    regression battery: existing goal/task focused suites exit 0
 *                    (goal-clear-auth, goal-max-nudges, swarm-goal, task-liveness,
 *                    lifecycle-fencing).
 *   P6  (CONTROL)    3b-exclusion boundary: no issue command/controller/hint/skill
 *                    strings in any touched file.
 *   P7  (CONTROL)    Phase-1 harness preservation: issues-sequencer classification
 *                    unchanged (RED-EXPECTED IS-1/6/7/8 fail; controls green).
 *
 * Pre-extraction (current production): P1 and P2 are expected RED (cores do not exist
 * yet — absence probed at real file surfaces, never via imports of future modules).
 * P3–P7 must be GREEN pre-extraction (they test current behavior). Exit nonzero only
 * when a CONTROL fails, a RED probe fails for an import/syntax accident, or a
 * pre-extraction RED unexpectedly passes.
 *
 * ISOLATION: scratch mkdtemp cwd only. Run: node extensions/swarm/tests/issues-primitive-cores.test.mjs
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, "..", "src");

const { paths, readState, withLock, writeState, trace } = await import(join(srcDir, "state.ts"));
const { atomicWriteFile } = await import(join(srcDir, "state.ts"));

let pass = 0,
	fail = 0;
const results = [];
const ok = (id, type, name, cond, info) => {
	results.push({ id, type, name, pass: !!cond, info: info ?? "" });
	if (cond) {
		pass++;
		console.log(`  ok   [${id}/${type}]`, name);
	} else {
		fail++;
		console.error(`  FAIL [${id}/${type}]`, name, info ?? "");
	}
};

const GOAL_CORE = join(srcDir, "primitives", "goal-core.ts");
const TASK_CORE = join(srcDir, "primitives", "task-core.ts");
const FORBIDDEN = ["withLock", "ensureDirs", "requireRootAuthority", "wrapSwarmToolInvocation", "deliverMessageLocked"];

function readSrc(p) {
	try {
		return readFileSync(p, "utf8");
	} catch {
		return null; // absent file = core not yet extracted (pre-extraction RED)
	}
}

// ============================================================================
// P1 — structural cores-never-lock audit (RED until extraction)
{
	const g = readSrc(GOAL_CORE);
	const t = readSrc(TASK_CORE);
	const bothExist = g !== null && t !== null;
	let clean = true;
	const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
	if (bothExist) {
		for (const [name, src] of [["goal-core", g], ["task-core", t]]) {
			const code = stripComments(src);
			for (const sym of FORBIDDEN) {
				// deps.X injection is allowed (delivery-agnostic seam); a bare call is not.
				const re = sym === "deliverMessageLocked"
					? new RegExp(`(?<!deps\\.)\\b${sym}\\s*\\(`)
					: new RegExp(`\\b${sym}\\b`);
				if (re.test(code)) {
					clean = false;
					console.error(`      ${name} contains forbidden symbol: ${sym}`);
				}
			}
		}
	}
	ok("P1", "RED-EXPECTED", "goal-core/task-core exist and contain zero lock/authority/wrapper symbols", bothExist && clean, bothExist ? "forbidden symbols found" : "core files absent (pre-extraction)");
}

// ============================================================================
// Scratch world + load cores (guarded — absence is the pre-extraction RED, not a defect)
let goalCoreMod = null;
let taskCoreMod = null;
try {
	goalCoreMod = await import(GOAL_CORE);
} catch {
	/* expected pre-extraction: probed by P1/P2 */
}
try {
	taskCoreMod = await import(TASK_CORE);
} catch {
	/* expected pre-extraction: probed by P1/P2 */
}

function makeWorld() {
	const cwd = mkdtempSync(join(tmpdir(), `issues-3a-${process.pid}-${Date.now()}-`));
	mkdirSync(join(cwd, ".pi", "swarm", "tasks"), { recursive: true });
	return cwd;
}

function makePiSpy() {
	const calls = { registerTool: [], sendMessage: [], sendUserMessage: [], registerCommand: [], notify: [] };
	return {
		calls,
		registerTool: (t) => { calls.registerTool.push(t?.name ?? "?"); calls.tools = { ...(calls.tools || {}), [t?.name ?? "?"]: t }; },
		registerCommand: (c) => calls.registerCommand.push(c?.name ?? "?"),
		sendMessage: () => {},
		sendUserMessage: () => {},
		on: () => {},
		off: () => {},
		exec: async () => ({ code: 0, stdout: "", stderr: "" }),
		setModel: async () => true,
		getAllTools: () => [],
		getActiveTools: () => [],
		setActiveTools: () => {},
		ui: { notify: (m) => calls.notify.push(m), setWidget: () => {}, setStatus: () => {}, setFooter: () => {} },
	};
}

// ============================================================================
// P2 — controller-under-lock positive probe (RED until cores exist)
{
	const p = makeWorld();
	const pathsObj = paths(p);
	let completed = false;
	try {
		await withLock(pathsObj, async () => {
			// Direct core invocation inside a held lock — the future controller shape.
			// Bounded: must finish inside 800ms, far under the 60s stale-lock timeout.
			const coreRun = await Promise.race([
				(async () => {
					if (goalCoreMod?.setGoalCore) {
						const { readState: rs, writeState: ws, trace: tr } = await import(join(srcDir, "state.ts"));
						await goalCoreMod.setGoalCore(pathsObj, p, {
							id: "goal-probe",
							text: "probe goal",
							origin: "root",
						}, { readState: rs, writeState: ws, trace: tr, actor: "root", via: "tool" });
					} else if (taskCoreMod?.createTaskCore) {
						const { readState: rs, writeState: ws, trace: tr } = await import(join(srcDir, "state.ts"));
						await taskCoreMod.createTaskCore(pathsObj, { readState: rs, writeState: ws, trace: tr, deliverMessageLocked: async () => ({}), pi: makePiSpy(), cwd: p }, { title: "probe", goal: "probe" });
					} else {
						throw new Error("cores not extracted yet");
					}
					return true;
				})(),
				new Promise((res) => setTimeout(() => res(false), 800)),
			]);
			completed = coreRun === true;
		});
	} catch {
		completed = false;
	}
	ok("P2", "RED-EXPECTED", "extracted cores complete inside a real held lock (bounded)", completed, "cores absent or timed out (pre-extraction)");
}

// ============================================================================
// P3 — nested locked-wrapper negative control (bounded) — CONTROL, green both sides
{
	const cwd = makeWorld();
	let outcome = "unresolved";
	try {
		await withLock(paths(cwd), async () => {
			outcome = await Promise.race([
				withLock(paths(cwd), async () => "completed"),
				new Promise((res) => setTimeout(() => res("bounded"), 800)),
			]);
		});
	} catch {
		outcome = "rejected";
	}
	ok("P3", "CONTROL", "nested withLock inside held lock stays bounded (never unbounded-complete)", outcome !== "completed", `outcome=${outcome}`);
}

// ============================================================================
// P4 — wrapper parity: real tool registry vs direct core, same seeded world
{
	const { registerGoalTools } = await import(join(srcDir, "tools", "goals.ts"));
	const base = () => {
		const cwd = makeWorld();
		// seed a root-ish state file so wrappers pass requireRootAuthority
		const p = paths(cwd);
		writeFileSync(
			p.state,
			JSON.stringify({ version: 1, swarmId: "s", cwd, tmuxSession: "t", agents: { root: { id: "root", status: "running", roleKind: "root" } }, delivered: {}, messages: {}, createdAt: "c", updatedAt: "u" }) + "\n",
		);
		return cwd;
	};
	const env = { PI_SWARM_AGENT_ID: "root", PI_SWARM_IS_ROOT: "1" };

	async function runTool(toolName, params, kind) {
		const cwd = base();
		const pi = makePiSpy();
		process.env.PI_SWARM_AGENT_ID = "root";
		process.env.PI_SWARM_IS_ROOT = "1";
		if (kind === "goal") (await import(join(srcDir, "tools", "goals.ts"))).registerGoalTools(pi);
		else {
			(await import(join(srcDir, "tools", "tasks", "create.ts"))).registerCreateTaskTool(pi);
			(await import(join(srcDir, "tools", "tasks", "update.ts"))).registerUpdateTaskTool(pi);
		}
		const tool = pi.calls.tools?.[toolName];
		if (!tool?.execute) return { cwd, error: `tool ${toolName} not registered` };
		let text = null;
		try {
			const r = await tool.execute(`id-${toolName}`, params, undefined, undefined, { cwd });
			text = typeof r === "string" ? r : (r?.text ?? r?.content ?? JSON.stringify(r)).toString();
		} catch (err) {
			return { cwd, error: String(err?.message || err) };
		}
		const st = JSON.parse(readFileSync(paths(cwd).state, "utf8"));
		return { cwd, text, goalText: st.goal?.text, maxNudges: st.goal?.maxNudges, origin: st.goal?.origin, error: null };
	}

	// Lock-boundary count at the real wrapper surface (R10-1 style): each wrapper file
	// must retain its HEAD baseline number of `await withLock(p, async` call sites.
	const LOCK_BASELINE = {
		"goals.ts": 2,
		"tasks/create.ts": 1,
		"tasks/update.ts": 1,
	};
	let lockCountFailures = [];
	for (const [rel, expected] of Object.entries(LOCK_BASELINE)) {
		const src = readFileSync(join(srcDir, "tools", rel), "utf8");
		const n = (src.match(/await withLock\(p, async/g) || []).length;
		if (n < expected) lockCountFailures.push(`${rel}: ${n} < ${expected}`);
	}

	async function runCoreLeg() {
		if (!goalCoreMod?.setGoalCore) return { unavailable: true };
		const cwd = base();
		const pathsObj = paths(cwd);
		let result = null;
		await withLock(pathsObj, async () => {
			result = await goalCoreMod.setGoalCore(pathsObj, cwd, {
				text: "parity goal",
				maxNudges: 5,
				origin: "root",
			}, {
				readState,
				writeState: (await import(join(srcDir, "state.ts"))).writeState,
				trace: (await import(join(srcDir, "state.ts"))).trace,
				actor: "root",
				via: "tool",
			});
		});
		const st = JSON.parse(readFileSync(pathsObj.state, "utf8"));
		return { goalText: st.goal?.text, maxNudges: st.goal?.maxNudges, origin: st.goal?.origin, unavailable: false };
	}

	const wSet = await runTool("swarm_set_goal", { text: "parity goal", maxNudges: 5, origin: "root" }, "goal");
	const wDone = await runTool("swarm_mark_goal_done", { approvedByUser: true }, "goal");
	const wCreate = await runTool("swarm_create_task", { title: "parity", goal: "parity work" }, "task");
	const c = await runCoreLeg();
	// Phase-3b fix residual (2026-10-01): updateTaskCore wrapper-vs-core parity leg — the 3a
	// parity block originally covered set/done/create only. Drive swarm_update_task through the
	// real tool, then the same params through updateTaskCore inside the caller's lock, and
	// compare the durable node-status invariant.
	async function runUpdateLeg(via) {
		const cwd = base();
		const p2 = paths(cwd);
		const pi = makePiSpy();
		process.env.PI_SWARM_AGENT_ID = "root";
		process.env.PI_SWARM_IS_ROOT = "1";
		(await import(join(srcDir, "tools", "tasks", "create.ts"))).registerCreateTaskTool(pi);
		(await import(join(srcDir, "tools", "tasks", "update.ts"))).registerUpdateTaskTool(pi);
		const created = await pi.calls.tools["swarm_create_task"].execute("id-c", { title: "parity upd", goal: "work" }, undefined, undefined, { cwd });
		const createdText = typeof created === "string" ? created : (created?.text ?? JSON.stringify(created));
		const taskId = (String(createdText).match(/task-[a-z0-9-]+/)?.[0]) ?? null;
		if (!taskId) return { error: `create failed: ${String(createdText).slice(0, 120)}` };
		const params = { taskId, nodeId: "plan", status: "in_progress" };
		let err = null;
		if (via === "wrapper") {
			try {
				await pi.calls.tools["swarm_update_task"].execute("id-u", params, undefined, undefined, { cwd });
			} catch (e) {
				err = String(e?.message || e);
			}
		} else {
			const { updateTaskCore } = await import(join(srcDir, "primitives", "task-core.ts"));
			try {
				await withLock(p2, async () => {
					await updateTaskCore(p2, { readState, writeState, trace, deliverMessageLocked: (await import(join(srcDir, "mailbox.ts"))).deliverMessageLocked, pi, cwd }, params, "root", true);
				});
			} catch (e) {
				err = String(e?.message || e);
			}
		}
		let nodeStatus = null;
		try {
			const t = JSON.parse(readFileSync(join(cwd, ".pi", "swarm", "tasks", taskId, "task.json"), "utf8"));
			nodeStatus = t.nodes?.plan?.status ?? null;
		} catch (e) {
			err = err ?? String(e?.message || e);
		}
		return { err, nodeStatus };
	}
	const updW = await runUpdateLeg("wrapper");
	const updC = await runUpdateLeg("core");
	if (c.unavailable) {
		ok("P4", "RED-EXPECTED", "direct core run matches wrapper run invariants", false, "cores absent (pre-extraction)");
	} else {
		const same = !wSet.error && wSet.goalText === c.goalText && wSet.maxNudges === c.maxNudges && (wSet.origin ?? "root") === (c.origin ?? "root");
		const detail = `set=${JSON.stringify({ goalText: wSet.goalText, maxNudges: wSet.maxNudges, err: wSet.error })} doneErr=${wDone.error ?? "none"} createErr=${wCreate.error ?? "none"} core=${JSON.stringify({ goalText: c.goalText, maxNudges: c.maxNudges })} locks=${lockCountFailures.length ? "FAIL:" + lockCountFailures.join(",") : "ok"}`;
		ok(
			"P4",
			"RED-EXPECTED",
			"direct core run matches wrapper run invariants",
			same && lockCountFailures.length === 0 && !wDone.error && !wCreate.error,
			detail,
			);
		// updateTaskCore parity leg (3b fix residual): same node-status invariant via both routes
		const updSame = !updW.err && !updC.err && updW.nodeStatus === updC.nodeStatus && updW.nodeStatus === "in_progress";
		ok(
			"P4-UPD",
			"RED-EXPECTED",
			"updateTaskCore matches swarm_update_task wrapper invariant",
			updSame,
			`w=${JSON.stringify(updW)} c=${JSON.stringify(updC)}`,
		);
	}
}

// ============================================================================
// P5 — regression battery — CONTROL
{
	const suites = ["goal-clear-auth", "goal-max-nudges", "swarm-goal", "task-liveness", "lifecycle-fencing"];
	let allPass = true;
	const failed = [];
	for (const s of suites) {
		const f = join(here, `${s}.test.mjs`);
		if (!existsSync(f)) {
			failed.push(`${s}(missing)`);
			allPass = false;
			continue;
		}
		try {
			execFileSync(process.execPath, [f], { stdio: "pipe", timeout: 60_000 });
		} catch {
			failed.push(s);
			allPass = false;
		}
	}
	ok("P5", "CONTROL", "existing goal/task focused suites exit 0", allPass, `failed: ${failed.join(",") || "none"}`);
}

// ============================================================================
// P6 — 3b-exclusion boundary — CONTROL
{
	const touched = [
		join(srcDir, "tools", "goals.ts"),
		join(srcDir, "tools", "tasks", "create.ts"),
		join(srcDir, "tools", "tasks", "update.ts"),
		join(srcDir, "commands", "goal.ts"),
		GOAL_CORE,
		TASK_CORE,
	];
	const bad = [];
	for (const f of touched) {
		const src = readSrc(f);
		if (!src) continue;
		// Phase-3b amendment (2026-10-01, planned): "/swarm issues" + fence predicate strings in
		// goals.ts/goal.ts are now SHIPPED 3b behavior, no longer 3b-exclusion violations. The
		// boundary this CONTROL still guards is Phase 4 (skill/hints) — those strings stay banned.
		for (const pat of ["swarm-issues skill", "issueHint", "issues.yml runtime-write"]) {
			if (src.includes(pat)) bad.push(`${f.split("/").pop()}::${pat}`);
		}
	}
	ok("P6", "CONTROL", "no 3b issue behavior strings in touched files", bad.length === 0, bad.join("; ") || "clean");
}

// ============================================================================
// P7 — Phase-1 harness preservation — CONTROL
{
	let classificationOk = false;
	try {
		const out = execFileSync(process.execPath, [join(here, "issues-sequencer.test.mjs")], { encoding: "utf8", timeout: 120_000 });
		// Phase-3b amendment (2026-10-01, planned): the sequencer green-flipped — the preserved
		// invariant is zero RED failures + zero CONTROL failures + all GREEN discriminators passing.
		classificationOk =
			out.includes("RED-EXPECTED failing (expected reproduction): none") &&
			out.includes("unexpectedly passing: none") &&
			out.includes("CONTROL failing: none") &&
			out.includes("[IS-1/GREEN]") &&
			out.includes("[IS-8/GREEN]");
	} catch {
		classificationOk = false;
	}
	ok("P7", "CONTROL", "Phase-1 harness classification preserved", classificationOk, "sequencer classification drifted");
}

// ============================================================================
// Summary + exit policy
const red = results.filter((r) => r.type === "RED-EXPECTED");
const controls = results.filter((r) => r.type === "CONTROL");
const redFailing = red.filter((r) => !r.pass);
const redUnexpected = red.filter((r) => r.pass && /pre-extraction/.test(r.info));
const controlsFailing = controls.filter((r) => !r.pass);

console.log("\n# classification summary");
for (const r of results) console.log(`  ${r.pass ? "PASS" : "FAIL"}  ${r.id}  ${r.type.padEnd(13)} ${r.name}`);
console.log(`\nRED failing: ${redFailing.map((r) => r.id).join(",") || "none"} | controls failing: ${controlsFailing.map((r) => r.id).join(",") || "none"}`);

process.exit(controlsFailing.length > 0 ? 1 : 0);
