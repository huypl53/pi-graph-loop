#!/usr/bin/env node
/**
 * ext-code-stamp — stale-root detection via extension code-generation stamp.
 *
 * Task: task-r-stale-root-code-banner (2026-10-03 incident: a root pi process
 * booted 2026-10-02 15:06 kept serving pre-19c9c35 module code from Node's
 * ESM module cache. Workers spawned by that root had no Role Playbook
 * identity section and no --skill flag — with ZERO warning anywhere.)
 *
 * Reproducing artifact (bug-fixing mandate, 2026-08-31). Observed RED at
 * baseline 783af1c before any src change
 * (/tmp/stamp-val/ext-code-stamp-RED-at-head.log):
 *   - /swarm status output contains no `ext code:` line (the zero-warning symptom)
 *   - claimRootLeader / heartbeatRootLeader leave st.rootLeader.extCodeStamp
 *     undefined (no durable generation record)
 *   - src/stamp.ts does not exist (ERR_MODULE_NOT_FOUND)
 *
 * Green-phase regression suite (permanent, after the src lands):
 *   - both lease writers stamp the CURRENT process generation; heartbeat
 *     rebuild preserves the field (rebuild-drops-fields was the obvious risk)
 *   - determinism: two consecutive computes over the same tree → identical hash
 *   - incident shape: durable stamp differs from disk stamp → verdict STALE
 *   - absent durable stamp → verdict unknown (pre-feature root; never fabricated)
 *   - status surface: `ext code:` line present + bounded, details.extCodeStamp populated
 *   - session_start stale-generation pin: differing durable stamp ⇒ exactly one
 *     ext.stamp.changed-style notify (counted at the real ctx.ui.notify boundary)
 *   - R27-B static import-integrity guard for barrel-touched consumers
 *   - R10-1 boundary counting: real factory + real session_start driven against a
 *     counting stub pi → ZERO pi.sendMessage / ctx.abort / ctx.reload crossings,
 *     NO pi.registerTool growth from session_start
 *   - no-silent-swallow: no bare `catch {}` introduced under extensions/swarm/src
 *   - R1 (task-fu-stamp-digest, redteam F5): same-length in-place content edit with
 *     restored mtime CHANGES the hash (content digest folded alongside size+mtime).
 *     Observed RED at pre-fix HEAD (sameHash:true — metadata-only stamp was blind);
 *     PoC /tmp/rt-guarda/poc-stamp3.mjs ported verbatim.
 *
 * Run: PI_SWARM_AGENT_ID=root PI_SWARM_IS_ROOT=1 node extensions/swarm/tests/ext-code-stamp.test.mjs
 */
