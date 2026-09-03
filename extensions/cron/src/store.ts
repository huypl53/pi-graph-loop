// extensions/cron/src/store.ts — durable job store (.pi/cron/jobs.json).
//
// Atomic writes: temp file + rename. Single-writer assumption within one pi
// session. No preset prompts, no enable/disable, no runs log (per small-scope
// task spec).
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

export interface Job {
	// Stable per-job id (uuid-ish). Assigned at creation time; used as a
	// stable handle but user-facing removal uses the list ordinal.
	id: string;
	everyMs: number;
	prompt: string;
	// Persistence-only fields — populated as the scheduler fires jobs.
	lastRunAt: number | null;
	createdAt: number;
}

export interface StoreFile {
	version: 1;
	jobs: Job[];
}

export function jobsPath(cwd: string): string {
	return join(cwd, CONFIG_DIR_NAME, "cron", "jobs.json");
}

export function cronDir(cwd: string): string {
	return join(cwd, CONFIG_DIR_NAME, "cron");
}

function normalize(j: Partial<Job> & Pick<Job, "id" | "everyMs" | "prompt">): Job {
	return {
		id: j.id,
		everyMs: j.everyMs,
		prompt: j.prompt,
		lastRunAt: typeof j.lastRunAt === "number" ? j.lastRunAt : null,
		createdAt: typeof j.createdAt === "number" ? j.createdAt : Date.now(),
	};
}

export function loadJobs(cwd: string): Job[] {
	const path = jobsPath(cwd);
	if (!existsSync(path)) return [];
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		return [];
	}
	if (!raw.trim()) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		// Corrupt file: best-effort recovery. Return empty so the user can
		// re-add jobs; the next save overwrites the file atomically.
		return [];
	}
	if (!parsed || typeof parsed !== "object") return [];
	const obj = parsed as Partial<StoreFile>;
	if (obj.version !== 1 || !Array.isArray(obj.jobs)) return [];
	const out: Job[] = [];
	for (const j of obj.jobs) {
		if (
			j && typeof j === "object" &&
			typeof j.id === "string" &&
			typeof j.everyMs === "number" &&
			typeof j.prompt === "string" &&
			j.everyMs > 0
		) {
			out.push(normalize(j as Job));
		}
	}
	return out;
}

export function saveJobs(cwd: string, jobs: Job[]): void {
	const path = jobsPath(cwd);
	const dir = dirname(path);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	const payload: StoreFile = {
		version: 1,
		jobs: jobs.map(normalize),
	};
	const tmp = `${path}.tmp`;
	writeFileSync(tmp, JSON.stringify(payload, null, 2) + "\n", "utf8");
	renameSync(tmp, path);
}

// Simple id generator: timestamp + random suffix. Sufficient for a single
// project's job list; uniqueness within one writer is enough.
export function makeJobId(): string {
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function addJob(cwd: string, everyMs: number, prompt: string): Job {
	const jobs = loadJobs(cwd);
	const job = normalize({
		id: makeJobId(),
		everyMs,
		prompt,
		lastRunAt: null,
		createdAt: Date.now(),
	});
	jobs.push(job);
	saveJobs(cwd, jobs);
	return job;
}

export function removeJobByIndex(cwd: string, ordinal: number): Job | null {
	// ordinal is 1-based, matching the /cron list display.
	const jobs = loadJobs(cwd);
	if (ordinal < 1 || ordinal > jobs.length) return null;
	const idx = ordinal - 1;
	const [removed] = jobs.splice(idx, 1);
	saveJobs(cwd, jobs);
	return removed;
}

export function removeLastJob(cwd: string): Job | null {
	const jobs = loadJobs(cwd);
	if (jobs.length === 0) return null;
	const removed = jobs.pop()!;
	saveJobs(cwd, jobs);
	return removed;
}
