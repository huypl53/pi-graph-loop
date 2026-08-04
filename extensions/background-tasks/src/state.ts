// background-tasks/state.ts — paths, ensureDirs, locking, atomic read/write, jsonl append.
// Self-contained copies of the swarm state.ts primitives (design §3/§8).
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, writeFile, appendFile, rm, stat, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { EXT, LOCK_STALE_MS, STATE_VERSION } from "./constants.ts";
import { sleep } from "./utils.ts";
import type { BgPaths, BackgroundState } from "./types.ts";

export function paths(cwd: string): BgPaths {
	const root = join(cwd, CONFIG_DIR_NAME, EXT);
	return {
		root,
		state: join(root, "state.json"),
		lock: join(root, "state.lock"),
		logs: join(root, "logs"),
		tasksDir: join(root, "tasks"),
		events: join(root, "traces", "events.jsonl"),
	};
}

export async function ensureDirs(p: BgPaths) {
	await mkdir(p.logs, { recursive: true });
	await mkdir(p.tasksDir, { recursive: true });
	await mkdir(dirname(p.events), { recursive: true });
}

export function defaultState(cwd: string): BackgroundState {
	const ts = new Date().toISOString();
	return { version: STATE_VERSION, cwd, tasks: {}, createdAt: ts, updatedAt: ts };
}

export async function readState(p: BgPaths, cwd: string): Promise<BackgroundState> {
	await ensureDirs(p);
	if (!existsSync(p.state)) {
		const st = defaultState(cwd);
		await atomicWriteFile(p.state, `${JSON.stringify(st, null, 2)}\n`);
		return st;
	}
	const st = JSON.parse(await readFile(p.state, "utf8")) as BackgroundState;
	st.tasks ||= {};
	return st;
}

export async function atomicWriteFile(file: string, content: string) {
	await mkdir(dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
	await writeFile(tmp, content, "utf8");
	await rename(tmp, file);
}

export async function writeState(p: BgPaths, state: BackgroundState) {
	state.updatedAt = new Date().toISOString();
	await atomicWriteFile(p.state, `${JSON.stringify(state, null, 2)}\n`);
}

export async function appendJsonl(file: string, value: unknown) {
	await mkdir(dirname(file), { recursive: true });
	await appendFile(file, `${JSON.stringify(value)}\n`, "utf8");
}

export async function withLock<T>(p: BgPaths, fn: () => Promise<T>): Promise<T> {
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
			if (Date.now() - started > LOCK_STALE_MS * 2) throw new Error(`Timed out acquiring background-tasks lock: ${p.lock}`);
			await sleep(80);
		}
	}
	try {
		return await fn();
	} finally {
		await rm(p.lock, { recursive: true, force: true });
	}
}
