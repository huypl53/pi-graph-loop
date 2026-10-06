#!/usr/bin/env node
/** RED-first reproduction for issues-auto-continue. */
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
const src = join(fileURLToPath(new URL(".", import.meta.url)), "..", "src");
process.env.PI_SWARM_AGENT_ID = "root";
process.env.PI_SWARM_IS_ROOT = "1";
const { paths, ensureDirs, readState, writeState } = await import(join(src, "state.ts"));
const { getIssueRun } = await import(join(src, "issues", "state.ts"));
const { handleIssuesCommand } = await import(join(src, "commands", "issues.ts"));
const { advanceNextIssueLocked } = await import(join(src, "issues", "controller.ts"));
const { runPumpMaintenancePhasesLocked } = await import(join(src, "surface", "pump-phases.ts"));
const { sourceHashOf } = await import(join(src, "issues", "snapshot.ts"));
const { validateIssuesSource } = await import(join(src, "issues", "source.ts"));
let failures = 0;
const mark = (label, ok) => { if (!ok) failures++; console.log(`${ok ? "ok" : "FAIL"} ${label}`); };
function fixture() {
 const cwd = mkdtempSync(join(tmpdir(), "issues-auto-cont-") );
 const root = join(cwd, ".pi", "swarm");
 for (const d of ["traces", "mailboxes", "tasks", "issues"]) mkdirSync(join(root,d), {recursive:true});
 mkdirSync(join(cwd,"docs"),{recursive:true});
 writeFileSync(join(root,"issues.yml"), "issues:\n  - id: alpha\n    title: Alpha\n    content: first\n    docs: []\n  - id: beta\n    title: Beta\n    content: second\n    docs: []\n");
 return {cwd,p:paths(cwd),root};
}
async function check(name, fn) { try { await fn(); console.log(`  ok ${name}`); } catch(e) { failures++; console.error(`  FAIL ${name}: ${e.message}`); } }
await check("R1_midrun_append_activates_next", async()=>{
 const {cwd,p,root}=fixture(); await ensureDirs(p);
 const st=await readState(p,cwd); const srcs=validateIssuesSource(readFileSync(join(root,"issues.yml"),"utf8")).issues;
 st.issueRun={status:"running",runId:"run-red1",queue:[{issueId:"alpha",title:"Alpha",sourceHash:sourceHashOf(srcs[0]),status:"done"}]};
 writeFileSync(join(root,"issues.yml"),"issues:\n  - id: alpha\n    title: Alpha\n    content: first\n    docs: []\n  - id: beta\n    title: Beta\n    content: second\n    docs: []\n");
 await advanceNextIssueLocked(p,{cwd},st,{pi:null,deliverMessageLocked:async()=>{},trace:async(_p,e)=>{if(e==="issues.queue_appended") global.appended=true;}});
 assert.equal(st.issueRun.queue.some(q=>q.issueId==="beta"),true,"new item appended");
 assert.equal(st.issueRun.activeIssueId,"beta","appended item activated");
 assert.equal(st.issueRun.queue.find(q=>q.issueId==="beta").status,"active","normal issue activation path used");
 assert.match(readFileSync(p.events,"utf8"),/issues.queue_appended.*beta/,"queue append trace emitted");
 assert.ok(st.issueRun.queue.find(q=>q.issueId==="beta").taskId,"ordinary linked task created");
 assert.ok(st.issueRun.queue.find(q=>q.issueId==="beta").goalId,"ordinary linked goal created");
 assert.ok(st.issueRun.queue.find(q=>q.issueId==="beta").snapshotPath,"ordinary snapshot captured");
 rmSync(cwd,{recursive:true,force:true});
});
await check("R2_done_hash_not_reappended", async()=>{
 const {cwd,p,root}=fixture(); await ensureDirs(p);
 const srcs=validateIssuesSource(readFileSync(join(root,"issues.yml"),"utf8")).issues;
 writeFileSync(join(root,"issues","completions.jsonl"),JSON.stringify({issueId:"beta",sourceHash:sourceHashOf(srcs[1]),priorRunId:"old",completedAt:"now"})+"\n");
 const st=await readState(p,cwd); st.issueRun={status:"running",runId:"run-red2",queue:[{issueId:"alpha",title:"Alpha",sourceHash:sourceHashOf(srcs[0]),status:"done"}]};
 await advanceNextIssueLocked(p,{cwd},st,{pi:null,deliverMessageLocked:async()=>{}});
 assert.equal(st.issueRun.queue.some(q=>q.issueId==="beta"),false,"done-hash item must not append"); rmSync(cwd,{recursive:true,force:true});
});
await check("R2b_already_queued_source_not_duplicated", async()=>{
 const {cwd,p,root}=fixture(); await ensureDirs(p); const issues=validateIssuesSource(readFileSync(join(root,"issues.yml"),"utf8")).issues;
 const st=await readState(p,cwd); st.issueRun={status:"running",runId:"queued",queue:[{issueId:"alpha",title:"Alpha",sourceHash:sourceHashOf(issues[0]),status:"done"},{issueId:"beta",title:"Beta",sourceHash:sourceHashOf(issues[1]),status:"queued"}]};
 await advanceNextIssueLocked(p,{cwd},st,{pi:null,deliverMessageLocked:async()=>{}}); assert.equal(st.issueRun.queue.filter(q=>q.issueId==="beta").length,1); rmSync(cwd,{recursive:true,force:true});
});
await check("R2c_changed_hash_reopens_issue", async()=>{
 const {cwd,p,root}=fixture(); await ensureDirs(p); writeFileSync(join(root,"issues","completions.jsonl"),JSON.stringify({issueId:"beta",sourceHash:"old-hash",priorRunId:"old",completedAt:"now"})+"\n");
 const st=await readState(p,cwd); const issues=validateIssuesSource(readFileSync(join(root,"issues.yml"),"utf8")).issues; st.issueRun={status:"running",runId:"changed",queue:[{issueId:"alpha",title:"Alpha",sourceHash:sourceHashOf(issues[0]),status:"done"}]};
 await advanceNextIssueLocked(p,{cwd},st,{pi:null,deliverMessageLocked:async()=>{}}); assert.equal(st.issueRun.queue.find(q=>q.issueId==="beta").status,"active"); rmSync(cwd,{recursive:true,force:true});
});
await check("R3_complete_auto_starts_next_and_default_off", async()=>{
 const {cwd,p,root}=fixture(); await ensureDirs(p);
 writeFileSync(join(cwd,".pi","swarm.yml"),"issues:\n  autoContinue: true\n");
 const st=await readState(p,cwd); const issues=validateIssuesSource(readFileSync(join(root,"issues.yml"),"utf8")).issues;
 writeFileSync(join(root,"issues","completions.jsonl"),JSON.stringify({issueId:"alpha",sourceHash:sourceHashOf(issues[0]),priorRunId:"prior",completedAt:"now"})+"\n");
 st.issueRun={status:"complete",runId:"prior",queue:[{issueId:"alpha",title:"Alpha",sourceHash:sourceHashOf(issues[0]),status:"done"}],autoContinueCount:0};
 await runPumpMaintenancePhasesLocked({} ,{cwd,isIdle:()=>true},p,st,Date.now(),"auto-continue-test");
 assert.equal(st.issueRun.status,"running","pump tick should start follow-on run"); assert.equal(st.issueRun.queue[0].issueId,"beta");
 rmSync(cwd,{recursive:true,force:true});
});
await check("R4_unsuccessful_run_never_starts", async()=>{
 const {cwd,p,root}=fixture(); await ensureDirs(p); writeFileSync(join(cwd,".pi","swarm.yml"),"issues:\n  autoContinue: true\n");
 const issues=validateIssuesSource(readFileSync(join(root,"issues.yml"),"utf8")).issues; const st=await readState(p,cwd);
 st.issueRun={status:"complete",runId:"bad",queue:[{issueId:"alpha",title:"Alpha",sourceHash:sourceHashOf(issues[0]),status:"failed"}]};
 await runPumpMaintenancePhasesLocked({}, {cwd,isIdle:()=>true},p,st,Date.now(),"safety-stop-test");
 assert.equal(st.issueRun.status,"complete","failed run stays complete without continuation"); rmSync(cwd,{recursive:true,force:true});
});
await check("R5_cap_notifies_and_stops", async()=>{
 const {cwd,p,root}=fixture(); await ensureDirs(p); writeFileSync(join(cwd,".pi","swarm.yml"),"issues:\n  autoContinue: true\n  autoContinueCap: 1\n");
 const issues=validateIssuesSource(readFileSync(join(root,"issues.yml"),"utf8")).issues; const st=await readState(p,cwd);
 st.issueRun={status:"complete",runId:"cap",queue:[{issueId:"alpha",title:"Alpha",sourceHash:sourceHashOf(issues[0]),status:"done"}],autoContinueCount:1}; let body="";
 await runPumpMaintenancePhasesLocked({}, {cwd,isIdle:()=>true},p,st,Date.now(),"cap-test");
 const capEntries=readFileSync(p.root+"/mailboxes/root.jsonl","utf8").split("\n").filter(Boolean).map(JSON.parse);
 body=capEntries.map(m=>m.body).join("\n"); assert.match(body,/auto-continue paused: cap reached/); rmSync(cwd,{recursive:true,force:true});
});
await check("R5_default_cap_is_three_and_only_auto_start_increments", async()=>{
 const {cwd,p,root}=fixture(); await ensureDirs(p); writeFileSync(join(cwd,".pi","swarm.yml"),"issues:\n  autoContinue: true\n");
 const issues=validateIssuesSource(readFileSync(join(root,"issues.yml"),"utf8")).issues;
 writeFileSync(join(root,"issues","completions.jsonl"),JSON.stringify({issueId:"alpha",sourceHash:sourceHashOf(issues[0]),priorRunId:"old",completedAt:"now"})+"\n");
 const st=await readState(p,cwd); st.issueRun={status:"complete",runId:"cap-default",queue:[{issueId:"alpha",title:"Alpha",sourceHash:sourceHashOf(issues[0]),status:"done"}],autoContinueCount:0};
 await runPumpMaintenancePhasesLocked({}, {cwd,isIdle:()=>true},p,st,Date.now(),"default-cap-test");
 assert.equal(st.issueRun.autoContinueCount,1,"auto-run increments carried chain count"); rmSync(cwd,{recursive:true,force:true});
});
await check("R6_default_off", async()=>{
 const {cwd,p,root}=fixture(); await ensureDirs(p); const issues=validateIssuesSource(readFileSync(join(root,"issues.yml"),"utf8")).issues; const st=await readState(p,cwd);
 st.issueRun={status:"complete",runId:"off",queue:[{issueId:"alpha",title:"Alpha",sourceHash:sourceHashOf(issues[0]),status:"done"}]};
 await runPumpMaintenancePhasesLocked({}, {cwd,isIdle:()=>true},p,st,Date.now(),"default-off-test");
 assert.equal(st.issueRun.status,"complete","default-off run remains complete"); rmSync(cwd,{recursive:true,force:true});
});
await check("R7_stop_during_active_run_halts_later_advance", async()=>{
 const {cwd,p,root}=fixture(); await ensureDirs(p); const issues=validateIssuesSource(readFileSync(join(root,"issues.yml"),"utf8")).issues;
 const st=await readState(p,cwd); st.issueRun={status:"stopped",runId:"stopped",autoContinueDisabled:true,queue:[{issueId:"alpha",title:"Alpha",sourceHash:sourceHashOf(issues[0]),status:"cancelled"},{issueId:"beta",title:"Beta",sourceHash:sourceHashOf(issues[1]),status:"queued"}]};
 assert.equal(await advanceNextIssueLocked(p,{cwd},st,{pi:null,deliverMessageLocked:async()=>{}}),false); assert.equal(st.issueRun.activeIssueId,undefined); assert.equal(st.issueRun.queue[1].status,"queued"); rmSync(cwd,{recursive:true,force:true});
});
await check("R7_explicit_stop_sets_latch_until_explicit_start", async()=>{
 const {cwd,p}=fixture(); await ensureDirs(p);
 await handleIssuesCommand("issues",["start"],{cwd,ui:{notify:()=>{}}},p,{});
 await handleIssuesCommand("issues",["stop"],{cwd,ui:{notify:()=>{}}},p,{});
 let st=await readState(p,cwd); assert.equal(getIssueRun(st).status,"stopped"); assert.equal(getIssueRun(st).autoContinueDisabled,true);
 rmSync(join(cwd,".pi","swarm","tasks"),{recursive:true,force:true}); mkdirSync(join(cwd,".pi","swarm","tasks"),{recursive:true});
 delete st.goal; await writeState(p,st);
 await handleIssuesCommand("issues",["start"],{cwd,ui:{notify:()=>{}}},p,{});
 st=await readState(p,cwd); assert.equal(getIssueRun(st).autoContinueDisabled,false); assert.equal(getIssueRun(st).autoContinueCount,0);
 rmSync(cwd,{recursive:true,force:true});
});
console.log(`issues-auto-continue regression: ${failures===0?"PASS":"FAIL"} (${failures} failed)`);
if (failures>0) process.exitCode=1;
