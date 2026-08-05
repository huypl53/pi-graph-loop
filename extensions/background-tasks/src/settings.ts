// background-tasks/settings.ts — config precedence: env > .pi/settings.json > defaults.
// Mirrors the compact-resume pattern (design §6).
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	DEFAULT_LOG_MAX_BYTES,
	DEFAULT_MAX_CONCURRENT,
	DEFAULT_SCOPE_BY_SESSION,
	DEFAULT_STOP_GRACE_MS,
	DEFAULT_UI_MAX_ROWS,
	DEFAULT_UI_REFRESH_MS,
	DEFAULT_WAIT_MAX_MS,
	DEFAULT_WAIT_POLL_MS,
} from "./constants.ts";
import type { BackgroundSettings } from "./types.ts";

function envBool(name: string): boolean | undefined {
	const v = process.env[name];
	if (v === undefined || v === "") return undefined;
	if (v === "1" || v.toLowerCase() === "true") return true;
	if (v === "0" || v.toLowerCase() === "false") return false;
	return undefined;
}

function envInt(name: string): number | undefined {
	const v = process.env[name];
	if (v === undefined || v === "") return undefined;
	const n = Number(v);
	return Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined;
}

type RawSettings = {
	enabled?: boolean;
	maxConcurrent?: number;
	logMaxBytes?: number;
	waitMaxMs?: number;
	waitPollMs?: number;
	stopGraceMs?: number;
	killOnShutdown?: boolean;
	scopeBySession?: boolean;
	ui?: { enabled?: boolean; refreshMs?: number; maxRows?: number };
};

function readRaw(): RawSettings {
	const file = join(process.cwd(), CONFIG_DIR_NAME, "settings.json");
	if (!existsSync(file)) return {};
	try {
		const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, any>;
		const cfg = raw?.extensions?.["background-tasks"];
		if (!cfg || typeof cfg !== "object") return {};
		return cfg as RawSettings;
	} catch {
		return {};
	}
}

export function readSettings(): BackgroundSettings {
	const raw = readRaw();

	const enabled = envBool("PI_BG_TASKS") ?? raw.enabled ?? true;
	const killOnShutdown = envBool("PI_BG_TASKS_KILL_ON_SHUTDOWN") ?? raw.killOnShutdown ?? false;
	const scopeBySession = envBool("PI_BG_TASKS_SCOPE_BY_SESSION") ?? raw.scopeBySession ?? DEFAULT_SCOPE_BY_SESSION;
	const maxConcurrent = envInt("PI_BG_TASKS_MAX") ?? raw.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
	const logMaxBytes = envInt("PI_BG_TASKS_LOG_MAX_BYTES") ?? raw.logMaxBytes ?? DEFAULT_LOG_MAX_BYTES;
	const waitMaxMs = envInt("PI_BG_TASKS_WAIT_MAX_MS") ?? raw.waitMaxMs ?? DEFAULT_WAIT_MAX_MS;
	const waitPollMs = envInt("PI_BG_TASKS_WAIT_POLL_MS") ?? raw.waitPollMs ?? DEFAULT_WAIT_POLL_MS;
	const stopGraceMs = envInt("PI_BG_TASKS_STOP_GRACE_MS") ?? raw.stopGraceMs ?? DEFAULT_STOP_GRACE_MS;

	const uiEnabled = envBool("PI_BG_TASKS_UI") ?? raw.ui?.enabled ?? true;
	const uiRefreshMs = envInt("PI_BG_TASKS_UI_REFRESH_MS") ?? raw.ui?.refreshMs ?? DEFAULT_UI_REFRESH_MS;
	const uiMaxRows = envInt("PI_BG_TASKS_UI_MAX_ROWS") ?? raw.ui?.maxRows ?? DEFAULT_UI_MAX_ROWS;

	return {
		enabled,
		maxConcurrent,
		logMaxBytes,
		waitMaxMs,
		waitPollMs,
		stopGraceMs,
		killOnShutdown,
		scopeBySession,
		ui: { enabled: uiEnabled, refreshMs: uiRefreshMs, maxRows: uiMaxRows },
	};
}