import { mkdtempSync, cpSync, existsSync, readFileSync, readdirSync, appendFileSync, writeFileSync, mkdirSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const extRoot = join(repoRoot, "extensions", "swarm");

let pass = 0,
	fail = 0;
const ok = (name, cond, info) => {
	if (cond) {
		pass++;
		console.log("  ok  ", name);
	} else {
		fail++;
		console.error("  FAIL", name, info !== undefined ? `(${JSON.stringify(info).slice(0, 220)})` : "");
	}
};
process.env.PI_SWARM_AGENT_ID = "root";
process.env.PI_SWARM_IS_ROOT = "1";

const { paths, ensureDirs, readState, writeState } = await import(join(here, "..", "src", "state.ts"));
const { claimRootLeader, heartbeatRootLeader, ensureRoot } = await import(join(here, "..", "src", "identity.ts"));
const { buildSwarmStatusSummary } = await import(join(here, "..", "src", "tasks-index.ts"));

// ===========================================================================
// RED PHASE — the reproducing artifact (observed red at 783af1c; stays as
// permanent regression assertions)
// ===========================================================================

// --- RED-1: stamp module surface ------------------------------------------
let stampMod = null;
let importErr = null;
try {
	stampMod = await import(join(here, "..", "src", "stamp.ts"));
} catch (err) {
	importErr = err;
}
ok("stamp module importable (extensions/swarm/src/stamp.ts)", stampMod !== null, String(importErr || ""));
if (stampMod) {
	ok("exports computeCodeStamp (async)", typeof stampMod.computeCodeStamp === "function");
	ok("exports computeCodeStampSync", typeof stampMod.computeCodeStampSync === "function");
	ok("exports getProcessCodeStamp", typeof stampMod.getProcessCodeStamp === "function");
	ok("exports renderCodeStampLine", typeof stampMod.renderCodeStampLine === "function");
	ok("exports swarmExtensionRoot", typeof stampMod.swarmExtensionRoot === "function");
	if (typeof stampMod.swarmExtensionRoot === "function") {
		const root = stampMod.swarmExtensionRoot();
		ok(
			"swarmExtensionRoot() resolves to extensions/swarm/",
			typeof root === "string" && root.replace(/\/$/, "").endsWith(join("extensions", "swarm")),
			root,
		);
	}
}

// --- RED-2: lease writers stamp extCodeStamp --------------------------------
{
	const dir = mkdtempSync(join(tmpdir(), "swarm-ext-stamp-red-"));
	await ensureDirs(paths(dir));
	const st = await readState(paths(dir), dir);
	ensureRoot(st, dir, paths(dir));
	ok("pre-claim state has no rootLeader", st.rootLeader === undefined || st.rootLeader === null, "expected pre-claim vacancy");
	claimRootLeader(st, Date.now(), process.pid);
	ok(
		"claimRootLeader stamps extCodeStamp (2026-10-03 incident repro: durable generation record was absent)",
		st.rootLeader?.extCodeStamp !== undefined,
		JSON.stringify(st.rootLeader),
	);
	const prior = st.rootLeader?.extCodeStamp;
	heartbeatRootLeader(st, Date.now(), process.pid, "test");
	ok(
		"heartbeatRootLeader preserves extCodeStamp across lease rebuild",
		st.rootLeader?.extCodeStamp !== undefined && st.rootLeader?.extCodeStamp?.hash === prior?.hash,
		JSON.stringify(st.rootLeader),
	);
	rmSync(dir, { recursive: true, force: true });
}

// --- RED-3: /swarm status surfaces the `ext code:` line --------------------
{
	const dir = mkdtempSync(join(tmpdir(), "swarm-ext-stamp-status-"));
	await ensureDirs(paths(dir));
	const st = await readState(paths(dir), dir);
	ensureRoot(st, dir, paths(dir));
	const sum = await buildSwarmStatusSummary(paths(dir), st);
	ok("/swarm status output contains the `ext code:` line (was absent at HEAD → zero warning)", sum.text.includes("ext code:"), sum.text);
	rmSync(dir, { recursive: true, force: true });
}

if (!stampMod) {
	console.log(`\next-code-stamp FAIL (${fail} failed, ${pass} passed) — RED phase observed (stamp module absent)`);
	process.exit(1);
}

// --- RED-4 (task-fu-stamp-digest, R1): same-length content edit + restored mtime --------
// PoC /tmp/rt-guarda/poc-stamp3.mjs ported verbatim (red-team F5, task-redteam-20261003):
// the metadata-only stamp folds only size+mtime, so an in-place same-length edit with
// the mtime restored via utimesSync was INVISIBLE (sameHash:true at pre-fix HEAD —
// observed and logged in task-fu-stamp-digest/artifacts/red-first-log.md before any
// src change was authored). This section IS the regression test (red-first mandate
// 2026-08-31): pre-fix it FAILS on the `hash CHANGED` assertion; post-fix it passes.
if (stampMod) {
	console.log("\n== R1: same-length content edit with restored mtime must CHANGE the hash (redteam F5) ==");
	const r1Dir = mkdtempSync(join(tmpdir(), "swarm-ext-stamp-r1-"));
	cpSync(extRoot, r1Dir, { recursive: true });
	rmSync(join(r1Dir, "tests"), { recursive: true, force: true });
	const victim = join(r1Dir, "src", "observability.ts");
	// Normalize the victim's mtime to whole-ms FIRST (utimesSync round-trip), so the
	// post-edit restore below is EXACT — otherwise a sub-ms original mtime would make
	// the floored restore itself change the mtime and the assertion would pass for the
	// wrong reason (fixture flake, not the fix). This mirrors the PoC's stable state.
	const initialStat = statSync(victim);
	const initialMs = Math.floor(initialStat.mtimeMs);
	utimesSync(victim, new Date(initialMs), new Date(initialMs));
	const s1 = stampMod.computeCodeStampSync(r1Dir);
	const victimStat = statSync(victim);
	const victimMtimeMs = Math.floor(victimStat.mtimeMs); // floor to whole ms like utimes can set
	const victimContent = readFileSync(victim, "utf8");
	// same-length content edit: swap two 1-byte codepoints, byte length identical
	const editedContent = victimContent.includes("0") ? victimContent.replace("0", "1") : victimContent.replace("1", "2");
	if (editedContent.length !== victimContent.length) {
		throw new Error("R1 fixture broken: edited content is not same-length");
	}
	writeFileSync(victim, editedContent, "utf8");
	utimesSync(victim, new Date(victimMtimeMs), new Date(victimMtimeMs)); // restore the mtime
	const restoredStat = statSync(victim);
	ok(
		"R1 fixture: size restored byte-for-byte (same-length edit)",
		restoredStat.size === victimStat.size,
		`${restoredStat.size} vs ${victimStat.size}`,
	);
	ok(
		"R1 fixture: mtime restored (utimesSync round-trip)",
		Math.floor(restoredStat.mtimeMs) === victimMtimeMs,
		`${Math.floor(restoredStat.mtimeMs)} vs ${victimMtimeMs}`,
	);
	const s2 = stampMod.computeCodeStampSync(r1Dir);
	ok(
		"R1: same-length content edit + restored mtime ⇒ hash CHANGED (was sameHash:true — RED at pre-fix HEAD)",
		s2.hash !== s1.hash,
		`s1=${s1.hash.slice(0, 8)} s2=${s2.hash.slice(0, 8)} sameHash=${s1.hash === s2.hash}`,
	);
	ok("R1: file count stable across the edit", s2.files === s1.files, `${s1.files} vs ${s2.files}`);

	// Control: mtime-ONLY touch (content byte-identical) must NOT change the hash alone,
	// and must not lose mtime sensitivity — the folded line keeps size+mtime, so an
	// mtime-only change still moves the hash. Both directions are pinned here.
	utimesSync(victim, new Date(victimMtimeMs + 5_000), new Date(victimMtimeMs + 5_000));
	const s3 = stampMod.computeCodeStampSync(r1Dir);
	ok(
		"R1 control: mtime-only touch changes the hash (mtime sensitivity kept in v2)",
		s3.hash !== s2.hash,
		`s2=${s2.hash.slice(0, 8)} s3=${s3.hash.slice(0, 8)}`,
	);
	rmSync(r1Dir, { recursive: true, force: true });
}

// ===========================================================================
// GREEN PHASE — permanent regression suite
// ===========================================================================
const { computeCodeStamp, computeCodeStampSync, getProcessCodeStamp, renderCodeStampLine } = stampMod;

console.log("\n== determinism (tmp copy of the extension tree) ==");
const tmpTree = mkdtempSync(join(tmpdir(), "swarm-ext-stamp-tree-"));
cpSync(extRoot, tmpTree, { recursive: true });
rmSync(join(tmpTree, "tests"), { recursive: true, force: true });
const h1 = await computeCodeStamp(tmpTree);
const h2 = await computeCodeStamp(tmpTree);
ok("two consecutive computes → identical hash", h1.hash === h2.hash, `${h1.hash} vs ${h2.hash}`);
ok("hash is sha256-sized (64 hex)", /^[0-9a-f]{64}$/.test(h1.hash), h1.hash);
ok("file count plausible (≥20 ts files)", h1.files >= 20, h1.files);
ok("computedAt present", typeof h1.computedAt === "string");
ok("sync twin agrees with async walker", (await computeCodeStampSync(tmpTree)).hash === h1.hash);

// Budget pin (plan §1/§4): full computeCodeStampSync ≤ 20 ms for the current ~132-file
// tree (measured ~3.2–4.2 ms on this host). Assert the src file COUNT matches the folded
// count (readdir+stat+read over exactly the .ts files, < 512 cap) and the wall-time budget.
{
	const srcTsCount = (() => {
		let n = 0;
		const walk = (d) => {
			for (const e of readdirSync(d, { withFileTypes: true })) {
				const p = join(d, e.name);
				if (e.isDirectory()) walk(p);
				else if (e.isFile() && e.name.endsWith(".ts")) n++;
			}
		};
		walk(join(tmpTree, "src"));
		return n;
	})();
	ok("budget: folded file count === src/*.ts count (+ root index)", h1.files === srcTsCount + 1, `files=${h1.files} srcTs=${srcTsCount}`);
	ok("budget: file count under the 512 cap", h1.files < stampMod.EXT_CODE_STAMP_MAX_FILES, h1.files);
	computeCodeStampSync(tmpTree); // warm (module cache + fs cache)
	const t0 = performance.now();
	computeCodeStampSync(tmpTree);
	const budgetMs = performance.now() - t0;
	ok("budget: full computeCodeStampSync < 20 ms for the ~132-file tree (plan §1)", budgetMs < 20, `${budgetMs.toFixed(3)} ms`);
}

console.log("\n== mixed-format durable stamps (v1 legacy / pre-digest leases) ==");
// Durable stamps are compare-only values; a v1 (metadata-only) or legacy-shaped hash can
// never equal a v2 self hash ⇒ renders stale — the SAFE direction (operator prompt to
// reboot). One explicit non-64-len pin next to the seeded "0".repeat(64) integration pins.
{
	const vLegacyShort = renderCodeStampLine({ hash: "OLDSTALE", files: 9, stampedAt: new Date().toISOString() }, h1, { now: Date.now() });
	ok("legacy non-64-len durable hash (OLDSTALE) ⇒ stale", vLegacyShort.verdict === "stale", JSON.stringify(vLegacyShort));
	const vLegacyHex64 = renderCodeStampLine({ hash: "a".repeat(64), files: 9, stampedAt: new Date().toISOString() }, h1, {
		now: Date.now(),
	});
	ok(
		"64-hex v1 (metadata-only) durable hash ≠ v2 self ⇒ stale (safe-by-construction)",
		vLegacyHex64.verdict === "stale",
		JSON.stringify({ verdict: vLegacyHex64.verdict }),
	);
}

console.log("\n== verdict rendering (pure formatter) ==");
const durableStale = { hash: h1.hash, files: h1.files, stampedAt: new Date(Date.now() - 3 * 3600 * 1000).toISOString() };
appendFileSync(join(tmpTree, "index.ts"), "// gen bump\n", "utf8"); // simulates the on-disk code change
const h3 = await computeCodeStamp(tmpTree);
ok("mutating a file changes the hash", h3.hash !== h1.hash, `${h3.hash} vs ${h1.hash}`);

const vStale = renderCodeStampLine(durableStale, h3, { now: Date.now() });
ok("incident shape: durable≠disk ⇒ STALE", vStale.verdict === "stale", JSON.stringify(vStale));
ok("STALE line explains remediation (restart root / /reload)", /restart|reload/i.test(vStale.line), vStale.line);
ok("STALE line names root-boot age", /ago/.test(vStale.line), vStale.line);
ok("STALE line carries self=<h8>", /self=[0-9a-f]{8}/.test(vStale.line), vStale.line);

const vCur = renderCodeStampLine(h3, h3, { now: Date.now() });
ok("same durable/disk ⇒ current", vCur.verdict === "current", JSON.stringify(vCur));
ok("current line carries self=<h8>", /self=[0-9a-f]{8}/.test(vCur.line), vCur.line);

const vUnk = renderCodeStampLine(undefined, h3, { now: Date.now() });
ok("absent durable stamp ⇒ unknown (pre-feature root, never fabricated)", vUnk.verdict === "unknown", JSON.stringify(vUnk));
ok("unknown line never invents a root hash", !/\broot=[0-9a-f]/.test(vUnk.line), vUnk.line);

const vUnavail = renderCodeStampLine(durableStale, { hash: "unavailable", files: 0, computedAt: "" }, { now: Date.now() });
ok("scan failure ⇒ unavailable verdict (errors.jsonl pointer)", vUnavail.verdict === "unavailable", JSON.stringify(vUnavail));

ok(
	"all lines bounded ≤140 chars",
	[vStale.line, vCur.line, vUnk.line, vUnavail.line].every((l) => l.length <= 140),
	[vStale.line, vCur.line, vUnk.line, vUnavail.line].map((l) => l.length),
);
rmSync(tmpTree, { recursive: true, force: true });

console.log("\n== durable lease writers + status surface (integration) ==");
{
	const dir = mkdtempSync(join(tmpdir(), "swarm-ext-stamp-green-"));
	await ensureDirs(paths(dir));
	const st = await readState(paths(dir), dir);
	ensureRoot(st, dir, paths(dir));
	claimRootLeader(st, Date.now(), process.pid);
	const mine = getProcessCodeStamp();
	ok("claim writes THIS process's stamp", st.rootLeader?.extCodeStamp?.hash === mine.hash, JSON.stringify(st.rootLeader?.extCodeStamp));
	heartbeatRootLeader(st, Date.now(), process.pid, "test");
	ok("heartbeat preserves the stamp across the lease rebuild", st.rootLeader?.extCodeStamp?.hash === mine.hash);
	ok("process stamp plausible (own ext tree, ≥20 files)", mine.files >= 20, mine.files);

	// Seeded stale-durable world (the incident shape) ⇒ STALE line in /swarm status
	st.rootLeader.extCodeStamp = { hash: "0".repeat(64), files: 42, stampedAt: new Date().toISOString() };
	await writeState(paths(dir), st);
	const sum = await buildSwarmStatusSummary(paths(dir), st);
	const sumLine = sum.text.split("\n").find((l) => /^ext code:/.test(l));
	ok("/swarm status renders an `ext code:` line", !!sumLine, sum.text);
	ok("seeded stale durable stamp ⇒ status line says STALE", /\bSTALE\b/.test(sumLine || ""), sumLine);
	ok(
		"status details.extCodeStamp carries the verdict",
		sum.details?.extCodeStamp?.verdict === "stale",
		JSON.stringify(sum.details?.extCodeStamp),
	);
	ok(
		"status details.extCodeStamp carries self=<h8>",
		typeof sum.details?.extCodeStamp?.self === "string" && /^[0-9a-f]{8}$/.test(sum.details.extCodeStamp.self),
		JSON.stringify(sum.details?.extCodeStamp),
	);
	rmSync(dir, { recursive: true, force: true });
}

// ===========================================================================
// Static integrity + no-silent-swallow guards
// ===========================================================================
console.log("\n== static integrity ==");

// R27-B-style guard: barrel-touched modules must statically import their stamp
// surface (TS transpile-only never flags a missing import).
const tasksIdxSrc = readFileSync(join(here, "..", "src", "tasks-index.ts"), "utf8");
for (const ident of ["computeCodeStamp", "renderCodeStampLine"]) {
	ok(
		`tasks-index.ts statically imports ${ident} (R27-B import-integrity)`,
		new RegExp(`import\\s*\\{[^}]*\\b${ident}\\b[^}]*\\}\\s*from`).test(tasksIdxSrc),
		ident,
	);
}
const sessionHookSrc = readFileSync(join(here, "..", "src", "hooks", "session.ts"), "utf8");
ok(
	"hooks/session.ts statically imports getProcessCodeStamp (R27-B import-integrity)",
	/import\s*\{[^}]*\bgetProcessCodeStamp\b[^}]*\}\s*from/.test(sessionHookSrc),
);

