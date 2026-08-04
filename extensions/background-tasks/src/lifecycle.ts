// background-tasks/lifecycle.ts — spawn / kill / reconcile (design §2, §3, §6).
import { spawn } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import { readFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { realpath } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { WRAPPER } from "./constants.ts";
import { ensureDirs, paths, readState, withLock, writeState } from "./state.ts";
import { genTaskId, now, trace } from "./utils.ts";
import type { BackgroundSettings, BackgroundState, BackgroundTask, BgStatus, ExitMarker } from "./types.ts";

// ---------- helpers ----------

export function isAlive(pid?: number): boolean {
	if (!pid || !Number.isFinite(pid)) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err: any) {
		return err?.code === "EPERM"; // exists but not ours -> treat as alive
	}
}

export async function readExitMarker(absPath: string): Promise<ExitMarker | null> {
	if (!existsSync(absPath)) return null;
	try {
		const raw = (await readFile(absPath, "utf8")).trim();
		if (!raw) return null;
		const m = JSON.parse(raw) as ExitMarker;
		if (typeof m.exitCode !== "number") return null;
		return { exitCode: m.exitCode, signal: typeof m.signal === "string" ? m.signal : "" };
	} catch {
		return null;
	}
}

// Best-effort kernel boot id + boot epoch-ms. macOS: sysctl kern.boottime; Linux: /proc/stat btime.
async function getBootInfo(): Promise<{ bootId?: string; bootMs?: number }> {
	try {
		if (process.platform === "darwin") {
			const r = await runCapture("sysctl", ["-n", "kern.boottime"]);
			const sec = r && r.match(/sec\s*=\s*(\d+)/);
			if (sec) {
				const bootMs = Number(sec[1]) * 1000;
				return { bootId: `darwin:${sec[1]}`, bootMs };
			}
		} else if (process.platform === "linux") {
			const stat = await readFile("/proc/stat", "utf8").catch(() => "");
			const btime = stat.match(/^btime\s+(\d+)/m);
			if (btime) {
				const bootMs = Number(btime[1]) * 1000;
				return { bootId: `linux:${btime[1]}`, bootMs };
			}
		}
	} catch {}
	return {};
}

function runCapture(cmd: string, args: string[]): Promise<string> {
	return new Promise((resolve) => {
		try {
			const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "ignore"] });
			let out = "";
			p.stdout.on("data", (d) => (out += d.toString()));
			p.on("error", () => resolve(""));
			p.on("close", () => resolve(out));
		} catch {
			resolve("");
		}
	});
}

// Containment: target must realpath-resolve to ctx.cwd or a subdir of it.
export async function assertCwdContained(ctxCwd: string, target: string): Promise<string> {
	const [base, tgt] = await Promise.all([realpath(ctxCwd), realpath(target)]);
	if (tgt !== base && !tgt.startsWith(`${base}${sep}`)) {
		throw new Error(`background_start cwd must be inside the project (${ctxCwd}); got ${target}`);
	}
	return tgt;
}

// ---------- finalize (idempotent, forward-only) ----------

function finalize(task: BackgroundTask, patch: Partial<BackgroundTask>) {
	// Never move a terminal task back; only stamp forward.
	if (task.status === "done" || task.status === "failed" || task.status === "killed" || task.status === "unknown") {
		return;
	}
	Object.assign(task, patch);
	task.status = (patch.status as BgStatus) || task.status;
	task.endedAt = task.endedAt || now();
	task.updatedAt = now();
}

function statusForExitCode(exitCode: number | null): BgStatus {
	if (exitCode === null) return "unknown";
	return exitCode === 0 ? "done" : "failed";
}

// ---------- reconcile (idempotent; only moves tasks toward terminal) ----------

