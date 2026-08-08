// background-tasks/types.ts — task + state shapes (see design §3).
export type BgStatus = "pending" | "running" | "done" | "failed" | "killed" | "unknown";

export interface BackgroundTask {
	taskId: string; // safeId of caller-provided label, else bg-<timestamp>-<rand>
	label?: string; // human label (caller-provided)
	status: BgStatus;
	command: string; // the shell command string
	args?: string[]; // optional explicit argv when shell:false
	shell: boolean; // true -> run via `sh -c` (default true)
	cwd: string; // absolute, containment-checked vs ctx.cwd
	env?: Record<string, string>; // optional merged env
	pid?: number; // child pid (process-group leader)
	pgid?: number; // process group id (== pid for detached)
	startedAt: string; // ISO (now())
	endedAt?: string; // ISO when finalized
	exitCode?: number | null; // null when reaped externally / unknown
	signal?: string | null; // e.g. "SIGTERM"
	reapedByExternal?: boolean; // true if finalize came from marker/liveness, not our exit listener
	lastNotifiedStatus?: BgStatus; // persisted UI toast dedup (survives /reload)
	agentNudgedStatus?: BgStatus; // persisted agent-nudge dedup (survives /reload; one nudge per terminal status)
	timeoutMs?: number; // optional auto-kill timer (from background_start)
	survive?: boolean; // true => long-lived daemon: no parent-death watchdog; outlives the spawning pi (default false)
	spawnedByPid: number; // process.pid of the pi that started it (killOnShutdown scoping)
	spawnedBySession?: string; // STABLE chat session id (ctx.sessionManager.getSessionId()) — scopes visibility + nudges
	kind: "shell"; // reserves a seam for a future "pi" mode
	startedAtEpoch?: number; // child start time, ms since boot (PID-reuse disambiguation)
	startedAtBoot?: string; // kernel boot time id; mismatch => pid reused after reboot => unknown
	logOut: string; // relative path to stdout log
	logErr: string; // relative path to stderr log
	logTruncated?: boolean; // true if a hard size cap stopped appending
	exitMarker: string; // relative path to tasks/<id>.exit
	createdAt: string;
	updatedAt: string;
}

export interface BackgroundState {
	version: number; // 1
	cwd: string;
	tasks: Record<string, BackgroundTask>;
	createdAt: string;
	updatedAt: string;
}

export interface BackgroundSettings {
	enabled: boolean;
	maxConcurrent: number;
	logMaxBytes: number;
	waitMaxMs: number;
	waitPollMs: number;
	stopGraceMs: number;
	killOnShutdown: boolean;
	scopeBySession: boolean; // hide other chat sessions' tasks in list/widget/nudge (default true)
	ui: {
		enabled: boolean;
		refreshMs: number;
		maxRows: number;
	};
}

export interface BgPaths {
	root: string;
	state: string;
	lock: string;
	logs: string;
	tasksDir: string; // holds <id>.exit marker files
	events: string; // events.jsonl trace
}

// exit marker payload written by the wrapper on the natural-exit path only.
export interface ExitMarker {
	exitCode: number;
	signal: string;
}