// AGENTS.md no-silent-swallow mandate: no bare `catch {}` under extensions/swarm/src
// (errorlog.ts is excluded by the mandate itself — it is the self-silent error sink).
{
	const offenders = [];
	const walk = (d) => {
		for (const e of readdirSync(d, { withFileTypes: true })) {
			const p = join(d, e.name);
			if (e.isDirectory()) walk(p);
			else if (e.isFile() && p.endsWith(".ts") && !p.endsWith(join("src", "errorlog.ts"))) {
				const src = readFileSync(p, "utf8");
				if (/catch\s*\{\s*\}/.test(src)) offenders.push(relative(repoRoot, p));
			}
		}
	};
	walk(join(extRoot, "src"));
	ok("no empty catch blocks in extensions/swarm/src (AGENTS.md mandate; errorlog.ts excluded)", offenders.length === 0, offenders.join(", "));
}

// ===========================================================================
// R10-1 boundary counting: drive the REAL extension factory + session_start
// handler at the real pi boundary with a counting stub. The stamp feature must
// introduce ZERO new pi.sendMessage / ctx.abort / ctx.reload crossings.
// ===========================================================================
console.log("\n== R10-1 boundary counting ==");

{
	const dir = mkdtempSync(join(tmpdir(), "swarm-ext-stamp-r101-"));
	mkdirSync(join(dir, ".pi", "swarm"), { recursive: true });
	writeFileSync(join(dir, ".pi", "settings.json"), JSON.stringify({ swarm: {} }));
	const indexMod = await import(join(repoRoot, "extensions", "swarm", "index.ts"));

	const boundaries = { sendMessage: 0, registerTool: 0, abort: 0, reload: 0, newSession: 0, fork: 0 };
	const handlers = {};
	const pi = {
		registerTool: () => {
			boundaries.registerTool++;
		},
		registerCommand: () => {},
		on: (ev, fn) => {
			(handlers[ev] ||= []).push(fn);
			return () => {};
		},
		sendMessage: () => {
			boundaries.sendMessage++;
			return true;
		},
		exec: async () => ({ code: 0, stdout: "", stderr: "" }),
	};

	// 1) Factory-time boundary accounting (L2 pins)
	indexMod.default(pi);
	const factoryRegisterTool = boundaries.registerTool;
	ok("factory registers tools (>0 observed)", factoryRegisterTool > 0, factoryRegisterTool);
	ok("no pi.sendMessage crossed at factory time", boundaries.sendMessage === 0, boundaries.sendMessage);

	// 2) Drive the real session_start handler with a counting ctx (L3 pins)
	const sessionHandlers = handlers["session_start"] || [];
	ok("session_start handler registered by the real factory", sessionHandlers.length >= 1, sessionHandlers.length);

	let notifyCount = 0;
	const ctx = {
		cwd: dir,
		mode: "tui",
		hasUI: true,
		isIdle: () => true,
		ui: {
			notify: () => {
				notifyCount++;
				return true;
			},
			setStatus: () => {},
		},
		abort: () => {
			boundaries.abort++;
		},
		reload: async () => {
			boundaries.reload++;
		},
		newSession: async () => {
			boundaries.newSession++;
		},
		fork: async () => {
			boundaries.fork++;
		},
		shutdown: async () => {},
		signal: undefined,
	};
	for (const fn of sessionHandlers) await fn({}, ctx);
	ok("no ctx.abort() crossing introduced", boundaries.abort === 0, boundaries.abort);
	ok("no ctx.reload() crossing introduced", boundaries.reload === 0, boundaries.reload);
	ok("no pi.sendMessage crossing at session_start", boundaries.sendMessage === 0, boundaries.sendMessage);
	ok("no pi.registerTool growth from session_start", boundaries.registerTool === factoryRegisterTool, `${boundaries.registerTool} vs ${factoryRegisterTool}`);
	const baselineNotifies = notifyCount;
	ok("baseline session_start notifies captured", baselineNotifies >= 0, baselineNotifies);

	rmSync(dir, { recursive: true, force: true });

	// 3) Changed-generation pin: prior durable stamp ≠ process stamp ⇒ the
	// ext.stamp.changed notify path fires exactly once (counting assertion at
	// the REAL ctx.ui.notify boundary — no helper stubs).
	{
		const dir2 = mkdtempSync(join(tmpdir(), "swarm-ext-stamp-r101b-"));
		mkdirSync(join(dir2, ".pi", "swarm"), { recursive: true });
		writeFileSync(join(dir2, ".pi", "settings.json"), JSON.stringify({ swarm: {} }));
		const st = await readState(paths(dir2), dir2);
		st.rootLeader = {
			pid: 12345,
			sessionStartedAt: new Date().toISOString(),
			claimedAt: new Date().toISOString(),
			lastHeartbeatAt: new Date().toISOString(),
			extCodeStamp: { hash: "0".repeat(64), files: 42, stampedAt: new Date().toISOString() },
		};
		await writeState(paths(dir2), st);
		let chgNotifyCount = 0;
		const ctx2 = {
			cwd: dir2,
			mode: "tui",
			hasUI: true,
			isIdle: () => true,
			ui: {
				notify: () => {
					chgNotifyCount++;
					return true;
				},
				setStatus: () => {},
			},
			abort: () => {},
			reload: async () => {},
			newSession: async () => {},
			fork: async () => {},
			shutdown: async () => {},
		};
		for (const fn of sessionHandlers) await fn({}, ctx2);
		ok(
			"changed-generation session_start: exactly 1 ext.stamp.changed-style notify (counting at real ctx.ui.notify boundary)",
			chgNotifyCount === baselineNotifies + 1,
			`baseline=${baselineNotifies} changed=${chgNotifyCount}`,
		);
		ok(
			"changed-generation run crosses no L2/L3 boundary",
			boundaries.sendMessage === 0 &&
				boundaries.abort === 0 &&
				boundaries.reload === 0 &&
				boundaries.newSession === 0 &&
				boundaries.fork === 0,
			JSON.stringify(boundaries),
		);
		const st2 = await readState(paths(dir2), dir2);
		ok(
			"changed-generation run refreshes the durable stamp to the new generation",
			st2.rootLeader?.extCodeStamp?.hash !== "0".repeat(64),
			JSON.stringify(st2.rootLeader?.extCodeStamp),
		);
		rmSync(dir2, { recursive: true, force: true });
	}
}

console.log(`\next-code-stamp ${fail === 0 ? "PASS" : "FAIL"} (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
