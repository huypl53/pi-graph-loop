// === swarm/taskgraph/scope.ts — file-scope ownership: effective scope resolution + overlap predicate ===
// Pure task-graph logic (roadmap issue 4): no filesystem enumeration, no realpath/glob expansion.
// task.json stays the only authority. Extracted from taskgraph.ts (Phase 6 real split).

import type { MessageRecord, TaskNode, TaskState } from "../types.ts";

export type ScopeSource = "node-explicit" | "node-inherited" | "task-default";

export type EffectiveScope = { source: ScopeSource; sourceNodeId?: string; files: string[] } | { unresolved: true; reason: string };

// Resolve a node's effective write scope: node.allowedFiles -> allowedFilesFrom (recursive, same
// task, cycle-safe) -> task.allowedFiles. Unresolved inheritance (missing source node or cycle)
// returns { unresolved } so callers can treat it conservatively (as overlapping) in preflight.
export function resolveNodeScope(task: TaskState, nodeId: string): EffectiveScope {
	const seen = new Set<string>();
	let cur = nodeId;
	let source: ScopeSource | null = null;
	let sourceNodeId: string | undefined;
	for (;;) {
		const node = task.nodes[cur];
		if (!node) return { unresolved: true, reason: `node ${cur} does not exist (inheritance chain from ${nodeId})` };
		if (node.allowedFiles && node.allowedFiles.length) {
			return source === "node-inherited"
				? { source, sourceNodeId, files: [...node.allowedFiles] }
				: { source: "node-explicit", files: [...node.allowedFiles] };
		}
		if (node.allowedFilesFrom) {
			if (seen.has(cur)) return { unresolved: true, reason: `allowedFilesFrom cycle at ${cur} in chain from ${nodeId}` };
			seen.add(cur);
			source = "node-inherited";
			sourceNodeId = node.allowedFilesFrom;
			cur = node.allowedFilesFrom;
			continue;
		}
		return { source: "task-default", files: [...(task.allowedFiles || [])] };
	}
}

// Normalize a project-relative pattern to a segment array under a strict grammar: `/` separators,
// no absolute paths, no `..`, no empty/`.` segments. Wildcard support: a segment that is exactly
// `**` matches zero or more segments; a segment that is exactly `*` matches any single segment;
// `*` inside a segment (e.g. `*.ts`) matches any run of characters within that one segment.
// Other glob metacharacters (? [ ] { } !) are unsupported. Returns null for anything else
// (unknown => the caller must treat the pattern as conservatively overlapping).
export type ScopeSegment = string | { intra: string };
export function normalizeScopePattern(pattern: string): ScopeSegment[] | null {
	if (typeof pattern !== "string" || !pattern.length) return null;
	if (pattern.includes("\\") || pattern.startsWith("/")) return null;
	// R26: a trailing slash means "this directory subtree" (dir/ ≡ dir/**). Detect BEFORE
	// split, strip, then re-append a trailing "**" sentinel after the segment loop.
	// Internal "//" still hits the empty-segment guard below (conservative).
	const dirSubtree = pattern.endsWith("/");
	const trimmed = dirSubtree ? pattern.replace(/\/+$/, "") : pattern;
	if (!trimmed.length) return null;
	const segments = trimmed.split("/");
	const out: ScopeSegment[] = [];
	for (const seg of segments) {
		if (!seg.length || seg === ".") return null;
		if (seg.includes("..")) return null;
		if (seg !== "**" && /[*?\[\]{}!]/.test(seg)) {
			if (!/^[\w.\-*]+$/.test(seg)) return null; // only simple intra-segment * wildcards
			out.push({ intra: seg });
			continue;
		}
		out.push(seg);
	}
	if (dirSubtree) out.push("**");
	return out;
}