export async function reconcileLocked(st: BackgroundState, p = paths(st.cwd), settings?: BackgroundSettings): Promise<{ alive: number; finalized: number }> {
	let alive = 0;
	let finalized = 0;
	const boot = await getBootInfo();
	for (const task of Object.values(st.tasks)) {
		if (task.status !== "pending" && task.status !== "running") continue;
		const marker = await readExitMarker(join(st.cwd, task.exitMarker));
		if (marker) {
			// Case 1: natural exit -> marker is authoritative.
			const before = task.status;
			finalize(task, {
				status: statusForExitCode(marker.exitCode),
				exitCode: marker.exitCode,
				signal: marker.signal || null,
				reapedByExternal: true,
			});
			const after = task.status as BgStatus;
			if (after !== before && (after === "done" || after === "failed")) finalized++;
			continue;
		}
		// No marker: rely on liveness.
		if (!isAlive(task.pid)) {
			// Case 3: dead, no marker -> unknown.
			const before = task.status;
			finalize(task, { status: "unknown", exitCode: null, signal: null, reapedByExternal: true });
			if ((task.status as BgStatus) !== before) finalized++;
			continue;
		}
		// Case "alive, no marker": best-effort PID-reuse check via boot id.
		if (boot.bootId && task.startedAtBoot && boot.bootId !== task.startedAtBoot) {
			const before = task.status;
			finalize(task, { status: "unknown", exitCode: null, signal: null, reapedByExternal: true });
			if ((task.status as BgStatus) !== before) finalized++;
			continue;
		}
		alive++;
	}
	return { alive, finalized };
}

export async function reconcile(cwd: string, settings?: BackgroundSettings): Promise<void> {
	const p = paths(cwd);
	await withLock(p, async () => {
		const st = await readState(p, cwd);
		const r = await reconcileLocked(st, p, settings);
		if (r.finalized > 0) await writeState(p, st);
		await trace(p.events, "reconcile", { alive: r.alive, finalized: r.finalized });
	});
}

// ---------- spawn ----------

export interface StartInput {
	command: string;
	args?: string[];
	cwd: string; // absolute, already containment-checked
	label?: string;
	env?: Record<string, string>;
	shell?: boolean; // default true
	timeoutMs?: number;
	spawnedBySession?: string;
}

export async function spawnTask(
	cwd: string,
	settings: BackgroundSettings,
	input: StartInput,
	onExit: (taskId: string) => void,
): Promise<BackgroundTask> {
	const p = paths(cwd);
	await ensureDirs(p);
	const shell = input.shell !== false;
	const boot = await getBootInfo();
	let task!: BackgroundTask;

	// Everything below (taskId resolution, log streams, spawn, record write) happens under the lock so
	// the pid is recorded before the child can exit and the exit listener always has a record + streams.
	await withLock(p, async () => {
		const st = await readState(p, cwd);
		const running = Object.values(st.tasks).filter((t) => t.status === "running" || t.status === "pending").length;
		if (running >= settings.maxConcurrent) {
			throw new Error(
				`background task concurrency limit reached (${settings.maxConcurrent}). Stop an existing task or raise PI_BG_TASKS_MAX.`,
			);
		}
		// Resolve a non-colliding taskId (design §10 Q11: fall back to a random suffix on collision).
		let taskId = genTaskId(input.label);
		if (st.tasks[taskId]) taskId = `${taskId}-${randomUUID().slice(0, 6)}`;
		await mkdir(p.logs, { recursive: true });
		await mkdir(p.tasksDir, { recursive: true });
		const markerPath = join(p.tasksDir, `${taskId}.exit`); // absolute; the wrapper writes to it
		const outPath = join(p.logs, `${taskId}.out.log`);
		const errPath = join(p.logs, `${taskId}.err.log`);
		const relLogOut = relative(cwd, outPath);
		const relLogErr = relative(cwd, errPath);
		const relMarker = relative(cwd, markerPath);
		const outStream = createWriteStream(outPath, { flags: "a" });
		const errStream = createWriteStream(errPath, { flags: "a" });
		const outCap = { stream: outStream, bytes: 0, capped: false };
		const errCap = { stream: errStream, bytes: 0, capped: false };
		let logTruncated = false;

		task = buildRecord(taskId, input, shell, relLogOut, relLogErr, relMarker, boot);
		// Spawn inside the lock so the pid is recorded before the child can exit.
		const child = spawnChild(input, shell, markerPath, outCap, errCap, settings, () => {
			logTruncated = true;
		});
		task.pid = child.pid;
		task.pgid = child.pid; // detached:true => child is its own process-group leader
		task.status = "running";
		task.updatedAt = now();
		st.tasks[task.taskId] = task;
		await writeState(p, st);
		await trace(p.events, "task.start", {
			taskId: task.taskId,
			command: task.command,
			cwd: task.cwd,
			pid: task.pid,
			label: task.label,
			timeoutMs: task.timeoutMs,
			requestedBy: input.spawnedBySession,
		});

		// Live exit listener -> finalize via its OWN locked re-read (case 2). Fires only while this
		// pi process is alive. A group SIGTERM/SIGKILL kills the wrapper before its printf, so this is
		// the authoritative path for stopped/timed-out tasks.
		child.on("exit", (code, signal) => {
			onExitLive(cwd, task.taskId, code, signal, outCap.stream, errCap.stream, logTruncated);
			try {
				onExit(task.taskId);
			} catch {}
		});
		child.on("error", () => {
			onExitLive(cwd, task.taskId, 1, "ERROR", outCap.stream, errCap.stream, logTruncated);
		});
	});

	return task;
}

