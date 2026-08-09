// background-tasks/watchers.ts — event-driven monitoring (design: background_watch).
//
// A watcher registers a condition against a background task:
//   - pattern  : regex matched against NEW combined output (since the last scan)
//   - port     : tcp port readiness on 127.0.0.1 (nudge when it opens)
//   - idle     : no new output for idleMs (stalled build / migration)
// The renderUi tick loop (hooks.ts session_start setInterval) calls evalWatchers() every refreshMs.
// When a condition matches, the agent is nudged via the SAME idle-gated pi.sendUserMessage path as
// the completion nudge — so no new polling/threading infrastructure is required. Watchers persist
// in state.json (survive /reload); cursors advance so only NEW output is matched.
import { open } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import * as net from "node:net";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { paths, readState, withLock, writeState } from "./state.ts";
import { belongsToSession, currentSessionId, now, trace } from "./utils.ts";
import type { BackgroundSettings, BackgroundTask, BgStatus, WatchStatus, Watcher, WatchTrigger } from "./types.ts";

const isTerminal = (s: BgStatus): boolean => s === "done" || s === "failed" || s === "killed" || s === "unknown";

function genWatchId(): string {
	return `watch-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`;
}

// --- regex cache (never store a RegExp in JSON; recompile from source + flags, 'g' stripped) ---
const reCache = new Map<string, RegExp>();
function compileRe(pattern: string, flags?: string): RegExp {
	const f = (flags || "").replace(/g/g, "");
	const key = `${pattern}\u0000${f}`;
	let re = reCache.get(key);
	if (!re) {
		re = new RegExp(pattern, f);
		if (reCache.size > 256) reCache.clear(); // bounded
		reCache.set(key, re);
	}
	return re;
}

// Read a byte range [start, start+cap) from a log file. Returns the decoded text, the next cursor
// (= start + bytes actually read; < file size when capped so the remainder is read next tick), and
// the true file size. Missing file => nothing new.
async function readRange(file: string, start: number, cap: number): Promise<{ text: string; next: number; size: number }> {
	if (!existsSync(file)) return { text: "", next: start, size: start };
	let fh;
	try {
		fh = await open(file, "r");
	} catch {
		return { text: "", next: start, size: start };
	}
	try {
		const stat = await fh.stat();
		const size = stat.size;
		if (size <= start) return { text: "", next: start, size };
		const want = Math.min(cap, size - start);
		const buf = Buffer.alloc(want);
		await fh.read(buf, 0, want, start);
		return { text: buf.toString("utf8"), next: start + want, size };
	} catch {
		return { text: "", next: start, size: start };
	} finally {
		await fh.close().catch(() => {});
	}
}

// tcp connect probe to 127.0.0.1:port within timeoutMs. true => something is accepting.
function checkPort(port: number, timeoutMs: number): Promise<boolean> {
	return new Promise((resolve) => {
		let sock: net.Socket | undefined;
		let done = false;
		const finish = (ok: boolean) => {
			if (done) return;
			done = true;
			try {
				sock?.destroy();
			} catch {}
			resolve(ok);
		};
		try {
			sock = new net.Socket();
			sock.setTimeout(timeoutMs);
			sock.once("connect", () => finish(true));
			sock.once("error", () => finish(false));
			sock.once("timeout", () => finish(false));
			sock.connect({ host: "127.0.0.1", port });
		} catch {
			finish(false);
		}
	});
}

// Strip the human sentinel line (and empties) so it can't match patterns spuriously.
function cleanLines(text: string): string[] {
	return text.split("\n").filter((l) => l.length > 0 && !l.startsWith("[bg-task exited"));
}

