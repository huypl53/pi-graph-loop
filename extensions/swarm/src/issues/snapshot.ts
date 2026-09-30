// === swarm/src/issues/snapshot.ts ===
//
// Bounded, immutable activation-snapshot files (swarm-issues Phase 2).
//
// CONTRACT (per approved plan):
// - Full approved content/doc bytes live ONLY at
//     `.pi/swarm/issues/snapshots/<runId>/<issueId>.json`
//   NEVER inside swarm-state.json (hot lock file stays lightweight — refs + hashes only).
// - Snapshots are immutable: re-capture with an identical sourceHash is an idempotent
//   no-write; an existing file with a DIFFERENT hash is a hard error
//   (`snapshot_hash_conflict`) — never overwritten.
// - Doc contents are bounded: per-doc MAX_DOC_BYTES with an explicit `truncated` marker
//   and sha256 of the captured prefix; aggregate capped by MAX_SNAPSHOT_BYTES via
//   deterministic fair-share truncation.
// - Containment: every doc realpath must stay inside realpath(projectRoot); symlink
//   escapes, directories, missing and unreadable files are typed errors BEFORE any write.
// - Capture happens only from the future `activateIssueLocked` controller path (Phase 3);
//   this module only provides the primitive. No run-state mutation here.

import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { join, relative, sep, dirname } from "node:path";
import { atomicWriteFile } from "../state.ts";
import { expected, logSwarmError } from "../errorlog.ts";
import { classifyDocPath, MAX_DOC_BYTES, MAX_SNAPSHOT_BYTES, type IssueSource } from "./source.ts";

export type SnapshotDoc = {
	path: string; // root-relative, normalized
	sha256: string; // sha256 of the captured (possibly truncated) content
	bytes: number; // captured byte length (after truncation)
	fullBytes: number; // original file size
	truncated: boolean;
	content: string; // captured (possibly truncated) utf8 content
};

export type IssueSnapshot = {
	id: string;
	title: string;
	content: string;
	capturedAt: string;
	sourceHash: string; // sha256 of canonical JSON {id,title,content}
	snapshotHash: string; // sha256 of the whole snapshot body (integrity)
	docs: SnapshotDoc[];
};

export type CaptureResult =
	| { ok: true; path: string; sourceHash: string; snapshotHash: string; docsTruncated: string[]; idempotent: boolean }
	| { ok: false; code: string; message: string };

export function snapshotsRoot(root: string): string {
	return join(root, "issues", "snapshots");
}

export function snapshotPath(root: string, runId: string, issueId: string): string {
	return join(snapshotsRoot(root), runId, `${issueId}.json`);
}

export function sha256Hex(data: string | Buffer): string {
	return createHash("sha256").update(data).digest("hex");
}

/** Stable hash of the authored source fields (order-fixed, not YAML-fragile). */
export function sourceHashOf(issue: Pick<IssueSource, "id" | "title" | "content">): string {
	return sha256Hex(JSON.stringify({ id: issue.id, title: issue.title, content: issue.content }));
}

/**
 * Read + bound one doc. Enforces realpath containment BEFORE reading.
 * Typed errors: doc_traversal / doc_absolute / doc_missing / doc_directory / doc_escape / doc_unreadable / doc_oversize.
 */
