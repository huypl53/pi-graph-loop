// === swarm/errorlog.ts — durable internal-error log (AGENTS.md no-silent-swallow mandate) ===
// Best-effort catch blocks in extensions/swarm/ must never lose the error: they route it here
// via logSwarmError/logSwarmErrorTrace. This is NOT the business trace (state.ts trace/traceTask
// → traces/events.jsonl): it is a dedicated diagnostics log for INTERNAL failures of swarm code
// itself (unexpected fs errors, exec failures, hook throws) at .pi/swarm/traces/errors.jsonl.
//
// Hard requirements, in priority order:
//   1. NEVER throw. This module runs inside catch blocks; throwing would replace the original
//      failure with a worse one (or crash a tool callback). All IO is wrapped.
//   2. NEVER block hot paths unnecessarily: the line-count budget is memoized once per process.
//   3. NEVER loop-spill. A failure while writing the error log must not be able to generate an
//      unbounded stream of further error-log writes. A budget (PI_SWARM_ERRORLOG_MAX_ENTRIES,
//      default 2000 entries per process, floor 200, 0 disables) caps how many lines this process
//      may append; a >4MiB errors.jsonl forces the budget to 0 to protect the disk.
//
// Self-silence discipline: a logSwarmError failure is silently ignored — that is the ONE
// sanctioned swallow in the extension, because the diagnostics channel itself is the thing that
// failed. Everything else must log.

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { now } from "./utils.ts";

export type ErrorLogSource = string; // caller module id: "trace" | "hooks" | "mailbox" | ...

export type ErrorLogExtra = Record<string, unknown>;

const DEFAULT_MAX_ENTRIES = 2000;
const MIN_ENTRIES = 200;
const MAX_LOG_BYTES = 4 * 1024 * 1024;
let budgetMemo: number | null = null;

/** Test hook: forget the memoized budget so env changes are re-read. */
export function resetErrorLogBudgetForTests(): void {
	budgetMemo = null;
}

function errorLogPath(cwd: string): string {
	return join(cwd, ".pi", "swarm", "traces", "errors.jsonl");
}

function maxEntries(): number {
	if (budgetMemo !== null) return budgetMemo;
	const raw = Number(process.env.PI_SWARM_ERRORLOG_MAX_ENTRIES);
	let v = Number.isFinite(raw) ? Math.floor(raw) : DEFAULT_MAX_ENTRIES;
	if (v !== 0) v = Math.max(MIN_ENTRIES, v);
	budgetMemo = v;
	return v;
}

function budgetRemaining(cwd: string, used: number): number {
	const max = maxEntries();
	if (max === 0) return 0;
	if (used >= max) return 0;
	try {
		const file = errorLogPath(cwd);
		if (existsSync(file) && statSync(file).size > MAX_LOG_BYTES) return 0; // protect the disk
	} catch {
		// stat failure must not disable the channel; the append below is individually guarded
	}
	return max - used;
}

export function expected(..._args: unknown[]): boolean {
	// Marker helper for call sites: makes "expected absence" explicit and grep-able. A catch that
	// truly treats the error as a branch condition (e.g. stat of a not-yet-existing file) may
	// write `catch { expected("absent_file_is_a_branch"); }` instead of a bare `catch {}`.
	return true;
}

/**
 * Durable internal-error log. Never throws. Appends one JSONL line to
 * `<cwd>/.pi/swarm/traces/errors.jsonl`:
 *   { ts, event:"internal.error", source, op, error, code?, agentId?, ...extra }
 * `cwdOrPaths` accepts a cwd string or a Paths object (derives the project cwd from
 * `.root`'s `<cwd>/.pi/swarm` shape — NOT `.root` itself, which is already swarm-scoped).
 */
