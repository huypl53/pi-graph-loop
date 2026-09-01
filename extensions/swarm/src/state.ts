// === swarm/state.ts — auto-extracted from index.ts (verbatim bodies) ===
import { defineTool, CONFIG_DIR_NAME, truncateHead, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, writeFile, appendFile, rm, stat, rename, readdir, realpath } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname, relative, sep, basename } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { EvidenceDigest, IterationSession, LoopState, MemoryRecord, MetricContract, Paths, RunRecord, SwarmState, TaskPaths, TaskState } from "./types.ts";
import { EXT, LOCK_STALE_MS, STATE_VERSION } from "./constants.ts";
import { ensureAgentDefaults, isSafeRelativePath, normalizeTaskNode, now, projectSlug, safeId, sleep } from "./utils.ts";
import { tmux } from "./tmux.ts";

export function paths(cwd: string): Paths {
	const root = join(cwd, CONFIG_DIR_NAME, EXT);
	return {
		root,
		state: join(root, "swarm-state.json"),
		lock: join(root, "swarm-state.lock"),
		mailboxes: join(root, "mailboxes"),
		agentsDir: join(root, "agents"),
		tasksDir: join(root, "tasks"),
		traces: join(root, "traces"),
		tmuxTraces: join(root, "traces", "tmux"),
		events: join(root, "traces", "events.jsonl"),
		metricsDir: join(root, "metrics"),
		runsDir: join(root, "runs"),
		runArtifactsDir: join(root, "runs"),
		memoryDir: join(root, "memory"),
		iterationsDir: join(root, "iterations"),
		loopsDir: join(root, "loops"),
	};
}

export function taskPaths(p: Paths, taskId: string): TaskPaths {
	const root = join(p.tasksDir, safeId(taskId));
	return {
		root,
		taskMd: join(root, "task.md"),
		taskJson: join(root, "task.json"),
		events: join(root, "events.jsonl"),
		artifacts: join(root, "artifacts"),
	};
}

export async function ensureDirs(p: Paths) {
	await mkdir(p.mailboxes, { recursive: true });
	await mkdir(p.agentsDir, { recursive: true });
	await mkdir(p.tasksDir, { recursive: true });
	await mkdir(p.tmuxTraces, { recursive: true });
	await mkdir(p.metricsDir, { recursive: true });
	await mkdir(p.runsDir, { recursive: true });
	await mkdir(p.memoryDir, { recursive: true });
	await mkdir(p.iterationsDir, { recursive: true });
	await mkdir(p.loopsDir, { recursive: true });
}

export async function withLock<T>(p: Paths, fn: () => Promise<T>): Promise<T> {
	await mkdir(dirname(p.lock), { recursive: true });
	const started = Date.now();
	while (true) {
		try {
			await mkdir(p.lock);
			break;
		} catch (err: any) {
			if (err?.code !== "EEXIST") throw err;
			try {
				const s = await stat(p.lock);
				if (Date.now() - s.mtimeMs > LOCK_STALE_MS) await rm(p.lock, { recursive: true, force: true });
			} catch {}
			if (Date.now() - started > LOCK_STALE_MS * 2) throw new Error(`Timed out acquiring swarm lock: ${p.lock}`);
			await sleep(80);
		}
	}
	try {
		return await fn();
	} finally {
		await rm(p.lock, { recursive: true, force: true });
	}
}

export function defaultState(cwd: string): SwarmState {
	const swarmId = `swarm-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${randomUUID().slice(0, 6)}`;
	const ts = now();
	return {
		version: STATE_VERSION,
		swarmId,
		cwd,
		tmuxSession: `pi-swarm-${projectSlug(cwd)}-${swarmId.slice(-6)}`,
		agents: {},
		delivered: {},
		messages: {},
		proxyMetrics: { hungButAlive: 0, staleOpen: 0, supersessionChurn: 0 },
		createdAt: ts,
		updatedAt: ts,
	};
}

