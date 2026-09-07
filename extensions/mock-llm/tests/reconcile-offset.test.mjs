#!/usr/bin/env node
/** Fixture contract for swarm_reconcile offset pagination. */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(here, "..", "fixtures", "reconcile-offset.jsonl");
let pass = 0;
let fail = 0;
const ok = (name, condition, detail) => {
	if (condition) {
		pass++;
		console.log("  ok  ", name);
	} else {
		fail++;
		console.error("  FAIL", name, detail ?? "");
	}
};

ok("fixture exists", existsSync(fixturePath));
const turns = existsSync(fixturePath)
	? readFileSync(fixturePath, "utf8")
			.split("\n")
			.filter((line) => line.trim() && !line.trim().startsWith("#"))
			.map(JSON.parse)
	: [];
ok("fixture has three deterministic turns", turns.length === 3, turns.length);
const firstCall = turns[0]?.events?.find((event) => event.type === "toolcall");
const offsetCall = turns[1]?.events?.find((event) => event.type === "toolcall");
ok(
	"first turn calls swarm_reconcile without offset",
	firstCall?.name === "swarm_reconcile" && firstCall.arguments?.offset === undefined,
	firstCall,
);
ok(
	"second turn calls swarm_reconcile with offset=2",
	offsetCall?.name === "swarm_reconcile" && offsetCall.arguments?.offset === 2,
	offsetCall,
);
ok(
	"fixture finishes with terminal stop",
	turns[2]?.stopReason === "stop" && turns[2]?.events?.some((event) => event.type === "stop"),
	turns[2],
);

console.log(`\nRECONCILE OFFSET FIXTURE ${fail === 0 ? "PASS" : "FAIL"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
