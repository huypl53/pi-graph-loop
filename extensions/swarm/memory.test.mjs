// Regression tests for swarm metric/run/memory eligibility and iteration ranking.
// Run: node extensions/swarm/memory.test.mjs
import { computeIterationBest, validateRunAgainstContract } from "./index.ts";

let pass = 0;
let fail = 0;
const ok = (name, cond) => {
	if (cond) pass++;
	else { fail++; console.error("  FAIL:", name); }
};

const contract = {
	id: "quality-v1",
	title: "Quality",
	version: 1,
	primaryMetric: {
		id: "quality_score",
		direction: "maximize",
		valueType: "number",
		source: { type: "artifact" },
		minimumMeaningfulChange: 0.01,
	},
	evidenceRequired: ["summary.md", "change.patch"],
};

const valid = (id, value) => ({
	runId: id,
	metricContractId: contract.id,
	metricContractVersion: 1,
	status: "done",
	verdict: "pass",
	metrics: { quality_score: value },
});

ok("valid run passes contract validation", validateRunAgainstContract(valid("ok", 0.6), contract).length === 0);
ok("running run is invalid", validateRunAgainstContract({ ...valid("running", 0.9), status: "running" }, contract).some((r) => r.includes("must be done")));
ok("failed verdict is invalid", validateRunAgainstContract({ ...valid("failed", 0.9), verdict: "fail" }, contract).some((r) => r.includes("pass or approved")));
ok("cross-contract run is invalid", validateRunAgainstContract({ ...valid("cross", 0.9), metricContractId: "other" }, contract).some((r) => r.includes("metricContractId")));
ok("stale contract version is invalid", validateRunAgainstContract({ ...valid("stale", 0.9), metricContractVersion: 0 }, contract).some((r) => r.includes("contract version")));
ok("wrong primary metric type is invalid", validateRunAgainstContract({ ...valid("wrong-type", 0.9), metrics: { quality_score: "0.9" } }, contract).some((r) => r.includes("valid number")));

const runs = new Map([
	["baseline", valid("baseline", 0.6)],
	["failed-high", { ...valid("failed-high", 99), status: "failed", verdict: "fail" }],
	["cross-high", { ...valid("cross-high", 88), metricContractId: "other" }],
	["improved", valid("improved", 0.67)],
]);
const best = computeIterationBest([
	{ runId: "baseline", label: "baseline" },
	{ runId: "failed-high", label: "failed" },
	{ runId: "cross-high", label: "cross" },
	{ runId: "improved", label: "candidate" },
], runs, contract);

ok("failed/cross-contract high scores cannot win", best.bestRunId === "improved");
ok("invalid runs are counted", best.invalidCount === 2);
ok("improvement is computed from valid baseline", Math.abs(best.improvement - 0.07) < 1e-9);
ok("meaningful improvement is true", best.meaningful === true);
ok("excluded runs expose reasons", best.perRun.find((r) => r.runId === "failed-high")?.exclusionReasons.length > 0);

const equalBest = computeIterationBest([
	{ runId: "baseline" },
	{ runId: "same" },
], new Map([
	["baseline", valid("baseline", 0.6)],
	["same", valid("same", 0.6)],
]), contract);
ok("zero delta is not meaningful", equalBest.meaningful === false);

console.log(`\n${fail === 0 ? "PASS" : "FAIL"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