export async function logSwarmError(
	cwdOrPaths: string | { root?: string } | undefined | null,
	source: ErrorLogSource,
	op: string,
	err: unknown,
	extra: ErrorLogExtra = {},
): Promise<void> {
	try {
		let cwd = typeof cwdOrPaths === "string" ? cwdOrPaths : String(cwdOrPaths?.root || "");
		// A Paths object has root = <cwd>/.pi/swarm; strip that suffix so errors.jsonl stays at
		// <cwd>/.pi/swarm/traces/errors.jsonl instead of nesting a phantom .pi tree inside it.
		if (cwd.endsWith("/.pi/swarm")) cwd = cwd.slice(0, -"/.pi/swarm".length);
		if (!cwd) return;
		const used = usedThisProcess();
		const remaining = budgetRemaining(cwd, used);
		if (remaining <= 0) {
			if (remaining === 0 && used === maxEntries() && used % Math.max(1, maxEntries()) === 0) {
				// First time we cross the budget, leave one console breadcrumb (console.error is the
				// last-resort channel; it never throws in a healthy runtime).
				try {
					console.error(
						`[swarm:errorlog] budget exhausted (${maxEntries()} entries this process); further internal errors are dropped`,
					);
				} catch {}
			}
			return;
		}
		bumpUsed(used + 1);
		const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
		const code = (err as any)?.code !== undefined ? String((err as any).code) : undefined;
		const agentId = process.env.PI_SWARM_AGENT_ID || (process.env.PI_SWARM_IS_ROOT ? "root" : undefined);
		const record: Record<string, unknown> = {
			...extra,
			ts: now(),
			event: "internal.error",
			source,
			op,
			error: message.slice(0, 500),
			...(code ? { code } : {}),
			...(agentId ? { agentId } : {}),
		};
		const file = errorLogPath(cwd);
		await mkdir(dirname(file), { recursive: true });
		await appendFile(file, `${JSON.stringify(record)}\n`, "utf8");
	} catch {
		// The ONE sanctioned silent swallow: the diagnostics channel itself failed.
		try {
			console.error(`[swarm:errorlog] failed to persist internal error (source=${source} op=${op})`);
		} catch {}
	}
}

// --- per-process used-counter (budget accounting) -------------------------------------------
// Counting lines on every write would make the hot path O(file). Instead each process counts its
// own appends and reconciles once against the on-disk line count at first use.
let usedMemo: number | null = null;

function usedThisProcess(): number {
	return usedMemo ?? 0;
}

function bumpUsed(n: number): void {
	usedMemo = n;
}

/** Reconcile the per-process counter with the on-disk line count (called lazily once). */
export async function ensureErrorLogBudgetReconciled(cwd: string): Promise<void> {
	if (usedMemo !== null) return;
	try {
		const file = errorLogPath(cwd);
		if (!existsSync(file)) {
			usedMemo = 0;
			return;
		}
		const raw = await readFile(file, "utf8");
		usedMemo = raw.split("\n").filter((l) => l.trim()).length;
	} catch {
		usedMemo = 0; // unreadable → start counting from this process's own writes
	}
}

/**
 * Convenience wrapper for tick/hook code: fire a business trace (events.jsonl) but route its
 * rejection into the durable internal-error log instead of the previous `.catch(() => {})`
 * swallow. Returns a void promise — safe to `await` or fire-and-forget.
 */
export function traceLogged(
	traceFn: (p: any, event: string, data: Record<string, unknown>) => Promise<unknown>,
	cwdOrPaths: string | { root?: string } | undefined | null,
	source: ErrorLogSource,
	pathsArg: unknown,
	event: string,
	data: Record<string, unknown> = {},
): Promise<void> {
	return (async () => {
		try {
			await traceFn(pathsArg, event, data);
		} catch (err: unknown) {
			await logSwarmError(cwdOrPaths, source, "trace_failed", err, { traceEvent: event });
		}
	})();
}

/**
 * Convenience wrapper for trace-backbound sites: logs the internal error AND tries to leave a
 * breadcrumb in the durable business trace (events.jsonl) without ever throwing. The business
 * trace write is best-effort on top of the guaranteed errors.jsonl write.
 */
export async function logSwarmErrorTrace(
	cwdOrPaths: string | { root?: string } | undefined | null,
	source: ErrorLogSource,
	op: string,
	err: unknown,
	extra: ErrorLogExtra = {},
	traceFn?: (p: any, event: string, data: Record<string, unknown>) => Promise<unknown>,
	pathsArg?: unknown,
): Promise<void> {
	await logSwarmError(cwdOrPaths, source, op, err, extra);
	if (traceFn && pathsArg) {
		try {
			await traceFn(pathsArg, "internal.error", { source, op, ...(extra as Record<string, unknown>) });
		} catch {
			// business trace is optional garnish on top of errors.jsonl; already logged there
		}
	}
}
