// background-tasks/hooks.ts — lifecycle wiring (design §6, §11).
// Factory stays registration-only; all resources start in session_start, tear down in session_shutdown.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { paths } from "./state.ts";
import { isAlive, reconcile, scheduleKillEscalation } from "./lifecycle.ts";
import { renderUi } from "./ui.ts";
import { trace } from "./utils.ts";
import type { BackgroundSettings } from "./types.ts";

export function registerHooks(pi: ExtensionAPI, settings: BackgroundSettings) {
	let uiTimer: NodeJS.Timeout | undefined;

	const stopUiTimer = () => {
		if (uiTimer) clearInterval(uiTimer);
		uiTimer = undefined;
	};

	pi.on("session_start", async (_event, ctx: any) => {
		const cwd = ctx.cwd;
		const p = paths(cwd);
		try {
			await reconcile(cwd, settings);
		} catch (err: any) {
			await trace(p.events, "session.start.reconcile_error", { error: String(err?.message || err) }).catch(() => {});
		}
		await trace(p.events, "session.start", { agentPid: process.pid, mode: ctx.mode }).catch(() => {});

		// Status line in any UI mode (tui + rpc).
		if (ctx.hasUI && settings.ui.enabled) {
			try {
				ctx.ui.setStatus("bg-tasks", "bg: ready");
			} catch {}
		}

		// The live-update interval is TUI-only (print/json sessions exit after one turn; rpc has no interval need).
		if (ctx.mode !== "tui" || !settings.ui.enabled) return;

		const tick = async () => {
			try {
				await renderUi(pi, ctx, settings, cwd);
			} catch (err: any) {
				// Stale-ctx after /reload or session replacement: stop the interval cleanly rather than
				// spamming stderr every second. The next session_start restarts a fresh interval.
				const msg = String((err && err.message) || err);
				if (/stale after session|not available/i.test(msg)) stopUiTimer();
				await trace(p.events, "ui.tick_error", { error: msg }).catch(() => {});
			}
		};
		await tick();
		uiTimer = setInterval(() => {
			void tick();
		}, settings.ui.refreshMs);
	});

	pi.on("session_shutdown", () => {
		stopUiTimer();
		if (!settings.killOnShutdown) return;
		// Group-SIGTERM tasks this pi started; do NOT await the grace window in the shutdown hook
		// (children are detached/unref'd; shutdown must not block). Best-effort finalize via live listener.
		void (async () => {
			try {
				const { readState, withLock, writeState } = await import("./state.ts");
				const { paths } = await import("./state.ts");
				const p = paths(process.cwd());
				await withLock(p, async () => {
					const st = await readState(p, process.cwd());
					for (const t of Object.values(st.tasks)) {
						if (t.spawnedByPid !== process.pid) continue;
						if (t.survive) continue; // survive:true daemons are meant to outlive pi — never auto-killed
						if (t.status !== "running" && t.status !== "pending") continue;
						const pgid = t.pgid ?? t.pid;
						if (pgid && isAlive(pgid)) {
							try {
								process.kill(-pgid, "SIGTERM");
							} catch {}
							scheduleKillEscalation(pgid, settings.stopGraceMs);
						}
					}
					await writeState(p, st);
				});
			} catch {}
		})();
	});
}
