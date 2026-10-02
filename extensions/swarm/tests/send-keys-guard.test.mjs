// send-keys-guard.test.mjs — retirement contract for swarm_send_keys (R31 21-tool retirement).
//
// HISTORY: this suite unit-tested the ROOT_PANE_REJECTED guard added to swarm_send_keys
// (issue 12 C6 micro-fix): principle-based equality on the resolved tmux target so it fired for
// direct root id AND ghost agents mis-stamped to the "unknown" sentinel. Cases A–F drove the
// registered tool via the registerTool capture pattern.
//
// NOW: swarm_send_keys was retired from the live surface in the R31 21-tool retirement
// (CHANGELOG-documented; manual pane injection is no longer a worker-facing primitive — the
// reinject path uses the terminal driver internally). The guard logic retired WITH the tool
// (its body is preserved verbatim in src/tools/agents/retired.ts). This file now asserts the
// retirement contract itself: the tool must be ABSENT from the registered live surface, and
// the retired body must remain in the preserved file for archaeological reference.

import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, existsSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const mod = await import(join(here, "..", "index.ts"));
const factory = mod.default;

const scratch = join(tmpdir(), `swarm-sendkeys-guard-${process.pid}-${Date.now()}`);
rmSync(scratch, { recursive: true, force: true });

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.error("  FAIL:", name); } };

const tools = {};
const sentKeys = [];
factory({
	registerTool: (def) => { tools[def.name] = def; },
	registerCommand: () => {},
	on: () => {},
	exec: async (cmd, args) => {
		if (cmd === "tmux" && args?.[0] === "send-keys") { sentKeys.push(args.slice(1).join(" ")); return { code: 0, stdout: "", stderr: "" }; }
		return { code: 0, stdout: "", stderr: "" };
	},
	sendMessage: () => {},
});

ok("R31 retirement: swarm_send_keys is NOT registered on the live surface", tools.swarm_send_keys === undefined);
ok("R31 retirement: no live tool routes send-keys through pi.exec", sentKeys.length === 0);

// The retired body (with the ROOT_PANE_REJECTED guard) is preserved in retired.ts for reference.
const retiredPath = join(here, "..", "src", "tools", "agents", "retired.ts");
ok("retired.ts preserved", existsSync(retiredPath));
if (existsSync(retiredPath)) {
	const retired = readFileSync(retiredPath, "utf8");
	ok("retired.ts still documents the ROOT_PANE_REJECTED guard", retired.includes("ROOT_PANE_REJECTED"));
	ok("retired.ts still carries the send_keys body", retired.includes("send_keys"));
}

// Live-surface negative checks: the remaining surface never exposes a raw keys-injection tool.
const keyish = Object.keys(tools).filter((n) => /send_keys|send-keys|keys/i.test(n));
ok("no keys-injection tool under any name on the live surface", keyish.length === 0);

console.log(`\nSEND-KEYS-GUARD ${pass > 0 && fail === 0 ? "PASS" : "FAIL"} (${pass} passed, ${fail} failed)`);
rmSync(scratch, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
