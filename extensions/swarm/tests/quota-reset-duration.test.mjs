// Quota-reset duration format (user request 2026-09-05): quotaResetMs accepts human durations.
//
// Run: node extensions/swarm/tests/quota-reset-duration.test.mjs
//
// quotaResetMs is normally minutes or hours, so raw milliseconds ("18000" was read as 18s when
// the user meant 18m) are error-prone. New contract (all three read paths agree):
//   - number  -> milliseconds (back-compat, unchanged)
//   - string  -> duration format: "<n><unit>" segments, units: ms, s, m, h, d (case-insensitive,
//                combinable: "1h30m" = 5_400_000). Whitespace tolerated ("30 m").
//   - invalid string -> slot_bad_quota_reset in validate; ignored by the raw bench read (0)
// The type is `number | string`; internal consumers see the parsed number.
//
// Red-first: every duration assertion below fails before parseQuotaResetMs lands.
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateSwarmSettings, effectiveBenchMs, _clearQuotaResetCacheForTests } from "../src/pool.ts";
import { parseQuotaResetMs } from "../src/pool.ts";

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
	if (cond) pass++;
	else { fail++; console.error("  FAIL:", name, extra); }
};

// === Unit: parseQuotaResetMs pure parser ===
{
	const cases = [
		// [input, expected ms]
		["30s", 30_000],
		["30m", 1_800_000],
		["2h", 7_200_000],
		["1d", 86_400_000],
		["500ms", 500],
		["1h30m", 5_400_000],
		["2h 15m 30s", 8_130_000],
		["90S", 90_000],          // case-insensitive
		["30 m", 1_800_000],      // whitespace tolerated
		[7200000, 7_200_000],     // bare number back-compat
		["7200000", 7_200_000],   // bare numeric string back-compat
	];
	for (const [input, expected] of cases) {
		ok(`parse ${JSON.stringify(input)} = ${expected}`, parseQuotaResetMs(input) === expected, `got ${parseQuotaResetMs(input)}`);
	}
	const bad = ["", "abc", "30x", "m30", "1.5h", "-30m", "h", undefined, null];
	for (const input of bad) {
		ok(`parse ${JSON.stringify(input)} rejected (undefined)`, parseQuotaResetMs(input) === undefined, `got ${parseQuotaResetMs(input)}`);
	}
}

// === Integration: validate accepts duration strings, flags malformed ones ===
const scratch = await mkdtemp(join(tmpdir(), "quota-dur-"));
await mkdir(join(scratch, ".pi"), { recursive: true });
const settingsPath = join(scratch, ".pi", "settings.json");

await writeFile(settingsPath, JSON.stringify({ swarm: { modelPool: [
	{ model: "a", provider: "ccs", quotaResetMs: "30m" },   // valid duration
	{ model: "b", provider: "ccs", quotaResetMs: 900000 },  // valid number (back-compat)
	{ model: "c", provider: "ccs", quotaResetMs: "1h30m" }, // combined
	{ model: "d", provider: "ccs", quotaResetMs: "30x" },   // bad unit
	{ model: "e", provider: "ccs", quotaResetMs: "fast" },  // nonsense
] } }));
{
	const v = validateSwarmSettings(scratch);
	const badFields = v.errors.filter((e) => e.kind === "slot_bad_quota_reset").map((e) => e.field);
	ok("validate: duration strings accepted (no error for slots 0-2)",
		!badFields.includes("modelPool[0].quotaResetMs") && !badFields.includes("modelPool[1].quotaResetMs") && !badFields.includes("modelPool[2].quotaResetMs"),
		`bad=${JSON.stringify(badFields)}`);
	ok("validate: bad unit flagged", badFields.includes("modelPool[3].quotaResetMs"));
	ok("validate: nonsense flagged", badFields.includes("modelPool[4].quotaResetMs"));
	ok("validate: error message mentions duration format", v.errors.some((e) => e.kind === "slot_bad_quota_reset" && /30m|2h|1d/.test(e.message)),
		JSON.stringify(v.errors.filter((e) => e.kind === "slot_bad_quota_reset").map((e) => e.message)));
}

// === Integration: bench floor honors duration strings from raw config ===
{
	_clearQuotaResetCacheForTests();
	await writeFile(settingsPath, JSON.stringify({ swarm: { modelPool: [
		{ model: "a", provider: "ccs", quotaResetMs: "2h" },
	] } }));
	const rotation = { strategy: "weighted", cooldownMs: 900_000, maxRetries: 2 };
	const bench = effectiveBenchMs({ model: "a", provider: "ccs" }, rotation, scratch);
	ok("effectiveBenchMs: '2h' string floors bench at 7_200_000", bench === 7_200_000, `got ${bench}`);
}

// === Integration: parseModelPool forwards the duration as a parsed number ===
{
	const { readSwarmSettings } = await import("../src/session.ts");
	process.env.PI_SWARM_SKIP_DIRTY_CHECK = "1";
	const st = readSwarmSettings(scratch);
	const slot = st?.modelPool?.find((s) => s.model === "a");
	ok("parseModelPool: slot exists", Boolean(slot));
	ok("parseModelPool: quotaResetMs forwarded as parsed number", slot?.quotaResetMs === 7_200_000, `got ${slot?.quotaResetMs}`);
}

// === poolStatus surfaces the parsed number (smoke via exports) ===
await rm(scratch, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
