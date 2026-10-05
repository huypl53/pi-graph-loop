// === swarm/src/issues/dedup.ts ===
//
// Restart-dedup helper for /swarm issues start (issues-sequencer-restart-dedup).
//
// CONTRACT:
// - Pure: no mutation, no lock acquisition, no I/O outside the completion ledger read.
// - Reads `.pi/swarm/issues/completions.jsonl` (append-only ledger written by the
//   controller at issue-done time — see controller.ts).
// - Returns a Map keyed by issueId of the most recent prior completion per issue.
// - Content-hash matching: callers compare the returned sourceHash against the new
//   issue's sourceHash to decide whether to dedup.

import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { expected, logSwarmError } from "../errorlog.ts";

export type PriorCompletion = {
	issueId: string;
	sourceHash: string;
	priorRunId: string;
	completedAt: string;
};

/**
 * Read the completion ledger and return the most recent prior completion per issueId.
 * Pure: no mutation, no lock acquisition. Missing/empty ledger → empty map.
 */
export async function findPriorCompletions(
	root: string,
	_issues: Array<{ id: string; sourceHash: string }>,
): Promise<Map<string, PriorCompletion>> {
	const ledgerPath = join(root, "issues", "completions.jsonl");
	const map = new Map<string, PriorCompletion>();
	let text: string;
	try {
		text = await readFile(ledgerPath, "utf8");
	} catch (err: unknown) {
		if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return map;
		void expected("completion_ledger_read_expected_enoent");
		await logSwarmError(root, "issues-dedup", "ledger_read_failed", err, { ledgerPath });
		return map;
	}
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			const rec = JSON.parse(trimmed) as PriorCompletion;
			if (typeof rec.issueId !== "string" || typeof rec.sourceHash !== "string") continue;
			// most recent wins (ledger is append-only, later lines are newer)
			map.set(rec.issueId, rec);
		} catch (err: unknown) {
			// malformed ledger line is an expected branch (corrupt append, partial write);
			// record durably per no-silent-swallow mandate, then skip the line.
			void expected("malformed completion ledger line skipped");
			await logSwarmError(root, "issues-dedup", "ledger_line_malformed", err, { ledgerPath, line: trimmed.slice(0, 120) });
		}
	}
	return map;
}

/**
 * Backfill the completion ledger from the current swarm-state.json.
 * Called once on first /swarm issues start after this fix lands, when the ledger is
 * absent. Idempotent: if the ledger already exists (even empty), skip. If it exists
 * with entries, skip (the controller appends going forward).
 *
 * Source: current `swarm-state.json` `issueRun.queue[].status === "done"` entries.
 * These have the most accurate completedAt (from the queue entry's completedAt field).
 *
 * NOTE: prior runs' queue statuses are NOT persisted anywhere except snapshots (which
 * lack completion status — snapshots are captured at activation, not completion).
 * Pre-ledger completions (e.g. run-mutkfun9-n47kmz) cannot be reliably backfilled
 * from snapshots alone; they remain visible to dedup only if the current state still
 * holds their done entries. This is a conservative but correct approach: we only
 * seed what we can prove.
 *
 * Guard: never double-appends. If the ledger already exists, skip. Absence of the
 * ledger file = full seed.
 */
export async function seedCompletionLedger(
	root: string,
	currentState?: { issueRun?: { runId?: string; queue?: Array<{ issueId: string; sourceHash: string; status: string; completedAt?: string }> } },
): Promise<{ seeded: number; skipped: number }> {
	const ledgerPath = join(root, "issues", "completions.jsonl");

	// Guard 1: if the ledger already exists, skip (idempotent — controller appends going forward).
	let ledgerExists = false;
	try {
		await stat(ledgerPath);
		ledgerExists = true;
	} catch (err: unknown) {
		if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
			void expected("ledger_stat_probe_expected_enoent");
			await logSwarmError(root, "issues-dedup", "ledger_stat_failed", err, { ledgerPath });
		}
	}
	if (ledgerExists) return { seeded: 0, skipped: 0 };

	// Source: current swarm-state.json issueRun.queue[].status === "done" entries.
	if (!currentState?.issueRun?.runId || !Array.isArray(currentState.issueRun.queue)) {
		return { seeded: 0, skipped: 0 };
	}

	const runId = currentState.issueRun.runId;
	const candidates: PriorCompletion[] = [];
	for (const entry of currentState.issueRun.queue) {
		if (entry.status !== "done") continue;
		if (typeof entry.issueId !== "string" || typeof entry.sourceHash !== "string") continue;
		candidates.push({
			issueId: entry.issueId,
			sourceHash: entry.sourceHash,
			priorRunId: runId,
			completedAt: entry.completedAt ?? new Date().toISOString(),
		});
	}

	if (candidates.length === 0) return { seeded: 0, skipped: 0 };

	// Atomic seed: write all candidates to a temp file, then rename to the ledger path.
	// This is a single atomic op (rename is atomic on POSIX), so concurrent-start
	// safety is guaranteed: either the ledger has all candidates or none of them.
	const { writeFile, rename } = await import("node:fs/promises");
	const tmpPath = `${ledgerPath}.tmp.${process.pid}.${Date.now()}`;
	try {
		const lines = candidates.map((c) => JSON.stringify(c)).join("\n") + "\n";
		await writeFile(tmpPath, lines, "utf8");
		await rename(tmpPath, ledgerPath);
	} catch (err: unknown) {
		void expected("ledger_atomic_seed_expected");
		await logSwarmError(root, "issues-dedup", "ledger_atomic_seed_failed", err, { ledgerPath, tmpPath, candidateCount: candidates.length });
		// Clean up temp file if rename failed
		try { await rename(tmpPath, `${tmpPath}.failed`); } catch { /* best-effort */ }
		return { seeded: 0, skipped: candidates.length };
	}

	await logSwarmError(root, "issues-dedup", "ledger_backfilled", new Error("backfill completed"), { seeded: candidates.length, total: candidates.length });
	return { seeded: candidates.length, skipped: 0 };
}