export async function captureDoc(rootReal: string, docPath: string, perDocBytes = MAX_DOC_BYTES): Promise<{ ok: true; doc: SnapshotDoc } | { ok: false; code: string; message: string }> {
	const cls = classifyDocPath(rootReal, docPath);
	if (!cls.ok) return { ok: false, code: cls.code, message: cls.message };
	const abs = join(rootReal, cls.normalized);
	let real: string;
	try {
		real = await realpath(abs);
	} catch (err: unknown) {
		if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
			return { ok: false, code: "doc_missing", message: `doc "${docPath}" does not exist` };
		}
		void expected("doc_realpath_probe_expected_enoent_or_fs_error");
		await logSwarmError(rootReal, "issues-snapshot", "doc_realpath_failed", err, { docPath });
		return { ok: false, code: "doc_unreadable", message: `doc "${docPath}" could not be resolved` };
	}
	const rel = relative(rootReal, real);
	if (rel === "" || rel.startsWith("..") || rel.includes(`..${sep}`) || rel.startsWith(sep)) {
		return { ok: false, code: "doc_escape", message: `doc "${docPath}" resolves outside the project root (symlink escape)` };
	}
	const s = await stat(real).catch((err: unknown) => {
		return null;
	});
	if (!s) {
		void expected("doc_stat_absent_after_realpath_race");
		return { ok: false, code: "doc_missing", message: `doc "${docPath}" vanished during capture` };
	}
	if (!s.isFile()) return { ok: false, code: "doc_directory", message: `doc "${docPath}" is not a regular file` };
	let buf: Buffer;
	try {
		buf = await readFile(real);
	} catch (err: unknown) {
		await logSwarmError(rootReal, "issues-snapshot", "doc_read_failed", err, { docPath });
		return { ok: false, code: "doc_unreadable", message: `doc "${docPath}" could not be read` };
	}
	let content: string;
	let truncated = false;
	let captured = buf;
	if (buf.length > perDocBytes) {
		// Truncate on a whole-UTF8 boundary so downstream rendering never shows torn chars.
		captured = buf.subarray(0, perDocBytes);
		while (captured.length > 0 && (captured[captured.length - 1] & 0xc0) === 0x80) captured = captured.subarray(0, captured.length - 1);
		content = captured.toString("utf8");
		truncated = true;
	} else {
		content = buf.toString("utf8");
	}
	return {
		ok: true,
		doc: { path: cls.normalized, sha256: sha256Hex(captured), bytes: captured.length, fullBytes: buf.length, truncated, content },
	};
}

/** Deterministic fair-share cap so aggregate snapshot bytes stay bounded. */
function applyAggregateCap(docs: SnapshotDoc[], maxTotal: number): { docs: SnapshotDoc[]; truncated: string[] } {
	const total = () => docs.reduce((n, d) => n + d.bytes, 0);
	const truncated: string[] = [];
	let guard = 0;
	while (total() > maxTotal && guard++ < 64) {
		const over = total() - maxTotal;
		const eligible = docs.filter((d) => !d.truncated || d.bytes > 1024);
		if (eligible.length === 0) break;
		const biggest = eligible.reduce((a, b) => (b.bytes > a.bytes ? b : a));
		const cut = Math.max(1024, biggest.bytes - Math.max(0, biggest.bytes - over - (docs.length - 1) * 0));
		const target = Math.max(0, biggest.bytes - Math.ceil(over / eligible.length));
		void cut;
		const nextBytes = Math.max(target, biggest.truncated ? 1024 : 1024);
		const buf = Buffer.from(biggest.content, "utf8").subarray(0, nextBytes);
		let end = buf.length;
		while (end > 0 && (buf[end - 1] & 0xc0) === 0x80) end--;
		biggest.content = buf.subarray(0, end).toString("utf8");
		biggest.bytes = end;
		biggest.sha256 = sha256Hex(buf.subarray(0, end));
		biggest.truncated = true;
		if (!truncated.includes(biggest.path)) truncated.push(biggest.path);
	}
	return { docs, truncated };
}

/**
 * Capture the immutable snapshot for one issue under `runId`.
 * Atomic write; idempotent on identical sourceHash; hard error on hash conflict.
 * Caller (Phase 3 controller) holds the swarm lock; this primitive is lock-agnostic.
 */