// Best-effort: move a corrupt JSON file aside so subsequent reads re-create it from defaults.
// Never throws — callers decide whether to recover silently (readState) or surface a clear error
// (the typed readers, whose callers already guard unreadable files via try/catch).
async function backupCorruptFile(file: string): Promise<void> {
	try {
		await rename(file, `${file}.corrupt.bak`);
	} catch { /* best-effort; the caller's error message already references the .bak path */ }
}

function corruptParseError(file: string, err: unknown): Error {
	const message = err instanceof Error ? err.message : String(err);
	return new Error(`Failed to parse ${file}: ${message} (backed up to ${file}.corrupt.bak)`);
}

export async function readState(p: Paths, cwd: string): Promise<SwarmState> {
	await ensureDirs(p);
	if (!existsSync(p.state)) {
		const st = defaultState(cwd);
		await atomicWriteFile(p.state, `${JSON.stringify(st, null, 2)}\n`);
		return st;
	}
	let st: SwarmState;
	try {
		st = JSON.parse(await readFile(p.state, "utf8")) as SwarmState;
	} catch (err) {
		// Corrupt swarm-state.json: back it up best-effort, trace the recovery, and return a fresh
		// default so the extension stays usable (agents/messages reset rather than crashing the
		// session). The backup preserves the bad bytes for post-mortem.
		const message = err instanceof Error ? err.message : String(err);
		await backupCorruptFile(p.state);
		await trace(p, "state.corrupt_recovered", { file: p.state, error: message });
		return defaultState(cwd);
	}
	st.messages ||= {};
	st.delivered ||= {};
	st.orchestratorPumpSessions ||= {};
	// Orphan-spawn watchdog ledger (Issue 14): back-fill `[]` so pre-policy swarms boot cleanly and
	// downstream code can use `state.recentSpawns.find(...)` without a null guard. The watchdog
	// itself re-arms timers lazily on the next spawn for any entries that survive a restart
	// (v1 limitation: stranded entries are observable but not auto-rearmed — see operations.md).
	st.recentSpawns ||= [];
	st.agents ||= {};
	// Orchestrator durable consumer receipts (issue 11): back-fill so pre-policy swarms boot fine.
	// The first pump against `revision === 0` runs a one-time migration back-fill that writes
	// receipts for legacy `requiresAck: true` messages that are no longer actionable.
	st.consumerReceipts ||= {};
	st.consumerReceipts.orchestrator ||= { entries: {}, revision: 0 };
	// === Binding C-1 (Issue 18 plan review): goal field back-fill ===
	// The `goal` field on SwarmState is OPTIONAL. A pre-policy swarm-state.json file has no `goal` key
	// (JSON parses absent keys to `undefined`), and undefined is the correct initial state — the pump
	// early-returns on `!goal` before touching any goal field. Do NOT add `st.goal ||= {}` here: that
	// would replace `undefined` with an empty object and crash `goal.id` access in the pump's
	// evaluateIdleGoalNudgeLocked path. Leave this comment in place so a future maintainer does not
	// copy the `consumerReceipts` pattern verbatim onto the goal field.
	//
	// (structurally identical to `orchestratorLeader?: OrchestratorLeader`, which is also additive
	// and not back-filled — absent === vacant for that field too.)
	// orchestratorLeader is additive (roadmap issue 8): absent === vacant. readState leaves the
	// field as-is on legacy swarms so the first orchestrator-authoritative mutation claims it.
	// Back-fill structured reuse metadata for agents persisted before these fields existed.
	for (const a of Object.values(st.agents)) ensureAgentDefaults(a);
	return st;
}

