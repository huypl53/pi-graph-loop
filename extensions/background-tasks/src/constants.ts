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
export const DEFAULT_SCOPE_BY_SESSION = true;

// The detached `sh` wrapper. Run as:
//   spawn("sh", ["-c", WRAPPER, "<sh>", <user command>, <exit-marker abs path>, <timeoutMs|"">, <watchdog 1|0>, <parentPid>], { detached: true, ... })
// Because Node spawns this wrapper with detached:true, the wrapper IS the process-group leader
// (pgid == $$). The watchdog group-kills -"$$" so the command AND all descendants die (no orphans).
// Killing the wrapper before printf => NO marker => reaping case 2 (live listener).
//
// Parent-death watchdog (WATCHDOG=1, the default): the wrapper polls its OWN current parent vs. the
// spawning pi pid (passed explicitly as PARENT_PID — no $PPID capture race). When that pi exits —
// cleanly OR via crash/kill-9 (no session_shutdown hook can run then) — the OS reparents this
// wrapper to init, the check fails, and the wrapper kills its whole group. So by default a task dies
// with its spawning pi. WATCHDOG=0 (background_start survive:true) skips this so a long-lived daemon
// outlives pi. /reload keeps the pi PROCESS alive, so the parent never changes and tasks correctly
// survive a reload. Keying on reparenting (not pid liveness) makes it pid-reuse resistant.
export const WRAPPER = [
	'CMDFILE=$1; EXITFILE=$2; TIMEOUTMS=$3; WATCHDOG=$4; PARENT_PID=$5; shift 5; DPID=;',
	'if [ "$WATCHDOG" != "0" ]; then ( while [ "$(ps -o ppid= -p $$ | tr -d \' \')" = "$PARENT_PID" ]; do sleep 3; done; kill -TERM -"$$" 2>/dev/null; sleep 2; kill -KILL -"$$" 2>/dev/null ) & DPID=$!; fi;',
	'sh -c "$CMDFILE" & CPID=$!', // user command as a NESTED sh -c (never interpolated into the wrapper)
	'WPID=;',
	'if [ -n "$TIMEOUTMS" ]; then ( sleep "$((TIMEOUTMS/1000))" && kill -TERM -"$$" 2>/dev/null ) & WPID=$!; fi;',
	'wait "$CPID"; EC=$?;', // natural exit OR group-killed by background_stop/watchdog
	'kill "$WPID" 2>/dev/null; [ -n "$DPID" ] && kill "$DPID" 2>/dev/null;', // reap lingering watchdog subshells on natural exit
	"printf '{\"exitCode\":%s,\"signal\":\"\"}\\n' \"$EC\" > \"$EXITFILE\";", // BSD-date-safe: no %N, no date
	'exit "$EC"',
].join(" ");