export async function captureIssueSnapshot(root: string, runId: string, issue: IssueSource, runIdSafe = runId, docRoot?: string): Promise<CaptureResult> {
	// docRoot: base for resolving `docs` entries. Phase-3b amendment (2026-10-01, planned):
	// the plan contract is "docs resolve within project root" (cwd), while snapshot storage
	// lives under .pi/swarm/issues/snapshots. Default keeps the Phase-2 signature/behavior.
	const docBase = docRoot ?? root;
	// Defensive: runId/issueId become path segments — reuse the safe charset rule upstream.
	if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(runIdSafe) || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(issue.id)) {
		return { ok: false, code: "unsafe_id", message: `runId "${runIdSafe}" / issueId "${issue.id}" are not snapshot-path safe` };
	}
	const sHash = sourceHashOf(issue);
	const path = snapshotPath(root, runIdSafe, issue.id);

	const existing = await readFile(path, "utf8").then(
		(t) => t,
		(err: unknown) => {
			if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return null;
			void expected("snapshot_read_probe_expected_enoent");
			return null;
		},
	);
	if (existing !== null) {
		try {
			const prev = JSON.parse(existing) as IssueSnapshot;
			if (prev.sourceHash === sHash) {
				return { ok: true, path, sourceHash: sHash, snapshotHash: prev.snapshotHash, docsTruncated: prev.docs.filter((d) => d.truncated).map((d) => d.path), idempotent: true };
			}
			return { ok: false, code: "snapshot_hash_conflict", message: `snapshot at ${path} holds sourceHash ${prev.sourceHash}, refusing to overwrite with ${sHash}` };
		} catch (err: unknown) {
			return { ok: false, code: "snapshot_corrupt", message: `existing snapshot at ${path} is not parseable: ${err instanceof Error ? err.message : String(err)}` };
		}
	}

	const rootReal = await realpath(root);
	const docReal = await realpath(docBase);
	const docs: SnapshotDoc[] = [];
	for (const d of issue.docs) {
		const r = await captureDoc(docReal, d);
		if (!r.ok) return { ok: false, code: r.code, message: r.message };
		docs.push(r.doc);
	}
	const capped = applyAggregateCap(docs, MAX_SNAPSHOT_BYTES);

	const body: Omit<IssueSnapshot, "snapshotHash"> = {
		id: issue.id,
		title: issue.title,
		content: issue.content,
		capturedAt: new Date().toISOString(),
		sourceHash: sHash,
		docs: capped.docs,
	};
	const snapshotHash = sha256Hex(JSON.stringify(body));
	const snap: IssueSnapshot = { ...body, snapshotHash };
	const dir = dirname(path);
	try {
		const { mkdir } = await import("node:fs/promises");
		await mkdir(dir, { recursive: true });
		await atomicWriteFile(path, `${JSON.stringify(snap, null, 2)}\n`);
	} catch (err: unknown) {
		await logSwarmError(root, "issues-snapshot", "snapshot_write_failed", err, { path });
		return { ok: false, code: "snapshot_write_failed", message: `snapshot write failed: ${err instanceof Error ? err.message : String(err)}` };
	}
	return { ok: true, path, sourceHash: sHash, snapshotHash, docsTruncated: capped.truncated, idempotent: false };
}

/** Read-only snapshot loader; verifies the body's self-integrity hash. */
export async function readIssueSnapshot(path: string): Promise<{ ok: true; snapshot: IssueSnapshot } | { ok: false; code: string; message: string }> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (err: unknown) {
		if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return { ok: false, code: "snapshot_missing", message: `no snapshot at ${path}` };
		await logSwarmError(process.cwd(), "issues-snapshot", "snapshot_read_failed", err, { path });
		return { ok: false, code: "snapshot_unreadable", message: `snapshot at ${path} could not be read` };
	}
	try {
		const snap = JSON.parse(text) as IssueSnapshot;
		const { snapshotHash, ...body } = snap;
		if (sha256Hex(JSON.stringify(body)) !== snapshotHash) {
			return { ok: false, code: "snapshot_integrity", message: `snapshot at ${path} failed integrity check` };
		}
		return { ok: true, snapshot: snap };
	} catch (err: unknown) {
		return { ok: false, code: "snapshot_corrupt", message: `snapshot at ${path} is not parseable: ${err instanceof Error ? err.message : String(err)}` };
	}
}