function buildRecord(
	taskId: string,
	input: StartInput,
	shell: boolean,
	relLogOut: string,
	relLogErr: string,
	relMarker: string,
	boot: { bootId?: string; bootMs?: number },
): BackgroundTask {
	const ts = now();
	return {
		taskId,
		label: input.label,
		status: "pending",
		command: input.command,
		args: input.args,
		shell,
		cwd: input.cwd,
		env: input.env,
		startedAt: ts,
		timeoutMs: input.timeoutMs,
		spawnedByPid: process.pid,
		spawnedBySession: input.spawnedBySession,
		kind: "shell",
		startedAtBoot: boot.bootId,
		startedAtEpoch: boot.bootMs ? Date.now() - boot.bootMs : undefined,
		logOut: relLogOut,
		logErr: relLogErr,
		exitMarker: relMarker,
		createdAt: ts,
		updatedAt: ts,
	};
}

function spawnChild(
	input: StartInput,
	shell: boolean,
	markerAbsPath: string,
	outCap: { stream: WriteStream; bytes: number; capped: boolean },
	errCap: { stream: WriteStream; bytes: number; capped: boolean },
	settings: BackgroundSettings,
	onCap: (capped: boolean) => void,
) {
	const env = { ...process.env, ...(input.env || {}) };
	let child: ReturnType<typeof spawn>;

	if (!shell) {
		// explicit argv: run directly detached. timeout/watchdog not applied in this mode (V1).
		child = spawn(input.command, input.args || [], {
			cwd: input.cwd,
			env,
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
		});
	} else {
		// shell mode: `sh -c WRAPPER sh <command> <exitMarkerAbs> [timeoutMs]`
		// $0=sh, $1=command, $2=exitMarkerAbs, $3=timeoutMs (omitted when no timeout).
		const timeoutArg = input.timeoutMs && input.timeoutMs > 0 ? String(input.timeoutMs) : "";
		const argv = timeoutArg
			? ["-c", WRAPPER, "sh", input.command, markerAbsPath, timeoutArg]
			: ["-c", WRAPPER, "sh", input.command, markerAbsPath];
		child = spawn("sh", argv, { cwd: input.cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
	}

	pipeCapped(child, outCap, errCap, settings, onCap);
	child.unref();
	return child;
}

function pipeCapped(
	child: ReturnType<typeof spawn>,
	outCap: { stream: WriteStream; bytes: number; capped: boolean },
	errCap: { stream: WriteStream; bytes: number; capped: boolean },
	settings: BackgroundSettings,
	onCap: (capped: boolean) => void,
) {
	const writeCapped = (cap: { stream: WriteStream; bytes: number; capped: boolean }, data: Buffer) => {
		if (cap.capped) return;
		if (cap.bytes + data.length > settings.logMaxBytes) {
			cap.capped = true;
			onCap(true);
			cap.stream.end("[background-tasks] log size cap reached; further output not captured.\n");
			return;
		}
		cap.stream.write(data);
		cap.bytes += data.length;
	};
	child.stdout?.on("data", (d: Buffer) => writeCapped(outCap, d));
	child.stderr?.on("data", (d: Buffer) => writeCapped(errCap, d));
}

// Live finalize path (case 2): the spawning pi is still alive when the child exits.
async function onExitLive(
	cwd: string,
	taskId: string,
	code: number | null,
	signal: string | null,
	outStream: WriteStream,
	errStream: WriteStream,
	logTruncated: boolean,
) {
	const exitCode = code;
	const sig = signal && signal !== null && signal !== "" ? String(signal) : null;
	// Append a sentinel line for humans tail-ing the log.
	try {
		const sentinel = `[bg-task exited code=${exitCode} signal=${sig || ""} at ${now()}]\n`;
		if (!outStream.destroyed) outStream.write(sentinel);
		if (!errStream.destroyed) errStream.write(sentinel);
	} catch {}
	try {
		outStream.end();
		errStream.end();
	} catch {}

	const p = paths(cwd);
	await withLock(p, async () => {
		const st = await readState(p, cwd);
		const task = st.tasks[taskId];
		if (!task) return;
		// Only the live listener can set the signal precisely for case 2. If a marker already
		// finalized this task (case 1), keep that authoritative result.
		const alreadyTerminal =
			task.status === "done" || task.status === "failed" || task.status === "killed" || task.status === "unknown";
		if (alreadyTerminal) {
			if (logTruncated && !task.logTruncated) {
				task.logTruncated = true;
				await writeState(p, st);
			}
			return;
		}
		// SIGTERM/SIGKILL (from background_stop or the watchdog) => killed.
		if (sig === "SIGTERM" || sig === "SIGKILL" || sig === "TERM" || sig === "KILL") {
			finalize(task, { status: "killed", exitCode: exitCode ?? null, signal: sig });
		} else {
			const status: BgStatus = exitCode === null ? "unknown" : exitCode === 0 ? "done" : "failed";
			finalize(task, { status, exitCode: exitCode ?? null, signal: sig });
		}
		if (logTruncated) task.logTruncated = true;
		await writeState(p, st);
		await trace(p.events, "task.finalize", { taskId, status: task.status, exitCode: task.exitCode, signal: task.signal, via: "live" });
	}).catch(() => {});
}

// ---------- kill (whole process group) ----------

export async function killTask(
	cwd: string,
	taskId: string,
	signal: "SIGTERM" | "SIGKILL",
	graceMs: number,
): Promise<BackgroundTask> {
	const p = paths(cwd);
	let result: BackgroundTask | undefined;
	await withLock(p, async () => {
		const st = await readState(p, cwd);
		const task = st.tasks[taskId];
		if (!task) throw new Error(`background task not found: ${taskId}`);
		if (task.status !== "running" && task.status !== "pending") {
			result = task;
			return; // already terminal
		}
		const pid = task.pid;
		const pgid = task.pgid ?? pid;
		if (pgid && isAlive(pgid)) {
			try {
				process.kill(-pgid, signal);
			} catch (err: any) {
				// ESRCH: already gone; fall through to finalize as unknown/killed below.
				if (err?.code !== "ESRCH") throw err;
			}
		}
		finalize(task, { status: "killed", exitCode: task.exitCode ?? null, signal });
		await writeState(p, st);
		await trace(p.events, "task.stop", { taskId, signal, pgid });
		result = task;
	});
	if (!result) throw new Error(`background task not found: ${taskId}`);
	return result;
}

// Fire-and-forget SIGKILL escalation after grace (used by background_stop and killOnShutdown).
export function scheduleKillEscalation(pgid: number | undefined, graceMs: number) {
	if (!pgid || !isAlive(pgid)) return;
	setTimeout(() => {
		try {
			if (isAlive(pgid)) process.kill(-pgid, "SIGKILL");
		} catch {}
	}, graceMs).unref();
}