function truncateSnippet(s: string, max: number): string {
	const t = s.trim();
	return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function lastMatchLine(text: string, re: RegExp): string {
	let last = "";
	for (const line of cleanLines(text)) if (re.test(line)) last = line;
	// reset lastIndex defensively (our regexes are non-global, but be safe)
	if (re.global) re.lastIndex = 0;
	return last;
}

// ---------------- registration / management (tool-facing) ----------------

export interface RegisterInput {
	taskId: string;
	pattern?: string;
	ignoreCase?: boolean;
	port?: number;
	idleMs?: number;
	once?: boolean;
	ttlMs?: number;
	session?: string;
}

export async function registerWatcher(cwd: string, settings: BackgroundSettings, input: RegisterInput): Promise<Watcher> {
	if (!settings.watch.enabled) throw new Error("background_watch is disabled (PI_BG_TASKS_WATCH=0 / settings).");
	const triggers: WatchTrigger[] = [];
	if (input.pattern !== undefined) triggers.push("pattern");
	if (input.port !== undefined) triggers.push("port");
	if (input.idleMs !== undefined) triggers.push("idle");
	if (triggers.length === 0) {
		throw new Error("background_watch requires exactly one trigger: pattern | port | idleMs.");
	}
	if (triggers.length > 1) {
		throw new Error(`background_watch takes exactly ONE trigger (got ${triggers.join("+")}). Register separate watchers to combine.`);
	}
	const trigger = triggers[0];
	if (trigger === "pattern") {
		if (typeof input.pattern !== "string" || !input.pattern.trim()) throw new Error("pattern must be a non-empty regex string.");
		try {
			compileRe(input.pattern, input.ignoreCase ? "i" : "");
		} catch (err: any) {
			throw new Error(`invalid pattern /${input.pattern}/: ${String((err && err.message) || err)}`);
		}
	}
	if (trigger === "port") {
		const p = Number(input.port);
		if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error(`port must be an integer in 1..65535 (got ${input.port}).`);
	}
	if (trigger === "idle") {
		const m = Number(input.idleMs);
		if (!Number.isFinite(m) || m < 100) throw new Error(`idleMs must be >= 100ms (got ${input.idleMs}).`);
	}

	const p = paths(cwd);
	const ts = now();
	const epoch = Date.now();
	let created!: Watcher;
	await withLock(p, async () => {
		const st = await readState(p, cwd);
		const task = st.tasks[input.taskId];
		if (!task) throw new Error(`background task not found: ${input.taskId}`);
		// Respect session scope: only watch tasks visible to this session.
		if (settings.scopeBySession && !belongsToSession({ spawnedBySession: task.spawnedBySession }, input.session, true)) {
			throw new Error(`task ${input.taskId} belongs to another session; pass allSessions or watch a task in this session.`);
		}
		// Cap armed watchers per session.
		const armed = Object.values(st.watchers!).filter((w) => w.status === "armed" && w.session === input.session).length;
		if (armed >= settings.watch.maxPerSession) {
			throw new Error(`watcher limit reached (${settings.watch.maxPerSession} per session). Cancel one or raise PI_BG_TASKS_WATCH_MAX.`);
		}
		created = {
			watchId: genWatchId(),
			taskId: input.taskId,
			session: input.session,
			createdAt: ts,
			trigger,
			pattern: trigger === "pattern" ? input.pattern : undefined,
			patternFlags: trigger === "pattern" ? (input.ignoreCase ? "i" : "") : undefined,
			port: trigger === "port" ? Number(input.port) : undefined,
			idleMs: trigger === "idle" ? Number(input.idleMs) : undefined,
			once: input.once !== false,
			ttlMs: input.ttlMs && input.ttlMs > 0 ? input.ttlMs : undefined,
			// scan from 0 so the FIRST evaluation sees the whole existing log (readiness fires
			// immediately if already ready); cursors advance thereafter to match only NEW output.
			scanOut: 0,
			scanErr: 0,
			lastOutputAt: epoch,
			status: "armed",
			firedCount: 0,
			updatedAt: ts,
		};
		st.watchers![created.watchId] = created;
		await writeState(p, st);
		await trace(p.events, "watch.register", { watchId: created.watchId, taskId: input.taskId, trigger, once: created.once }).catch(() => {});
	});
	return created;
}

export interface ListWatchersOpts {
	status?: WatchStatus;
	allSessions?: boolean;
	session?: string;
	scopeBySession?: boolean;
}

export async function listWatchers(cwd: string, opts: ListWatchersOpts = {}): Promise<Watcher[]> {
	const p = paths(cwd);
	const st = await readState(p, cwd);
	let list = Object.values(st.watchers!);
	const scope = opts.scopeBySession !== false && !opts.allSessions;
	if (scope) list = list.filter((w) => belongsToSession({ spawnedBySession: w.session }, opts.session, true));
	if (opts.status) list = list.filter((w) => w.status === opts.status);
	return list.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export async function cancelWatcher(cwd: string, opts: { watchId?: string; taskId?: string; session?: string; scopeBySession?: boolean }): Promise<{ cancelled: number }> {
	if (!opts.watchId && !opts.taskId) throw new Error("background_unwatch needs watchId or taskId.");
	const p = paths(cwd);
	let cancelled = 0;
	await withLock(p, async () => {
		const st = await readState(p, cwd);
		const scope = opts.scopeBySession !== false;
		for (const w of Object.values(st.watchers!)) {
			if (opts.watchId && w.watchId !== opts.watchId) continue;
			if (opts.taskId && w.taskId !== opts.taskId) continue;
			if (scope && !belongsToSession({ spawnedBySession: w.session }, opts.session, true)) continue;
			if (st.watchers![w.watchId]) {
				delete st.watchers![w.watchId];
				cancelled++;
			}
		}
		if (cancelled > 0) {
			await writeState(p, st);
			await trace(p.events, "watch.cancel", { cancelled, watchId: opts.watchId, taskId: opts.taskId }).catch(() => {});
		}
	});
	return { cancelled };
}

// Also drop watchers when their task is pruned (called from pruneTerminal).
export async function dropWatchersForTasks(cwd: string, taskIds: string[]): Promise<number> {
	if (taskIds.length === 0) return 0;
	const p = paths(cwd);
	let dropped = 0;
	await withLock(p, async () => {
		const st = await readState(p, cwd);
		for (const id of taskIds) {
			for (const w of Object.values(st.watchers!)) {
				if (w.taskId === id && st.watchers![w.watchId]) {
					delete st.watchers![w.watchId];
					dropped++;
				}
			}
		}
		if (dropped > 0) await writeState(p, st);
	});
	return dropped;
}

// ---------------- nudge formatting ----------------

function formatSingle(w: Watcher, task: BackgroundTask, reason: string, snippet: string, settings: BackgroundSettings): string {
	const name = task.label || task.taskId;
	const head = `[background-tasks watch] Watcher on "${name}" (${w.taskId}) MATCHED: ${reason}.`;
	const body = snippet ? `Last matching output:\n  ${truncateSnippet(snippet, settings.watch.patternMaxLen)}` : "";
	const tail = w.once
		? `The watcher is done. Inspect with background_output(taskId="${w.taskId}") or read ${task.logOut}.`
		: `Monitoring continues (once:false). Inspect with background_output(taskId="${w.taskId}") or read ${task.logOut}.`;
	return [head, body, tail].filter(Boolean).join("\n");
}

function formatCombined(fired: { w: Watcher; task: BackgroundTask; reason: string }[]): string {
	const head = `[background-tasks watch] ${fired.length} watchers fired:`;
	const lines = fired.map((f) => `- "${f.task.label || f.task.taskId}" (${f.w.taskId}): ${f.reason}`);
	const tail = `Inspect each with background_output(taskId=...).`;
	return [head, ...lines, "", tail].join("\n");
}

// ---------------- the tick evaluator (called from renderUi) ----------------

export async function evalWatchers(pi: ExtensionAPI, ctx: any, settings: BackgroundSettings, cwd: string, nudgeState: { sent: boolean } = { sent: false }): Promise<void> {
	if (!settings.watch.enabled) return;
	const p = paths(cwd);
	let st: Awaited<ReturnType<typeof readState>>;
	try {
		st = await readState(p, cwd);
	} catch {
		return;
	}
	const armed = Object.values(st.watchers!).filter((w) => w.status === "armed" || w.status === "fired");
	if (armed.length === 0) return; // fast path: nothing to do most ticks

	const sid = currentSessionId(ctx);
	const scope = settings.scopeBySession;
	const visible = armed.filter((w) => belongsToSession({ spawnedBySession: w.session }, sid, scope));
	if (visible.length === 0) return;

	const nowMs = Date.now();
	const deletes = new Set<string>();
	const firedEvents: { w: Watcher; task: BackgroundTask; reason: string }[] = [];
	let dirty = false;

	for (const w of visible) {
		const task = st.tasks[w.taskId];
		// task gone (pruned) -> cancel silently
		if (!task) {
			deletes.add(w.watchId);
			dirty = true;
			await trace(p.events, "watch.cancel", { watchId: w.watchId, reason: "task_gone" }).catch(() => {});
			continue;
		}

		// ttl expiry -> silent delete
		if (w.ttlMs && w.ttlMs > 0 && nowMs - new Date(w.createdAt).getTime() > w.ttlMs) {
			deletes.add(w.watchId);
			dirty = true;
			await trace(p.events, "watch.expired", { watchId: w.watchId, taskId: w.taskId, reason: "ttl" }).catch(() => {});
			continue;
		}

		// already fired (once) and awaiting nudge delivery -> nothing to evaluate
		if (w.status === "fired") continue;

		// scan NEW output since last cursor
		const cap = settings.watch.rangeReadBytes;
		const ro = await readRange(join(cwd, task.logOut), w.scanOut, cap);
		const re = await readRange(join(cwd, task.logErr), w.scanErr, cap);
		const hadNew = ro.text.length > 0 || re.text.length > 0;
		if (hadNew) w.lastOutputAt = nowMs;
		w.scanOut = ro.next; // advances even when capped so the remainder is read next tick
		w.scanErr = re.next;
		if (ro.next !== ro.size || re.next !== re.size || hadNew) dirty = true;
		const combined = `${ro.text}\n${re.text}`;

		const terminal = isTerminal(task.status);
		let fire = false;
		let reason = "";
		let snippet = "";

		if (w.trigger === "pattern" && w.pattern !== undefined) {
			try {
				const r = compileRe(w.pattern, w.patternFlags);
				if (r.test(combined)) {
					const line = lastMatchLine(combined, r);
					fire = true;
					reason = `pattern /${w.pattern}/${w.patternFlags?.includes("i") ? "i" : ""} matched in new output`;
					snippet = line;
				}
				if (r.global) r.lastIndex = 0;
			} catch {}
		} else if (w.trigger === "port" && w.port !== undefined) {
			if (await checkPort(w.port, settings.watch.portTimeoutMs)) {
				fire = true;
				reason = `port ${w.port} is open on 127.0.0.1`;
			}
		} else if (w.trigger === "idle" && w.idleMs !== undefined) {
			if (nowMs - w.lastOutputAt >= w.idleMs) {
				fire = true;
				reason = `no new output for ${Math.round((nowMs - w.lastOutputAt) / 1000)}s (idle threshold ${Math.round(w.idleMs / 1000)}s)`;
			}
		}

		// rate-limit continuous (once:false) refires
		if (fire && !w.once && w.lastFiredAt && nowMs - w.lastFiredAt < settings.watch.refireMs) {
			fire = false;
		}

		if (fire) {
			w.firedCount += 1;
			w.lastFiredAt = nowMs;
			w.lastSnippet = snippet ? truncateSnippet(snippet, settings.watch.patternMaxLen) : reason;
			w.pendingNudge = formatSingle(w, task, reason, snippet, settings);
			if (w.trigger === "idle") w.lastOutputAt = nowMs; // re-arm the idle window
			if (w.once) w.status = "fired"; // stop scanning; awaits nudge delivery then deleted
			dirty = true;
			firedEvents.push({ w, task, reason });
			await trace(p.events, "watch.fire", { watchId: w.watchId, taskId: w.taskId, trigger: w.trigger, once: w.once, firedCount: w.firedCount }).catch(() => {});
		}

		// terminal task: a once watcher that fired (status fired) survives for nudge delivery;
		// everything still armed on a dead task can never fire again -> remove.
		if (terminal && w.status === "armed") {
			deletes.add(w.watchId);
			dirty = true;
			await trace(p.events, "watch.expired", { watchId: w.watchId, taskId: w.taskId, reason: "task_terminal" }).catch(() => {});
		}
	}

	// --- nudge delivery (idle-gated, exactly like the completion nudge) ---
	const pending = visible.filter((w) => w.pendingNudge && !deletes.has(w.watchId));
	if (pending.length > 0) {
		let idle = false;
		try {
			idle = ctx.mode === "tui" && ctx.isIdle();
		} catch {}
		if (idle && !nudgeState.sent) {
			try {
				const msg =
					pending.length === 1
						? pending[0].pendingNudge!
						: formatCombined(
								pending.map((w) => {
									const task = st.tasks[w.taskId]!;
									return { w, task, reason: w.lastSnippet || w.trigger };
								}),
							);
				pi.sendUserMessage(msg);
				nudgeState.sent = true;
				for (const w of pending) {
					w.pendingNudge = undefined;
					if (w.once && w.status === "fired") deletes.add(w.watchId); // delivered -> clean up
				}
				dirty = true;
				await trace(p.events, "watch.nudge.sent", { count: pending.length, sid }).catch(() => {});
			} catch (err: any) {
				await trace(p.events, "watch.nudge.send_error", { error: String((err && err.message) || err) }).catch(() => {});
			}
		} else {
			// busy (or non-TUI): defer — leave pendingNudge set so a later idle tick delivers it.
			await trace(p.events, "watch.nudge.deferred", { count: pending.length, idle }).catch(() => {});
		}
	}

	// --- persist (best-effort, separate lock; never block the tick) ---
	if (dirty || deletes.size > 0) {
		try {
			const { readState, writeState } = await import("./state.ts");
			await withLock(p, async () => {
				const cur = await readState(p, cwd);
				for (const w of visible) {
					if (deletes.has(w.watchId)) {
						if (cur.watchers![w.watchId]) delete cur.watchers![w.watchId];
						continue;
					}
					const dst = cur.watchers![w.watchId];
					if (!dst) continue; // vanished concurrently (pruned) -> drop our update
					// copy mutated scalar fields onto the authoritative record
					dst.scanOut = w.scanOut;
					dst.scanErr = w.scanErr;
					dst.lastOutputAt = w.lastOutputAt;
					dst.status = w.status;
					dst.firedCount = w.firedCount;
					if (w.lastFiredAt !== undefined) dst.lastFiredAt = w.lastFiredAt;
					if (w.lastSnippet !== undefined) dst.lastSnippet = w.lastSnippet;
					if (w.pendingNudge !== undefined) dst.pendingNudge = w.pendingNudge;
					else if (dst.pendingNudge !== undefined) delete dst.pendingNudge;
					dst.updatedAt = now();
				}
				await writeState(p, cur);
			});
		} catch {}
	}
}
