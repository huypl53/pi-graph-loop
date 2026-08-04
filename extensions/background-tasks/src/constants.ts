// background-tasks/constants.ts — extension constants & defaults.
// Mirrors the swarm constants.ts shape (self-contained; no cross-extension import).

export const EXT = "background-tasks";

export const STATE_VERSION = 1;

// mkdir-based lock stale threshold (reuse swarm's value).
export const LOCK_STALE_MS = 60_000;

// --- defaults (overridable via env > settings.json > defaults, see settings.ts) ---
export const DEFAULT_MAX_CONCURRENT = 8;
export const DEFAULT_LOG_MAX_BYTES = 5 * 1024 * 1024; // 5 MB per stream
export const DEFAULT_WAIT_MAX_MS = 120_000;
export const DEFAULT_WAIT_POLL_MS = 250;
export const DEFAULT_STOP_GRACE_MS = 5_000;
export const DEFAULT_UI_REFRESH_MS = 1_000;
export const DEFAULT_UI_MAX_ROWS = 8;

// The detached `sh` wrapper. Run as:
//   spawn("sh", ["-c", WRAPPER, "<sh>", <user command>, <exit-marker abs path>, <timeoutMs|"">], { detached: true, ... })
// Because Node spawns this wrapper with detached:true, the wrapper IS the process-group leader
// (pgid == $$). The watchdog group-kills -"$$" so the command AND all descendants die (no orphans).
// Killing the wrapper before printf => NO marker => reaping case 2 (live listener).
export const WRAPPER = [
	'CMDFILE=$1; EXITFILE=$2; TIMEOUTMS=$3; shift 3;',
	'sh -c "$CMDFILE" & CPID=$!;', // user command as a NESTED sh -c (never interpolated into the wrapper)
	'WPID=;',
	'if [ -n "$TIMEOUTMS" ]; then ( sleep "$((TIMEOUTMS/1000))" && kill -TERM -"$$" 2>/dev/null ) & WPID=$!; fi;',
	'wait "$CPID"; EC=$?;', // natural exit OR group-killed by background_stop/watchdog
	'kill "$WPID" 2>/dev/null;', // reap the lingering watchdog subshell on natural exit
	"printf '{\"exitCode\":%s,\"signal\":\"\"}\\n' \"$EC\" > \"$EXITFILE\";", // BSD-date-safe: no %N, no date
	'exit "$EC"',
].join(" ");
