// Regression reproduction for pool failover selecting the slot that just failed.
// Deterministically pins weightedPick to the first item, matching live pool.swap from===to traces.
// RED evidence (pre-fix): .pi/swarm-uat/runs/pool-avoid-failed-slot-red/ (exit 1, 1 failed —
// "weighted failover avoids the just-failed slot — picked=ccs/glm-4.7, avoid=ccs/glm-4.7").
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paths } from "../src/state.ts";
import { pickSlot, slotKey, setSlotCooldown, withPoolLock, writePoolHealth } from "../src/pool.ts";

let pass = 0;
let fail = 0;
function check(name, condition, details = "") {
	if (condition) {
		pass++;
		console.log(`  ok   ${name}`);
	} else {
		fail++;
		console.error(`  FAIL ${name}${details ? ` — ${details}` : ""}`);
	}
}

const failedSlotKey = "ccs/glm-4.7";

async function writeConfig(dir, slots, rotation) {
	await writeFile(join(dir, ".pi", "settings.json"), JSON.stringify({ swarm: { modelPool: slots, rotation } }));
}

async function resetPoolHealth(p) {
	await withPoolLock(p, async () => {
		await writePoolHealth(p, { slots: {}, rrCursor: 0 });
	});
}

const originalCwd = process.cwd();
const dir = await mkdtemp(join(tmpdir(), "pool-avoid-failed-slot-"));
try {
	await mkdir(join(dir, ".pi"), { recursive: true });
	await writeConfig(
		dir,
		[
			{ model: "glm-4.7", provider: "ccs", weight: 1 },
			{ model: "claude-opus-4-8", provider: "ccs", weight: 1 },
			{ model: "gpt-6-luna", provider: "ccs", weight: 1 },
		],
		{ strategy: "weighted", cooldownMs: 60_000, maxRetries: 2 },
	);
	process.chdir(dir);
	const p = paths(dir);
	const originalRandom = Math.random;
	try {
		// WeightedPick roll=0 always chooses the first candidate if it remains eligible.
		Math.random = () => 0;
		const picked = await pickSlot(p, { avoidKey: failedSlotKey });
		check("eligible alternatives exist", Boolean(picked));
		check(
			"weighted failover avoids the just-failed slot",
			Boolean(picked && slotKey(picked.slot) !== failedSlotKey),
			`picked=${picked ? slotKey(picked.slot) : "undefined"}, avoid=${failedSlotKey}`,
		);

		// Relative weights preserved among ALTERNATIVES: w=(1,3,1) with avoid=glm (w=1) filters to
		// (claude w=3, luna w=1); roll=0.5 → cumulative 1.5 → lands in claude (same distribution
		// shape as the unfiltered pool, just over the filtered set).
		Math.random = () => 0.5;
		await writeConfig(
			dir,
			[
				{ model: "glm-4.7", provider: "ccs", weight: 1 },
				{ model: "claude-opus-4-8", provider: "ccs", weight: 3 },
				{ model: "gpt-6-luna", provider: "ccs", weight: 1 },
			],
			{ strategy: "weighted", cooldownMs: 60_000, maxRetries: 2 },
		);
		const wp = await pickSlot(p, { avoidKey: failedSlotKey });
		check(
			"relative weights preserved among alternatives (roll 0.5 of w=(1,3,1) filtered → w=3 slot)",
			Boolean(wp && slotKey(wp.slot) === "ccs/claude-opus-4-8"),
			`picked=${wp ? slotKey(wp.slot) : "undefined"}`,
		);
		Math.random = () => 0;

		// Single-slot pool: avoidKey on the ONLY slot → undefined (safe fallback, no same-slot swap).
		await writeConfig(dir, [{ model: "glm-4.7", provider: "ccs", weight: 1 }], {
			strategy: "weighted",
			cooldownMs: 60_000,
			maxRetries: 2,
		});
		const single = await pickSlot(p, { avoidKey: failedSlotKey });
		check(
			"single-slot pool with avoidKey=only slot → undefined (no fake same-slot swap)",
			single === undefined,
			`picked=${single ? slotKey(single.slot) : "undefined"}`,
		);

		// Sticky strategy: deterministic alternative from the filtered set, never the failed slot.
		await writeConfig(
			dir,
			[
				{ model: "glm-4.7", provider: "ccs", weight: 1 },
				{ model: "claude-opus-4-8", provider: "ccs", weight: 1 },
			],
			{ strategy: "sticky", cooldownMs: 60_000, maxRetries: 2 },
		);
		const sp1 = await pickSlot(p, { stickyKey: "agent-x", avoidKey: failedSlotKey });
		const sp2 = await pickSlot(p, { stickyKey: "agent-x", avoidKey: failedSlotKey });
		check(
			"sticky failover avoids the just-failed slot and stays stable across picks",
			Boolean(sp1 && sp2 && slotKey(sp1.slot) !== failedSlotKey && slotKey(sp1.slot) === slotKey(sp2.slot)),
			`p1=${sp1 ? slotKey(sp1.slot) : "undefined"} p2=${sp2 ? slotKey(sp2.slot) : "undefined"}`,
		);

		// Round-robin: avoidKey still honored on the filtered set (cursor +1 path).
		await writeConfig(
			dir,
			[
				{ model: "glm-4.7", provider: "ccs", weight: 1 },
				{ model: "claude-opus-4-8", provider: "ccs", weight: 1 },
			],
			{ strategy: "round-robin", cooldownMs: 60_000, maxRetries: 2 },
		);
		const rp = await pickSlot(p, { avoidKey: failedSlotKey });
		check(
			"round-robin failover avoids the just-failed slot",
			Boolean(rp && slotKey(rp.slot) !== failedSlotKey),
			`picked=${rp ? slotKey(rp.slot) : "undefined"}`,
		);

		// Fallback-only (weight=0) candidates: same avoid policy — skip the failed slot entirely.
		await writeConfig(
			dir,
			[
				{ model: "glm-4.7", provider: "ccs", weight: 0 },
				{ model: "claude-opus-4-8", provider: "ccs", weight: 0 },
			],
			{ strategy: "weighted", cooldownMs: 60_000, maxRetries: 2 },
		);
		const fp = await pickSlot(p, { avoidKey: failedSlotKey });
		check(
			"fallback-only candidates honor avoidKey (pick the OTHER weight-0 slot)",
			Boolean(fp && slotKey(fp.slot) === "ccs/claude-opus-4-8"),
			`picked=${fp ? slotKey(fp.slot) : "undefined"}`,
		);

		// All benched: undefined regardless of avoidKey (unchanged semantics).
		await writeConfig(
			dir,
			[
				{ model: "glm-4.7", provider: "ccs", weight: 1 },
				{ model: "claude-opus-4-8", provider: "ccs", weight: 1 },
			],
			{ strategy: "weighted", cooldownMs: 60_000, maxRetries: 2 },
		);
		await setSlotCooldown(p, failedSlotKey, 60_000);
		await setSlotCooldown(p, "ccs/claude-opus-4-8", 60_000);
		const ab = await pickSlot(p, { avoidKey: failedSlotKey });
		check("all slots benched → undefined (avoid or not)", ab === undefined, `picked=${ab ? slotKey(ab.slot) : "undefined"}`);

		// Reset pool health so the cooldowns above don't leak into the role-filtered test below.
		await resetPoolHealth(p);

		// Role filter: avoidKey respected INSIDE the role-filtered candidate set.
		await writeConfig(
			dir,
			[
				{ model: "glm-4.7", provider: "ccs", weight: 1, roles: ["implementer"] },
				{ model: "claude-opus-4-8", provider: "ccs", weight: 1, roles: ["implementer"] },
			],
			{ strategy: "weighted", cooldownMs: 60_000, maxRetries: 2 },
		);
		const rf = await pickSlot(p, { roleKind: "implementer", avoidKey: failedSlotKey });
		check(
			"role-filtered failover avoids the just-failed slot within the role set",
			Boolean(rf && slotKey(rf.slot) !== failedSlotKey),
			`picked=${rf ? slotKey(rf.slot) : "undefined"}`,
		);

		// Omitted avoidKey preserves existing semantics exactly (roll=0 → first slot).
		const noAvoid = await pickSlot(p, { roleKind: "implementer" });
		check(
			"omitted avoidKey keeps legacy first-pick semantics",
			Boolean(noAvoid && slotKey(noAvoid.slot) === failedSlotKey),
			`picked=${noAvoid ? slotKey(noAvoid.slot) : "undefined"}`,
		);
	} finally {
		Math.random = originalRandom;
	}
} finally {
	process.chdir(originalCwd);
	await rm(dir, { recursive: true, force: true });
}

console.log(`\nPOOL AVOID-FAILED-SLOT: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
