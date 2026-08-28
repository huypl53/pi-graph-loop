// extensions/cron/src/scheduler.ts — pure scheduler math + tick loop.
//
// Self-rescheduling setTimeout chain (NOT setInterval) so that node's GC of
// idle timers in long-idle pi TUI sessions cannot silently drop the chain.
// Each tick re-arms the next timeout from inside the run-completion path,
// and the capture is fresh enough to safely call pi.sendUserMessage on the
// current session. session_shutdown clears the captured handle.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Job } from "./store.ts";
import { loadJobs, saveJobs } from "./store.ts";

// Interval parsing: `--every <positive-int><s|m|h>` only.
// Examples: "5s" -> 5_000, "10m" -> 600_000, "2h" -> 7_200_000.
export function parseEvery(spec: string): number {
	if (typeof spec !== "string" || spec.length === 0) {
		throw new Error("invalid --every: empty");
	}
	const m = /^([1-9][0-9]*)([smh])$/.exec(spec.trim());
	if (!m) {
		throw new Error(`invalid --every: ${JSON.stringify(spec)} (expected <n><s|m|h> with n>=1)`);
	}
	const n = Number(m[1]);
	const unit = m[2];
	if (unit === "s") return n * 1_000;
	if (unit === "m") return n * 60_000;
	return n * 60 * 60 * 1_000; // h
}

// Due-check: returns true if the job should fire now (one catch-up max).
export function isDue(job: Job, now: number): boolean {
	if (job.everyMs <= 0) return false;
	if (job.lastRunAt == null) return true;
	return now - job.lastRunAt >= job.everyMs;
}

// Filter the jobs list to those due right now. Pure function.
export function findDue(jobs: Job[], now: number): Job[] {
	return jobs.filter((j) => isDue(j, now));
}

// Default tick cadence: 30 seconds.
export const DEFAULT_TICK_MS = 30_000;

// ---- Runtime scheduler ----

// Minimal "ctx-like" surface we need to inject. Captured fresh on each tick so
// the scheduler survives ctx replacement (session reload, withSession, etc.).
type SendUserMessage = (content: string, options?: { deliverAs?: "steer" | "followUp" }) => void;
type Notify = (message: string, type?: "info" | "warning" | "error") => void;
type IsIdle = () => boolean;
type Cwd = string;

export interface SchedulerOptions {
	api: ExtensionAPI;
	cwd: Cwd;
	isIdle: IsIdle;
	sendUserMessage: SendUserMessage;
	notify?: Notify;
	tickMs?: number;
	// Injectable clock for tests; defaults to Date.now.
	now?: () => number;
}

interface RuntimeState {
	cwd: Cwd;
	isIdle: IsIdle;
	sendUserMessage: SendUserMessage;
	notify?: Notify;
	api: ExtensionAPI;
	tickMs: number;
	now: () => number;
	timer: NodeJS.Timeout | null;
	running: boolean;
}

let rt: RuntimeState | null = null;

export function startScheduler(opts: SchedulerOptions): void {
	stopScheduler();
	rt = {
		cwd: opts.cwd,
		isIdle: opts.isIdle,
		sendUserMessage: opts.sendUserMessage,
		notify: opts.notify,
		api: opts.api,
		tickMs: opts.tickMs ?? DEFAULT_TICK_MS,
		now: opts.now ?? Date.now,
		timer: null,
		running: true,
	};
	scheduleNextTick();
}

export function stopScheduler(): void {
	if (!rt) return;
	rt.running = false;
	if (rt.timer) {
		clearTimeout(rt.timer);
		rt.timer = null;
	}
	rt = null;
}

function scheduleNextTick(): void {
	if (!rt || !rt.running) return;
	// Self-rescheduling setTimeout; survives process idle unlike setInterval.
	rt.timer = setTimeout(() => {
		void runTick().catch((err) => {
			// Swallow + notify on transient errors so the chain survives.
			if (rt && rt.notify) {
				try { rt.notify(`cron tick error: ${(err as Error)?.message || err}`, "warning"); } catch { /* noop */ }
			}
		}).finally(() => {
			scheduleNextTick();
		});
	}, rt.tickMs);
	// Don't keep the process alive solely for the scheduler.
	if (typeof rt.timer.unref === "function") rt.timer.unref();
}

async function runTick(): Promise<void> {
	if (!rt || !rt.running) return;
	const now = rt.now();
	let jobs: Job[] = [];
	try {
		jobs = await loadJobs(rt.cwd);
	} catch (err) {
		if (rt.notify) {
			try { rt.notify(`cron load jobs failed: ${(err as Error)?.message || err}`, "warning"); } catch { /* noop */ }
		}
		return;
	}
	const due = findDue(jobs, now);
	if (due.length === 0) return;

	// Inject each due job exactly once. If busy, queue as followUp so the
	// prompt remains a user-visible turn (per plan decision).
	for (const job of due) {
		const idle = (() => {
			try { return rt!.isIdle(); } catch { return false; }
		})();
		try {
			if (idle) {
				rt.sendUserMessage(job.prompt);
			} else {
				rt.sendUserMessage(job.prompt, { deliverAs: "followUp" });
			}
		} catch (err) {
			if (rt.notify) {
				try { rt.notify(`cron inject failed: ${(err as Error)?.message || err}`, "warning"); } catch { /* noop */ }
			}
			// Do NOT stamp lastRunAt on a failed injection — retry next tick.
			continue;
		}
		// Stamp lastRunAt = now (one catch-up fire max per missed-tick policy).
		job.lastRunAt = now;
	}
	try {
		await saveJobs(rt.cwd, jobs);
	} catch (err) {
		if (rt.notify) {
			try { rt.notify(`cron save jobs failed: ${(err as Error)?.message || err}`, "warning"); } catch { /* noop */ }
		}
	}
}
