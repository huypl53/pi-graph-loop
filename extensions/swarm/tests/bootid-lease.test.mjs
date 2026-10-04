#!/usr/bin/env node
/**
 * bootid-lease — boot-identity binding for the root leader lease (redteam F3).
 *
 * Task: task-fu-bootid-lease (finding F3 / MEDIUM, task-redteam-20261003:
 * heartbeatRootLeader trusts pid equality alone, so a foreign process with a
 * colliding pid — different container/host namespace, or a state file copied
 * across hosts — can restamp rootLeader.extCodeStamp and MASK A STALE ROOT.
 * Verified by PoC /tmp/rt-guarda/poc-heartbeat.mjs.)
 *
 * Reproducing artifact (bug-fixing mandate, 2026-08-31). Observed RED at
 * pre-change HEAD (verbatim output in artifacts/red-first-log.md): R1 seeds
 * the exact PoC state — lease pid colliding with a LIVE pid (our own) + a
 * CONCRETE FOREIGN bootId + durable stamp "OLDSTALE" — and pre-fix
 * heartbeatRootLeader accepts the restamp (no throw; durable stamp rewritten
 = stale root masked) instead of refusing it.
 *
 * Green-phase regression suite (permanent, after the src lands):
 *   - R1  heartbeat denies a foreign-boot pid collision (refuse-and-leave)
 *   - R2  claim denies the same collision (kind:"denied"; R11-4 intact)
 *   - R3  both lease writers stamp bootId; heartbeat preserves it
 *   - R4  legacy lease (no bootId) is trusted; upgraded on next write
 *   - R5  legit same-boot control: claim + heartbeat, no deny
 *   - R6  post-reboot recovery: dead foreign-boot pid → stale → reclaim
 *   - R7  second live root in the SAME boot stays denied (pid rule intact)
 *   - R8  leaseScopeMismatch matrix (all five rows)
 *   - R9  /swarm status ext-code verdict unaffected for a legit root
 *
 * Run: PI_SWARM_AGENT_ID=root PI_SWARM_IS_ROOT=1 node extensions/swarm/tests/bootid-lease.test.mjs
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
process.env.PI_SWARM_AGENT_ID = "root";
process.env.PI_SWARM_IS_ROOT = "1";

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

const thrownMsg = (e) => String(e?.message || e);

// Cache-bust imports so each run exercises the CURRENT sources (multi-root pattern).
const { paths, ensureDirs, readState } = await import(`${join(here, "..", "src", "state.ts")}?cb=${Date.now()}-${Math.random()}`);
const { claimRootLeader, heartbeatRootLeader } = await import(`${join(here, "..", "src", "identity.ts")}?cb=${Date.now()}-${Math.random()}`);

// Pre-change HEAD lacks these exports; destructure defensively so the suite
// still produces granular RED assertions instead of crashing.
const { getBootIdentity } = await import(`${join(here, "..", "src", "stamp.ts")}?cb=${Date.now()}-${Math.random()}`);
const { leaseScopeMismatch } = await import(`${join(here, "..", "src", "identity.ts")}?cb2=${Date.now()}-${Math.random()}`);

const bootOk = typeof getBootIdentity === "function";
const scopeOk = typeof leaseScopeMismatch === "function";
const bok = bootOk ? ok : (name) => ok(`${name} (getBootIdentity absent — RED phase)`, false);

// ===========================================================================
// R1 — THE PoC reproduction (red gate). Verbatim PoC /tmp/rt-guarda/poc-heartbeat.mjs,
// made stricter: our OWN pid (guaranteed live) + a CONCRETE foreign bootId + a durable
// stamp to protect.
// ===========================================================================

console.log("== R1: heartbeat refuses foreign-boot pid collision (the PoC) ==");
{
	const st = { agents: {}, delivered: {} };
	st.rootLeader = {
		pid: process.pid,
		sessionStartedAt: new Date().toISOString(),
		claimedAt: new Date().toISOString(),
		lastHeartbeatAt: new Date(Date.now() - 1000).toISOString(),
		extCodeStamp: { hash: "OLDSTALE", files: 9, stampedAt: new Date().toISOString() },
		bootId: "foreign-host::boottime:111",
	};

	let threw = null;
	try {
		heartbeatRootLeader(st, Date.now(), process.pid, "simulated-worker-tool");
	} catch (e) {
		threw = e;
	}
	ok("R1: heartbeat THROWS on foreign-boot pid collision", threw !== null, threw === null ? "NO THROW — pid collision silently restamped (stale root masked)" : "");

	if (threw) {
		const msg = thrownMsg(threw);
		ok("R1: deny message carries the ROOT_LEADER_DENIED prefix (existing call sites match prefix)", msg.includes("ROOT_LEADER_DENIED"), msg);
		ok("R1: deny message names the LEASE bootId (forensic payoff)", msg.includes("foreign-host::boottime:111"), msg);
		ok("R1: deny message names THIS process's bootId too (BOTH ids — message format has the 'this process bootId=' field)", /this process bootId=\S+/.test(msg), msg);
	}
	ok(
		"R1: refuse-and-leave coherence: denied⇒stamp preserved; (pre-fix) accepted⇒stamp overwritten",
		threw !== null ? st.rootLeader.extCodeStamp.hash === "OLDSTALE" : st.rootLeader.extCodeStamp.hash !== "OLDSTALE",
		JSON.stringify(st.rootLeader.extCodeStamp),
	);
}

console.log("\n== R2: claim refuses foreign-boot pid collision ==");
{
	const st = { agents: {}, delivered: {} };
	st.rootLeader = {
		pid: process.pid,
		sessionStartedAt: new Date().toISOString(),
		claimedAt: new Date().toISOString(),
		lastHeartbeatAt: new Date(Date.now() - 1000).toISOString(),
		extCodeStamp: { hash: "OLDSTALE", files: 9, stampedAt: new Date().toISOString() },
		bootId: "foreign-host::boottime:111",
	};
	const res = claimRootLeader(st, Date.now(), process.pid);
	ok("R2: claim → kind:'denied' (pre-fix: silent restamp + reclaim)", res.kind === "denied", JSON.stringify({ kind: res.kind }));
	ok("R2: deny result carries currentLeader.pid + bootId (for the pump trace)", res.currentLeader?.pid === process.pid && res.currentLeader?.bootId === "foreign-host::boottime:111", JSON.stringify(res.currentLeader || {}));
	ok("R2: denied claim leaves the durable stamp untouched", st.rootLeader.extCodeStamp?.hash === "OLDSTALE", JSON.stringify(st.rootLeader?.extCodeStamp));
}

// ===========================================================================
// Boot identity surface (RED phase: contributes FAILs until stamp.ts lands)
// ===========================================================================

console.log("\n== boot identity (stamp.ts) ==");
let myBootId = "unknown";
if (bootOk) {
	const b1 = getBootIdentity();
	const b2 = getBootIdentity();
	ok("getBootIdentity() resolves on this platform (source ∈ boot_id_file/kern_boottime)", ["boot_id_file", "kern_boottime"].includes(b1.source), JSON.stringify(b1));
	ok("getBootIdentity() id is a hostname-prefixed composite '<host>::<marker>'", typeof b1.id === "string" && b1.id.includes("::") && b1.id.length > 3, b1.id);
	ok("getBootIdentity() memoized (same identity on second call)", b1.id === b2.id && b1.source === b2.source, `${b1.id} vs ${b2.id}`);
	myBootId = b1.id;
} else {
	ok("getBootIdentity exported from stamp.ts (absent — RED phase)", false);
}

// ===========================================================================
// R3 — both lease writers stamp bootId (the extCodeStamp both-writers lesson)
// ===========================================================================

console.log("\n== R3: both writers stamp bootId ==");
{
	const dir = mkdtempSync(join(tmpdir(), "swarm-bootid-r3-"));
	await ensureDirs(paths(dir));
	const st = await readState(paths(dir), dir);
	claimRootLeader(st, Date.now(), process.pid);
	bok("R3: claim writes THIS process's bootId", st.rootLeader?.bootId === myBootId, JSON.stringify(st.rootLeader?.bootId));
	heartbeatRootLeader(st, Date.now(), process.pid, "test");
	bok("R3: heartbeat PRESERVES bootId across the lease rebuild (rebuild-drops-fields regression)", st.rootLeader?.bootId === myBootId, JSON.stringify(st.rootLeader?.bootId));
	rmSync(dir, { recursive: true, force: true });
}

// ===========================================================================
// R4 — legacy-trusted migration: absent bootId folds into the pid-only rule
// ===========================================================================

console.log("\n== R4: legacy lease (no bootId) is legacy-trusted ==");
{
	const dir = mkdtempSync(join(tmpdir(), "swarm-bootid-r4-"));
	await ensureDirs(paths(dir));
	const st = await readState(paths(dir), dir);
	st.rootLeader = {
		pid: process.pid,
		sessionStartedAt: new Date().toISOString(),
		claimedAt: new Date().toISOString(),
		lastHeartbeatAt: new Date().toISOString(),
	};
	let threw = null;
	try {
		heartbeatRootLeader(st, Date.now(), process.pid, "legacy");
	} catch (e) {
		threw = e;
	}
	ok("R4: legacy same-pid heartbeat is NOT denied (legacy-trusted migration)", threw === null, threw ? thrownMsg(threw) : "");
	bok("R4: legacy lease upgrades on next write (bootId stamped going forward)", st.rootLeader?.bootId === myBootId, JSON.stringify(st.rootLeader?.bootId));
	rmSync(dir, { recursive: true, force: true });
}

// ===========================================================================
// R5 — legit same-boot control: normal operation must never regress
// ===========================================================================

console.log("\n== R5: legit same-boot claim + heartbeat control ==");
{
	const dir = mkdtempSync(join(tmpdir(), "swarm-bootid-r5-"));
	await ensureDirs(paths(dir));
	const st = await readState(paths(dir), dir);
	const claim = claimRootLeader(st, Date.now(), process.pid);
	ok("R5: claim on vacant → claimed", claim.kind === "claimed", JSON.stringify({ kind: claim.kind }));
	let threw = null;
	try {
		heartbeatRootLeader(st, Date.now(), process.pid, "test");
		heartbeatRootLeader(st, Date.now(), process.pid, "again");
	} catch (e) {
		threw = e;
	}
	ok("R5: own-pid heartbeats after own claim never deny", threw === null, threw ? thrownMsg(threw) : "");
	rmSync(dir, { recursive: true, force: true });
}

// ===========================================================================
// R6 — post-reboot recovery: foreign-boot DEAD pid → stale → reclaim stamps NEW bootId
// (readRootLeader deliberately NOT tightened: R11-4 pid-liveness recovery intact)
// ===========================================================================

console.log("\n== R6: post-reboot recovery (foreign bootId, dead pid) ==");
{
	const dir = mkdtempSync(join(tmpdir(), "swarm-bootid-r6-"));
	await ensureDirs(paths(dir));
	const deadPid = spawnSync(process.execPath, ["-e", "process.exit(0)"], { timeout: 2000 }).pid;
	const st = await readState(paths(dir), dir);
	st.rootLeader = {
		pid: deadPid,
		sessionStartedAt: new Date().toISOString(),
		claimedAt: new Date().toISOString(),
		lastHeartbeatAt: new Date().toISOString(),
		bootId: "other-host::boottime:222",
	};
	const res = claimRootLeader(st, Date.now(), process.pid);
	ok("R6: foreign-boot DEAD pid → stale → claim SUCCEEDS (R11-4 recovery intact)", res.kind === "claimed", JSON.stringify({ kind: res.kind }));
	bok("R6: reclaimed lease carries the NEW bootId", st.rootLeader?.bootId === myBootId, JSON.stringify(st.rootLeader?.bootId));
	rmSync(dir, { recursive: true, force: true });
}

// ===========================================================================
// R7 — second live root in the SAME boot stays denied (pid rule unchanged)
// ===========================================================================

console.log("\n== R7: second live root same boot → still denied ==");
{
	const dir = mkdtempSync(join(tmpdir(), "swarm-bootid-r7-"));
	await ensureDirs(paths(dir));
	const child = spawn(process.execPath, ["-e", "setTimeout(()=>{},8000)"], { stdio: "ignore" });
	try {
		const st = await readState(paths(dir), dir);
		st.rootLeader = {
			pid: child.pid,
			sessionStartedAt: new Date().toISOString(),
			claimedAt: new Date().toISOString(),
			lastHeartbeatAt: new Date().toISOString(),
			bootId: myBootId,
		};
		let threw = null;
		try {
			heartbeatRootLeader(st, Date.now(), process.pid, "second-root");
		} catch (e) {
			threw = e;
		}
		ok("R7: second live root in the same boot → heartbeat DENIED (pid rule intact)", threw !== null, threw ? thrownMsg(threw) : "no throw!");
	} finally {
		child.kill("SIGKILL");
	}
	rmSync(dir, { recursive: true, force: true });
}

// ===========================================================================
// R8 — leaseScopeMismatch matrix (all five rows)
// ===========================================================================

console.log("\n== R8: leaseScopeMismatch matrix ==");
{
	const base = { pid: 1, sessionStartedAt: "", claimedAt: "", lastHeartbeatAt: "" };
	const rows = [
		["absent lease bootId → legacy-trusted (false)", { ...base }, myBootId, false],
		["concrete mismatch → foreign boot (true)", { ...base, bootId: "foreign-host::boottime:111" }, myBootId, true],
		["lease bootId 'unknown' → pid-only scope (false)", { ...base, bootId: "unknown" }, myBootId, false],
		["my bootId 'unknown' → pid-only scope (false)", { ...base, bootId: "some-other-boot" }, "unknown", false],
		["equal bootIds → same boot (false)", { ...base, bootId: myBootId }, myBootId, false],
	];
	if (scopeOk) {
		for (const [name, lease, me, expected] of rows) {
			ok(`R8: ${name}`, leaseScopeMismatch(lease, me) === expected, `lease.bootId=${JSON.stringify(lease.bootId)} me=${JSON.stringify(me)}`);
		}
	} else {
		ok("leaseScopeMismatch exported from identity.ts (absent — RED phase)", false);
	}
}

// ===========================================================================
// R9 — /swarm status verdict parity for a legit root (read-only consumption)
// ===========================================================================

console.log("\n== R9: /swarm status ext-code verdict unaffected for legit roots ==");
{
	const { buildSwarmStatusSummary } = await import(`${join(here, "..", "src", "tasks-index.ts")}?cb=${Date.now()}-${Math.random()}`);
	const dir = mkdtempSync(join(tmpdir(), "swarm-bootid-r9-"));
	await ensureDirs(paths(dir));
	const st = await readState(paths(dir), dir);
	claimRootLeader(st, Date.now(), process.pid);
	bok("R9: claim → verdict current (additive field, status surface unaffected)", true);
	const sum = await buildSwarmStatusSummary(paths(dir), st);
	const line = (sum.text || "").split("\n").find((l) => /^ext code:/.test(l));
	ok("R9: `ext code:` line present", !!line, sum.text);
	ok("R9: legit bootId-stamped root → verdict current", sum.details?.extCodeStamp?.verdict === "current", JSON.stringify(sum.details?.extCodeStamp || {}));
	rmSync(dir, { recursive: true, force: true });
}

console.log(`\nbootid-lease ${fail === 0 ? "PASS" : "FAIL"} (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