// Escape an intra-segment wildcard (`*.ts` etc.) into a regex over one segment.
function intraRegex(seg: string) {
	return new RegExp(`^${seg.replace(/[.+^$(){}|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
}

// Match one pattern segment list against another, both possibly containing wildcards.
// "overlap" iff at least one concrete path can match both. Unknown grammar upstream is handled by
// normalizeScopePattern (null => caller treats as unknown).
function segmentsOverlap(a: ScopeSegment[], i: number, b: ScopeSegment[], j: number): boolean | "unknown" {
	if (i >= a.length && j >= b.length) return true;
	const x = a[i],
		y = b[j];
	if (i >= a.length || j >= b.length) {
		// one exhausted, the other not: only a trailing ** (zero-or-more, can end early) keeps them overlapping
		if (i >= a.length) {
			if (y !== "**") return false;
			return segmentsOverlap(a, i, b, j + 1);
		}
		if (x !== "**") return false;
		return segmentsOverlap(a, i + 1, b, j);
	}
	if (x === "**" || y === "**") {
		// ** on one side: try consuming 0..n segments on the other side
		const other = x === "**" ? b : a;
		const oi = x === "**" ? j : i;
		for (let k = oi; k <= other.length; k++) {
			const r = x === "**" ? segmentsOverlap(a, i + 1, b, k) : segmentsOverlap(a, k, b, j + 1);
			if (r === true) return true;
			if (r === "unknown") return "unknown";
		}
		return false;
	}
	// intra-segment wildcard on either side (or both): match single-segment patterns.
	const xs = typeof x === "string" ? x : x.intra;
	const ys = typeof y === "string" ? y : y.intra;
	const xWild = typeof x !== "string";
	const yWild = typeof y !== "string";
	if (xWild && yWild) {
		// two single-segment wildcard patterns overlap iff one's literal pattern satisfies the other
		// (e.g. *.ts vs *.js share nothing; *.ts vs a.ts share "a.ts").
		if (intraRegex(xs).test(ys) || intraRegex(ys).test(xs)) return segmentsOverlap(a, i + 1, b, j + 1);
		return false;
	}
	if (xWild) {
		if (!intraRegex(xs).test(ys)) return false;
	} else if (yWild) {
		if (!intraRegex(ys).test(xs)) return false;
	} else if (xs !== ys) return false;
	return segmentsOverlap(a, i + 1, b, j + 1);
}

export function scopePatternsOverlap(a: string, b: string): boolean | "unknown" {
	const na = normalizeScopePattern(a);
	const nb = normalizeScopePattern(b);
	if (!na || !nb) return "unknown";
	return segmentsOverlap(na, 0, nb, 0);
}

export type ScopeRelation =
	{ overlap: true; relation: "equal" | "glob-match" | "unknown-syntax" | "unresolved-inheritance" } | { overlap: false };

// Overlap between two effective scopes (file lists). Unresolved scope or any unknown-syntax pattern
// conservatively reports overlap so preflight can never pass on ambiguity.
export function scopesOverlap(a: EffectiveScope, b: EffectiveScope): ScopeRelation {
	if ("unresolved" in a) return { overlap: true, relation: "unresolved-inheritance" };
	if ("unresolved" in b) return { overlap: true, relation: "unresolved-inheritance" };
	for (const fa of a.files) {
		for (const fb of b.files) {
			const r = scopePatternsOverlap(fa, fb);
			if (r === true) return { overlap: true, relation: fa === fb ? "equal" : "glob-match" };
			if (r === "unknown") return { overlap: true, relation: "unknown-syntax" };
		}
	}
	return { overlap: false };
}

// Describe an active lease (task/node/attempt) for conflict reporting. Read-only scan over task.json
// files under the swarm lock; never mutates anything and never touches the filesystem beyond readdir+read.
export type ActiveLease = {
	taskId: string;
	nodeId: string;
	assignee: string;
	attemptId: string;
	scope: EffectiveScope;
};

export function collectActiveLeases(task: TaskState): ActiveLease[] {
	const out: ActiveLease[] = [];
	for (const [nodeId, node] of Object.entries(task.nodes)) {
		if (!node.activeAttemptId || !node.attemptHistory) continue;
		// only a genuinely held lease: the active attempt record exists and is status:"active"
		const attempt = node.attemptHistory.find((a: any) => a.attemptId === node.activeAttemptId);
		if (!attempt || attempt.status !== "active") continue;
		const scope = attempt.scope ? (attempt.scope as EffectiveScope) : resolveNodeScope(task, nodeId);
		out.push({ taskId: task.taskId, nodeId, assignee: attempt.assignee, attemptId: attempt.attemptId, scope });
	}
	return out;
}

// ---- Durable attention derivation (reliability roadmap issue 5) ----
// Pure, read-only classification of a task node's recovery condition from persisted state only:
// task.json (node + attempt history) and swarm-state messages/agents. NEVER consults tmux/process/
// pane liveness — pane idleness is not semantic evidence of completion or failure. Advisory only.

const isoMs = (v?: string): number => (v ? new Date(v).getTime() || 0 : 0);

// The no-progress anchor: the MOST RECENT of the durable activity timestamps. The assignedAt floor
// guarantees a value; a reminder fires only when even the freshest evidence is stale.
function reminderAnchorMs(msg: MessageRecord | undefined, node: TaskNode, attempt: any): number {
	return Math.max(isoMs(msg?.lastAck?.at), isoMs(node.lastActivityAt), isoMs(attempt?.lastActivityAt), isoMs(attempt?.assignedAt));
}

// Receipt/processing confirmation requires both durable receipt timestamp and a progress ACK on
// the canonical assignment. `ackedAt` records receipt, never semantic completion; `done` still
// follows the separate response/closure path. Transport injection without this ACK is never receipt.
function receiptConfirmed(msg: MessageRecord | undefined): boolean {
	const s = msg?.lastAck?.status;
	return Boolean(msg?.ackedAt) && (s === "seen" || s === "processing");
}
