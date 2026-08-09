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
	watchers?: Record<string, Watcher>; // V1.1 additive; lazily defaulted to {} on read
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
	watch: WatchSettings;
}

// --- watchers (background_watch): event-driven nudges evaluated on the ui tick ---
// A watcher registers a condition (pattern in NEW output | tcp port open | idle stall) against a
// background task. The renderUi tick loop evaluates armed watchers every refreshMs and nudges the
// agent (idle-gated, same path as the completion nudge) when a condition matches — so the agent
// never has to poll background_output in a loop.
export type WatchTrigger = "pattern" | "port" | "idle";
export type WatchStatus = "armed" | "fired" | "expired" | "cancelled";

export interface Watcher {
	watchId: string; // watch-<ts36>-<rand>
	taskId: string; // target background task
	session?: string; // owning chat session id (scopes visibility + nudges, like spawnedBySession)
	createdAt: string; // ISO
	trigger: WatchTrigger; // which condition is active
	pattern?: string; // regex source (trigger === "pattern")
	patternFlags?: string; // regex flags (e.g. "i"; "g" always stripped)
	port?: number; // tcp port readiness on 127.0.0.1 (trigger === "port")
	idleMs?: number; // stall threshold (trigger === "idle")
	once: boolean; // fire once then complete (default true); false = continuous, rate-limited by refireMs
	ttlMs?: number; // optional expiry from createdAt (0/undefined = no ttl)
	// scan cursors: bytes already consumed per stream. Initialized to 0 so the FIRST scan sees the
	// whole existing log (readiness fires immediately if already ready); then advances so only NEW
	// output is matched on later ticks.
	scanOut: number;
	scanErr: number;
	lastOutputAt: number; // epoch ms of last new output (idle trigger + refire reset)
	// firing state
	status: WatchStatus; // armed (active) | fired (once, pending nudge delivery) | expired | cancelled
	firedCount: number; // total fires
	lastFiredAt?: number; // epoch ms (rate-limits continuous refires)
	lastSnippet?: string; // last matched line / reason (nudge body + list)
	pendingNudge?: string; // buffered nudge text awaiting idle delivery (cleared on send)
	updatedAt: string;
}

export interface WatchSettings {
	enabled: boolean;
	maxPerSession: number; // cap armed watchers per session
	refireMs: number; // min gap between fires for once:false continuous watchers
	portTimeoutMs: number; // tcp connect probe timeout
	patternMaxLen: number; // cap snippet length embedded in nudges
	rangeReadBytes: number; // max bytes scanned per stream per tick (bounds per-tick work)
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