export async function atomicWriteFile(file: string, content: string) {
	await mkdir(dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
	await writeFile(tmp, content, "utf8");
	await rename(tmp, file);
}

// Rolling backup: before overwriting a state file, copy the current contents aside so there is
// always a restore point (case study: 89KB corruption with no backup). Backups live in a
// `backups/` dir next to the file's parent scope (swarm root or task dir), named
// `<basename>.<ms-timestamp>`. Keeps the newest KEEP_BACKUPS per file; pruning is best-effort.
const KEEP_BACKUPS = 5;
let backupSeq = 0;

async function backupBeforeWrite(file: string, backupsDir: string): Promise<void> {
	try {
		if (!existsSync(file)) return;
		const prev = await readFile(file, "utf8");
		await mkdir(backupsDir, { recursive: true });
		// Unique-ify with a random suffix when two writes land in the same millisecond —
		// duplicate timestamped names would silently overwrite each other.
		const name = `${basename(file)}.${Date.now()}-${String(backupSeq++).padStart(6, "0")}-${randomUUID().slice(0, 6)}`;
		await writeFile(join(backupsDir, name), prev, "utf8");
		// Prune oldest backups of this file beyond KEEP_BACKUPS.
		const prefix = `${basename(file)}.`;
		const ts = (f) => { const m = f.slice(prefix.length).match(/^(\d+)-(\d+)/); return m ? parseInt(m[1], 10) * 1e7 + parseInt(m[2], 10) : 0; };
		const entries = (await readdir(backupsDir)).filter((f) => f.startsWith(prefix) && /^\d+/.test(f.slice(prefix.length))).sort((a, b) => ts(a) - ts(b));
		for (const old of entries.slice(0, Math.max(0, entries.length - KEEP_BACKUPS))) {
			try { await rm(join(backupsDir, old), { force: true }); } catch { /* best-effort */ }
		}
	} catch { /* best-effort; backup must never block the write */ }
}

export async function writeState(p: Paths, state: SwarmState) {
	state.updatedAt = now();
	await backupBeforeWrite(p.state, join(p.root, "backups"));
	await atomicWriteFile(p.state, `${JSON.stringify(state, null, 2)}\n`);
}

export async function appendJsonl(file: string, value: unknown) {
	await mkdir(dirname(file), { recursive: true });
	await appendFile(file, `${JSON.stringify(value)}\n`, "utf8");
}

export async function readTaskState(file: string): Promise<TaskState> {
	let task: TaskState;
	try {
		task = JSON.parse(await readFile(file, "utf8")) as TaskState;
	} catch (err) {
		// Unreadable task.json: back it up and surface a clear error. Reconcile's task_skip path
		// (try { readTaskState } catch { continue }) and other guarded callers handle this; after
		// the backup, existsSync(file) is false so the task is skipped on subsequent reads.
		await backupCorruptFile(file);
		throw corruptParseError(file, err);
	}
	task.nodes = Object.fromEntries(Object.entries(task.nodes || {}).map(([id, node]) => [id, normalizeTaskNode(node)]));
	task.edges ||= [];
	task.currentNodes ||= [];
	task.allowedFiles ||= [];
	task.acceptanceCriteria ||= [];
	task.validationCommands ||= [];
	task.handoffs ||= [];
	task.gates ||= {};
	task.editLocks ||= {};
	task.evidence ||= {};
	task.reworkConsumption ||= [];
	task.sharedContext ||= { summary: "", decisions: [], openQuestions: [], risks: [] };
	return task;
}

export async function writeTaskState(tp: TaskPaths, task: TaskState) {
	task.updatedAt = now();
	await backupBeforeWrite(tp.taskJson, join(tp.root, "backups"));
	await atomicWriteFile(tp.taskJson, `${JSON.stringify(task, null, 2)}\n`);
}

export async function traceTask(tp: TaskPaths, event: string, data: Record<string, unknown> = {}) {
	await appendJsonl(tp.events, { ts: now(), event, ...data });
}

export async function readTaskByRef(p: Paths, ref: { taskId?: string; path?: string }): Promise<{ task: TaskState; tp: TaskPaths; taskId: string }> {
	let file: string | undefined;
	if (ref.path && existsSync(ref.path)) file = ref.path;
	else if (ref.taskId) {
		const candidate = taskPaths(p, safeId(ref.taskId));
		if (existsSync(candidate.taskJson)) file = candidate.taskJson;
	}
	if (!file) throw new Error(`Task not found: ${ref.taskId || ref.path || "(no taskId/path)"}`);
	const task = await readTaskState(file);
	const tp = taskPaths(p, task.taskId);
	return { task, tp, taskId: task.taskId };
}

export async function trace(p: Paths, event: string, data: Record<string, unknown> = {}) {
	await appendJsonl(p.events, { ts: now(), event, ...data });
}

export async function captureGitCommit(pi: ExtensionAPI): Promise<{ available: boolean; baseCommit?: string; headCommit?: string }> {
	try {
		const r = await pi.exec("git", ["rev-parse", "HEAD"], { timeout: 5000 });
		if (r.code !== 0) return { available: false };
		const head = (r.stdout || "").trim();
		if (!head) return { available: false };
		// A single snapshot is intentionally NOT treated as proof of a change. A code/config-changing
		// run still needs a .patch/.diff ref unless callers later provide distinct base/head commits.
		return { available: true, baseCommit: head, headCommit: head };
	} catch {
		return { available: false };
	}
}

export async function resolveEvidencePath(cwd: string, ref: string): Promise<string> {
	const [base, target] = await Promise.all([realpath(cwd), realpath(join(cwd, ref))]);
	if (target !== base && !target.startsWith(`${base}${sep}`)) throw new Error(`evidence ref resolves outside project cwd: ${ref}`);
	return target;
}

export async function captureEvidenceDigests(cwd: string, refs: string[]): Promise<EvidenceDigest[]> {
	const out: EvidenceDigest[] = [];
	for (const ref of refs) {
		if (!isSafeRelativePath(ref)) continue;
		try {
			const data = await readFile(await resolveEvidencePath(cwd, ref));
			out.push({ ref, sha256: createHash("sha256").update(data).digest("hex"), size: data.byteLength });
		} catch { /* existence/boundary is enforced by the promotion gate, not run recording */ }
	}
	return out;
}

export async function readJsonlRecords<T = any>(file: string): Promise<T[]> {
	let raw: string;
	try { raw = await readFile(file, "utf8"); } catch { return []; }
	const out: T[] = [];
	for (const line of raw.split("\n")) {
		const t = line.trim();
		if (!t) continue;
		try { out.push(JSON.parse(t) as T); } catch { /* malformed records are ignored by legacy readers */ }
	}
	return out;
}

// Append-only JSONL with status transitions: readers keep only the latest line per id field.
export async function readJsonlLatestById<T extends Record<string, any>>(file: string, idField: string): Promise<T[]> {
	const all = await readJsonlRecords<T>(file);
	const latest = new Map<string, T>();
	for (const rec of all) {
		const id = rec?.[idField];
		if (typeof id === "string") latest.set(id, rec);
	}
	return Array.from(latest.values());
}

export async function checkEvidenceRefs(cwd: string, refs: string[]): Promise<{ ok: boolean; reasons: string[]; checked: { ref: string; exists: boolean; readable: boolean }[] }> {
	const reasons: string[] = [];
	const checked: { ref: string; exists: boolean; readable: boolean }[] = [];
	for (const ref of refs) {
		if (!isSafeRelativePath(ref)) {
			reasons.push(`evidence ref is unsafe (must be relative, no ..): ${ref}`);
			checked.push({ ref, exists: false, readable: false });
			continue;
		}
		const lexical = join(cwd, ref);
		let exists = false;
		let readable = false;
		try {
			const abs = await resolveEvidencePath(cwd, ref);
			await readFile(abs, "utf8");
			exists = true;
			readable = true;
		} catch (err) {
			exists = existsSync(lexical);
			if (exists && String((err as Error)?.message || err).includes("outside project cwd")) reasons.push(`evidence ref resolves outside project cwd: ${ref}`);
		}
		checked.push({ ref, exists, readable });
		if (!exists) reasons.push(`evidence ref does not exist: ${ref}`);
		else if (!readable && !reasons.some((r) => r === `evidence ref resolves outside project cwd: ${ref}`)) reasons.push(`evidence ref exists but is not readable: ${ref}`);
	}
	return { ok: reasons.length === 0, reasons, checked };
}

export async function verifyEvidenceDigests(cwd: string, refs: string[], digests: EvidenceDigest[] | undefined): Promise<string[]> {
	const reasons: string[] = [];
	const byRef = new Map((digests || []).map((d) => [d.ref, d] as const));
	for (const ref of refs) {
		const recorded = byRef.get(ref);
		if (!recorded) { reasons.push(`evidence ref has no recorded digest: ${ref}`); continue; }
		try {
			const data = await readFile(await resolveEvidencePath(cwd, ref));
			const current = createHash("sha256").update(data).digest("hex");
			if (current !== recorded.sha256 || data.byteLength !== recorded.size) reasons.push(`evidence ref changed after run recording: ${ref}`);
		} catch { /* checkEvidenceRefs reports missing/unreadable */ }
	}
	return reasons;
}

export function iterationFile(p: Paths, iterationId: string) {
	return join(p.iterationsDir, `${safeId(iterationId)}.json`);
}

export async function readIteration(p: Paths, iterationId: string): Promise<IterationSession | undefined> {
	const file = iterationFile(p, iterationId);
	if (!existsSync(file)) return undefined;
	try {
		return JSON.parse(await readFile(file, "utf8")) as IterationSession;
	} catch (err) {
		await backupCorruptFile(file);
		throw corruptParseError(file, err);
	}
}

export async function writeIteration(p: Paths, session: IterationSession) {
	session.updatedAt = now();
	await atomicWriteFile(iterationFile(p, session.iterationId), `${JSON.stringify(session, null, 2)}\n`);
}

export async function readMetricContract(p: Paths, id: string): Promise<MetricContract | undefined> {
	const file = join(p.metricsDir, `${safeId(id)}.json`);
	if (!existsSync(file)) return undefined;
	try {
		return JSON.parse(await readFile(file, "utf8")) as MetricContract;
	} catch (err) {
		await backupCorruptFile(file);
		throw corruptParseError(file, err);
	}
}

export async function latestRuns(p: Paths): Promise<RunRecord[]> {
	return readJsonlLatestById<RunRecord>(join(p.runsDir, "runs.jsonl"), "runId");
}

export async function latestMemories(p: Paths): Promise<MemoryRecord[]> {
	return readJsonlLatestById<MemoryRecord>(join(p.memoryDir, "memory.jsonl"), "memoryId");
}

export function loopStateFile(p: Paths, taskId: string) {
	return join(p.loopsDir, `${safeId(taskId)}.json`);
}

export function loopDir(p: Paths, taskId: string) {
	return join(p.loopsDir, safeId(taskId));
}

export function loopHistoryFile(p: Paths, taskId: string) {
	return join(loopDir(p, taskId), "history.jsonl");
}

export function loopRoundFile(p: Paths, taskId: string, round: number) {
	return join(loopDir(p, taskId), `round-${round}.json`);
}

export async function readLoopState(p: Paths, taskId: string): Promise<LoopState | undefined> {
	const file = loopStateFile(p, taskId);
	if (!existsSync(file)) return undefined;
	try {
		return JSON.parse(await readFile(file, "utf8")) as LoopState;
	} catch (err) {
		// Corrupt loop-state.json: back it up and surface a clear error. After the backup,
		// existsSync(file) is false so the next read returns undefined and the loop self-heals
		// (round restarts from 1) instead of silently masking the corruption.
		await backupCorruptFile(file);
		throw corruptParseError(file, err);
	}
}

export async function writeLoopState(p: Paths, state: LoopState) {
	state.updatedAt = now();
	await atomicWriteFile(loopStateFile(p, state.taskId), `${JSON.stringify(state, null, 2)}\n`);
}

export async function appendLoopHistory(p: Paths, taskId: string, entry: Record<string, unknown>) {
	await mkdir(loopDir(p, taskId), { recursive: true });
	await appendJsonl(loopHistoryFile(p, taskId), { at: now(), ...entry });
}

export function mailboxPath(p: Paths, agentId: string) {
	return join(p.mailboxes, `${safeId(agentId)}.jsonl`);
}

export function identityPath(p: Paths, agentId: string) {
	return join(p.agentsDir, `${safeId(agentId)}.md`);
}
