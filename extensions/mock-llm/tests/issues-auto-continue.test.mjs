#!/usr/bin/env node
/** Fixture shape + opt-in mock-LLM smoke for automatic issue continuation. */
import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const here=dirname(fileURLToPath(import.meta.url));
const fixture=join(here,"..","fixtures","issues-auto-continue.jsonl");
assert.ok(existsSync(fixture),"fixture exists");
const turns=readFileSync(fixture,"utf8").trim().split("\n").map(JSON.parse);
assert.equal(turns.length,1);
assert.match(turns[0].events[0].text,/autoContinue/);
assert.equal(turns[0].stopReason,"stop");
console.log("ISSUES-AUTO-CONTINUE fixture shape PASS");
if(process.env.RUN_SWARM_ISSUES_AUTO_CONTINUE_LANE === "1") {
  // Human-visible behavior is exercised through the deterministic state/controller lane;
  // the fixture verifies the real pi mock provider is loadable without a paid model.
  const { spawnSync }=await import("node:child_process");
  const repo=join(here,"..","..","..");
  const res=spawnSync("pi",["-ne","-e",join(repo,"extensions/mock-llm"),"-e",join(repo,"extensions/swarm"),"--provider","mock-llm","--model","issues-auto-continue","-p","report the automatic continuation"],{cwd:repo,encoding:"utf8",timeout:120000,env:{...process.env,PI_SWARM_TERMINAL_MANAGER:"tmux"}});
  assert.equal(res.status,0,String(res.stderr||"").slice(-1000));
  console.log("ISSUES-AUTO-CONTINUE mock-llm lane PASS");
}
