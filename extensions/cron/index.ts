// extensions/cron/index.ts — packaged cron extension entry.
//
// Thin wiring: register the /cron slash command and start/stop the scheduler
// from session_start / session_shutdown. No timers in the factory body.
// Mirrors extensions/swarm and extensions/background-tasks patterns; no
// swarm coupling, no preset prompts, no enable/disable/run.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { handleCron } from "./src/command.ts";
import { startScheduler, stopScheduler } from "./src/scheduler.ts";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("cron", {
		description:
			"Schedule recurring prompts into this session. Usage: /cron add --every <n><s|m|h> \"<prompt>\" | /cron list | /cron remove <#>|last",
		handler: async (args, ctx) => {
			try {
				await handleCron(args, ctx);
			} catch (err) {
				const msg = (err as Error)?.message || String(err);
				try { ctx.ui.notify(`cron error: ${msg}`, "error"); } catch { /* noop */ }
			}
		},
	});

	pi.on("session_start", (_event, ctx) => {
		startScheduler({
			api: pi,
			cwd: ctx.cwd,
			isIdle: () => {
				try { return ctx.isIdle(); } catch { return false; }
			},
			sendUserMessage: (content, options) => {
				try { pi.sendUserMessage(content, options); } catch { /* noop */ }
			},
			notify: (message, type) => {
				try { ctx.ui.notify(message, type); } catch { /* noop */ }
			},
		});
	});

	pi.on("session_shutdown", () => {
		stopScheduler();
	});
}
