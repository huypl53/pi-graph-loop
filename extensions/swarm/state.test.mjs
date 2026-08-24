// Rolling backup tests for swarm-state.json + task.json (keep-5).
// Run: node extensions/swarm/state.test.mjs
import { mkdirSync, readdirSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paths, readState, writeState, taskPaths, readTaskState, writeTaskState } from "./src/state.ts";

const scratch = join(tmpdir(), `swarm-state-backup-${process.pid}-${Date.now()}`);
rmSync(scratch, { recursive: true, force: true });
mkdirSync(scratch, { recursive: true });

let fail = 0;
const ok = (name, cond) => { if (cond) console.log("  ok  ", name); else { fail++; console.error("  FAIL", name); } };

const p = paths(scratch);

// --- swarm-state.json: 6 writes -> exactly 5 backups, oldest pruned ---
const contents = [];
for (let i = 1; i <= 6; i++) {
	const st = await readState(p, scratch);
	st.messages[`m${i}`] = { id: `m${i}` };
	contents.push(JSON.parse(JSON.stringify(st)));
	await writeState(p, st);
}
const stateBackups = readdirSync(join(p.root, "backups")).filter((f) => f.startsWith("swarm-state.json."));
ok("6 state writes produce exactly 5 backups (keep-5)", stateBackups.length === 5);
ok("backup names are timestamped+unique", stateBackups.every((f) => /^swarm-state\.json\.\d+-\d{6}-[0-9a-f]+$/.test(f)));
// Backups sorted ascending by ts: contents should be writes 1..5 (write 6's pre-state = write 5 content).
// Backups ascending by ts: pre-states of writes 2..6, i.e. messages grow [m1], [m1,m2], ..., [m1..m5].
const ts = (f) => { const m = f.match(/\.(\d+)-(\d+)/); return m ? parseInt(m[1], 10) * 1e7 + parseInt(m[2], 10) : 0; };
const sorted = [...stateBackups].sort((a, b) => ts(a) - ts(b));
const sizes = sorted.map((f) => Object.keys(JSON.parse(readFileSync(join(p.root, "backups", f), "utf8")).messages).length);
ok("backups capture pre-rewrite states in order", sizes.join(",") === "1,2,3,4,5");
const lastBackup = JSON.parse(readFileSync(join(p.root, "backups", sorted[sorted.length - 1]), "utf8"));
ok("newest backup matches pre-rewrite state", Boolean(lastBackup.messages.m5) && !lastBackup.messages.m6);
// The empty default-state backup from write 1 must have been pruned (only 5 kept, oldest dropped).
ok("oldest backup pruned after 6th write", sizes[0] !== 0);

// --- task.json: same rolling behavior ---
const tp = taskPaths(p, "task-backup-test");
for (let i = 1; i <= 6; i++) {
	let task = null;
	if (existsSync(tp.taskJson)) { try { task = await readTaskState(tp.taskJson); } catch { task = null; } }
	if (!task) {
		task = { version: 1, taskId: "task-backup-test", title: "t", goal: "g", status: "in_progress", priority: "normal", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), owner: "o", workflow: "feature-dev", allowedFiles: [], acceptanceCriteria: [], validationCommands: [], start: "a", currentNodes: [], sharedContext: { summary: "", decisions: [], openQuestions: [], risks: [] }, nodes: { a: { status: "pending", role: "w", dependsOn: [], messageIds: [], attempts: 0 } }, edges: [], handoffs: [], gates: {}, editLocks: {}, evidence: {} };
	}
	task.sharedContext.summary = `v${i}`;
	await writeTaskState(tp, task);
}
const taskBackups = readdirSync(join(tp.root, "backups")).filter((f) => f.startsWith("task.json."));
ok("6 task writes produce exactly 5 backups", taskBackups.length === 5);
const finalTask = await readTaskState(tp.taskJson);
ok("final task.json intact (v6)", finalTask.sharedContext.summary === "v6");
const newestTaskBackup = [...taskBackups].sort((a, b) => ts(a) - ts(b)).pop();
const bt = JSON.parse(readFileSync(join(tp.root, "backups", newestTaskBackup), "utf8"));
ok("newest task backup matches pre-rewrite state (v5)", bt.sharedContext.summary === "v5");

// --- readState still works after all this ---
const stFinal = await readState(p, scratch);
ok("readState still healthy", Boolean(stFinal.messages.m6));

rmSync(scratch, { recursive: true, force: true });
if (fail) { console.error(`\nSTATE BACKUP FAIL (${fail})`); process.exit(1); }
console.log("\nSTATE BACKUP PASS");
