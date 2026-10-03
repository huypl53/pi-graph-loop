// === swarm/stamp.ts — extension code-generation stamp (stale-root detection) ===
// 2026-10-03 incident: a long-lived root pi process keeps serving OLD module code
// from Node's ESM module cache after `extensions/swarm` sources change on disk.
// Workers spawned from such a root silently lack whatever new code landed. A running
// process cannot change its loaded code, so the loaded generation is captured ONCE
// per process at extension load and compared against the CURRENT on-disk generation
// at surface time ("/swarm status"). Mismatch means the running process is stale.
//
// Docs: docs/swarm/operations.md (Extension code stamp, stale-root detection);
// docs/swarm/pi-runtime-contract.md section 10 row F23.
import { readdirSync, statSync } from "node:fs";
import { join, posix, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { logSwarmError } from "./errorlog.ts";

export type CodeStamp = {
	/** sha256 hex over the sorted "relPath<NUL>sizeBytes<NUL>mtimeMs<LF>" lines; "unavailable" when the scan failed. */
	hash: string;
	/** number of files folded into the hash (0 when unavailable). */
	files: number;
	/** ISO timestamp of the computation (empty when unavailable). */
	computedAt: string;
};

/** Persisted in SwarmState.rootLeader.extCodeStamp: WHAT generation the current leader process loaded. */
export type DurableExtCodeStamp = CodeStamp & {
	/** ISO timestamp of when the leader process stamped this generation. */
	stampedAt: string;
};

export const EXT_CODE_UNAVAILABLE = "unavailable";
export const EXT_CODE_STAMP_MAX_FILES = 512;
const HASH_DISPLAY_LEN = 8;

/** Absolute path of the swarm extension tree (extensions/swarm), cwd-independent (session.ts discipline). */
export function swarmExtensionRoot(): string {
	return fileURLToPath(new URL("../", import.meta.url));
}

// RelPath used for the extension root index.ts inside the stamp (namespaced so it can never
// collide with a real src/ entry).
const ROOT_INDEX_REL = "__root_index__.ts";

function collectStampInputsSync(rootDir: string): { hash: string; files: number } {
	const srcDir = join(rootDir, "src");
	const relPaths: string[] = [];
	let dirents;
	try {
		dirents = readdirSync(srcDir, { recursive: true, withFileTypes: true });
	} catch (err: any) {
		if (err?.code !== "ENOENT") throw err;
		dirents = [];
	}
	for (const dirent of dirents) {
		if (!dirent.isFile()) continue;
		// dirent.parentPath is ABSOLUTE (Node >= 20.12): normalize to a path relative to srcDir.
		const parentRel = dirent.parentPath && dirent.parentPath !== "." ? relative(srcDir, dirent.parentPath) : "";
		const rel = parentRel ? `${parentRel}/${dirent.name}` : dirent.name;
		if (!rel.endsWith(".ts")) continue;
		relPaths.push(rel);
	}
	if (existsRootIndex(rootDir)) relPaths.push(ROOT_INDEX_REL);
	relPaths.sort();
	const lines: string[] = [];
	let files = 0;
	for (const rel of relPaths.slice(0, EXT_CODE_STAMP_MAX_FILES)) {
		const abs = rel === ROOT_INDEX_REL ? join(rootDir, "index.ts") : join(srcDir, rel);
		const st = statSync(abs);
		// stamp line: src/<relPath> <NUL> size <NUL> mtimeMs <LF>
		lines.push("src/" + rel + "\u0000" + String(st.size) + "\u0000" + String(Math.floor(st.mtime.getTime())) + "\n");
		files++;
	}
	return { hash: createHash("sha256").update(lines.join(""), "utf8").digest("hex"), files };
}

let rootIndexProbeWarned = false;
function existsRootIndex(rootDir: string): boolean {
	try {
		statSync(join(rootDir, "index.ts"));
		return true;
	} catch (err: any) {
		if (err?.code === "ENOENT") return false;
		// Non-ENOENT probe failure: report once durably, then degrade to unstamped.
		if (!rootIndexProbeWarned) {
			rootIndexProbeWarned = true;
			void logSwarmError(process.cwd(), "stamp", "ext_root_index_probe_failed", err);
		}
		return false;
	}
}

// Stable digest of the extension's module-cached surface: src/**/*.ts + index.ts.
export function computeCodeStampSync(rootDir: string = swarmExtensionRoot()): CodeStamp {
	try {
		const res = collectStampInputsSync(rootDir);
		return { ...res, computedAt: new Date().toISOString() };
	} catch (err: any) {
		logSwarmError(process.cwd(), "stamp", "ext_code_scan_failed", err, { code: err?.code });
		return { hash: EXT_CODE_UNAVAILABLE, files: 0, computedAt: "" };
	}
}

export async function computeCodeStamp(rootDir: string = swarmExtensionRoot()): Promise<CodeStamp> {
	return computeCodeStampSync(rootDir);
}

// Captured once per process AT MODULE EVALUATION: closes the import->session_start
// race to almost zero (Node caches the ESM module graph; the generation cannot change
// underneath us without a reload/restart).
let processCache: CodeStamp | null = null;
export function getProcessCodeStamp(): CodeStamp {
	if (processCache === null) {
		processCache = computeCodeStampSync();
	}
	return processCache;
}

// Eagerly initialize the process cache at module evaluation (sync statSync twin).
getProcessCodeStamp();

export type ExtCodeStampVerdict = "current" | "stale" | "unknown" | "unavailable";

const fmt = (hash: string) => (hash.length > HASH_DISPLAY_LEN ? hash.slice(0, HASH_DISPLAY_LEN) : hash);

/** Bounded (max 140 chars) verdict line for /swarm status. Pure; never reads state. */
export function renderCodeStampLine(
	durable: DurableExtCodeStamp | undefined,
	self: CodeStamp,
	opts?: { now?: number },
): { line: string; verdict: ExtCodeStampVerdict } {
	const out = (s: string, verdict: ExtCodeStampVerdict) => ({ line: s.length > 140 ? s.slice(0, 140) : s, verdict });
	if (self.hash === EXT_CODE_UNAVAILABLE) {
		return out("ext code: unavailable (could not scan extension sources; see errors.jsonl)", "unavailable");
	}
	if (!durable) {
		return out(`ext code: unknown — root predates ext-code stamping (self=${fmt(self.hash)}); reboot root to enable stamping`, "unknown");
	}
	if (durable.hash !== self.hash) {
		const ageMs = (opts?.now ?? Date.now()) - new Date(durable.stampedAt).getTime();
		const ageH = Number.isFinite(ageMs) ? Math.round(ageMs / 3600000) : null;
		return out(
			`ext code: STALE — root boot${ageH !== null ? ` (${ageH}h ago)` : ""} predates current on-disk code (self=${fmt(self.hash)}, root=${fmt(durable.hash)}); restart root or /reload`,
			"stale",
		);
	}
	return out(`ext code: current (self=${fmt(self.hash)})`, "current");
}
