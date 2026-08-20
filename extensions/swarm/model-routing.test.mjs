// Issue E: default model/provider routing hardcodes glm-5.1/zai-coding-cn.
//
// Bug (docs/swarm/edge-cases-multi-agent.md §7.1): providerForModel() returns DEFAULT_PROVIDER
// ("zai-coding-cn") for EVERY model except the fast preset — a claude-* or any non-glm model spawned
// without an explicit provider is silently routed to zai. Fix: known presets win, then explicit
// settings/env, else undefined so the caller decides (spawn still falls back with a trace warning).
//
// Run: node extensions/swarm/model-routing.test.mjs
import { providerForModel, currentProvider } from "./index.ts";

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.error("  FAIL:", name); } };

// Fast preset stays pinned.
ok("fast model -> openai preset", providerForModel("gpt-5.4-mini") === "openai");

// The bug: unknown models were forced onto zai. After the fix providerForModel returns undefined
// for unknown models with no settings/env override, instead of a wrong hardcode.
const savedModel = process.env.PI_SWARM_DEFAULT_MODEL;
const savedProvider = process.env.PI_SWARM_DEFAULT_PROVIDER;
delete process.env.PI_SWARM_DEFAULT_MODEL;
delete process.env.PI_SWARM_DEFAULT_PROVIDER;
const savedCwd = process.cwd();
// Point settings lookup at a dir with no .pi/settings.json so settings don't leak in.
process.chdir(await import("node:os").then((o) => o.tmpdir()));
ok("unknown model (claude-...) has no forced provider", providerForModel("claude-sonnet-4") === undefined);
ok("unknown model (glm-5.1 default) has no forced provider", providerForModel("glm-5.1") === undefined);
ok("explicit env provider wins for unknown model", (() => { process.env.PI_SWARM_DEFAULT_PROVIDER = "acme"; const v = currentProvider("claude-sonnet-4"); delete process.env.PI_SWARM_DEFAULT_PROVIDER; return v === "acme"; })());
ok("currentProvider falls back to DEFAULT_PROVIDER at the final boundary", currentProvider("claude-sonnet-4") === "zai-coding-cn");
process.chdir(savedCwd);
if (savedModel) process.env.PI_SWARM_DEFAULT_MODEL = savedModel;
if (savedProvider) process.env.PI_SWARM_DEFAULT_PROVIDER = savedProvider;

console.log(`\n${fail === 0 ? "PASS" : "FAIL"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
