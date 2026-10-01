// Schema leg for issues-footer-val.jsonl fixture (review P3-2 fold).
// The fixture itself is lane-only (3 trivial ack turns consumed by the
// interactive footer validation session); this keeps the always-on schema
// contract enforced per repo convention.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "..", "fixtures", "issues-footer-val.jsonl");

const raw = readFileSync(fixture, "utf8");
const lines = raw.split("\n").filter((l) => l.trim() !== "");
assert.ok(lines.length >= 3, `expected at least 3 scripted turns, got ${lines.length}`);

let i = 0;
for (const line of lines) {
	i++;
	const turn = JSON.parse(line); // throws on torn JSON
	assert.ok(typeof turn.name === "string" && turn.name.length > 0, `turn ${i}: name missing`);
	assert.ok(Array.isArray(turn.events), `turn ${i}: events must be an array`);
	assert.ok(["stop", "end_turn", "tool_use", "max_tokens", "aborted", undefined].includes(turn.stopReason) || typeof turn.stopReason === "string", `turn ${i}: stopReason must be a string when present`);
	for (const ev of turn.events) {
		assert.ok(typeof ev.type === "string", `turn ${i}: event type missing`);
	}
}

console.log(`issues-footer-val fixture schema: ${lines.length} turns OK`);
