import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCwdTracking, swarmArgumentCompletions, swarmScopedArgumentCompletions } from "../completion.ts";
import { ensureDirs, paths, trace } from "../state.ts";
import { handleAgentsCommand } from "./agents.ts";
import { handleAttentionCommand } from "./attention.ts";
import { handleGoalCommand } from "./goal.ts";
import { handleMarkersCommand } from "./markers.ts";
import { handleMessagingCommand } from "./messaging.ts";
import { handleObservabilityCommand } from "./observability.ts";
import { normalizeScopedSwarmArgs, scopedSwarmUsage, SWARM_COMMAND_DESCRIPTION } from "./parser.ts";
import type { ScopedSwarmCommandName } from "./parser.ts";
import { handlePoolCommand } from "./pool.ts";
import { handleProtocolCommand } from "./protocol.ts";
import { handleTasksCommand } from "./tasks.ts";

export * from "./parser.ts";
export * from "./markers.ts";
export * from "./agents.ts";
export * from "./tasks.ts";
export * from "./pool.ts";
export * from "./goal.ts";
export * from "./attention.ts";
export * from "./messaging.ts";
export * from "./observability.ts";
export * from "./protocol.ts";

const AGENT_COMMANDS = new Set([
	"",
	"init",
	"list",
	"status",
	"panes",
	"spawn",
	"register",
	"deregister",
	"stop",
	"restart",
	"role",
	"pause",
	"resume",
	"lease",
	"sendkey",
	"attach",
	"release",
	"identity",
]);

const TASK_COMMANDS = new Set(["graph", "tasks", "task", "next", "validate"]);
const ATTENTION_COMMANDS = new Set(["attention", "remind"]);
const OBSERVABILITY_COMMANDS = new Set(["flow", "trace", "metrics", "focus", "auto-focus", "focus-busy"]);
const MARKER_COMMANDS = new Set(["mark", "markers", "capture", "audit"]);
const MESSAGING_COMMANDS = new Set(["send", "mailbox"]);

export function registerSwarmCommand(pi: ExtensionAPI) {
	registerCwdTracking(pi);
	const runCommand = async (args: string, ctx: any, commandName: ScopedSwarmCommandName = "swarm") => {
		const scopedArgs = normalizeScopedSwarmArgs(commandName, args);
		if (scopedArgs == null) {
			ctx.ui.notify(scopedSwarmUsage(commandName), "warning");
			return;
		}
		const p = paths(ctx.cwd);
		await ensureDirs(p);
		const [cmd = "", ...rest] = scopedArgs.trim().split(/\s+/).filter(Boolean);
		try {
			if (AGENT_COMMANDS.has(cmd)) {
				await handleAgentsCommand(cmd, rest, ctx, p, pi);
				return;
			}
			if (TASK_COMMANDS.has(cmd)) {
				await handleTasksCommand(cmd as any, rest, ctx, p, pi);
				return;
			}
			if (ATTENTION_COMMANDS.has(cmd)) {
				await handleAttentionCommand(cmd as any, rest, ctx, p, pi);
				return;
			}
			if (OBSERVABILITY_COMMANDS.has(cmd)) {
				await handleObservabilityCommand(cmd as any, rest, ctx, p, pi);
				return;
			}
			if (MARKER_COMMANDS.has(cmd)) {
				await handleMarkersCommand(cmd as any, rest, ctx, p, pi);
				return;
			}
			if (MESSAGING_COMMANDS.has(cmd)) {
				await handleMessagingCommand(cmd as any, rest, ctx, p, pi);
				return;
			}
			if (cmd === "pool") {
				await handlePoolCommand(cmd, rest, ctx, p, pi);
				return;
			}
			if (cmd === "goal") {
				await handleGoalCommand(cmd, rest, ctx, p, pi);
				return;
			}
			if (cmd === "protocol") {
				await handleProtocolCommand(cmd, rest, ctx, p, pi);
				return;
			}
			ctx.ui.notify(`Unknown /${commandName} command: ${cmd}`, "warning");
		} catch (err: any) {
			await trace(p, "error", {
				where: "command",
				command: cmd,
				commandName,
				message: err?.message || String(err),
				stack: err?.stack,
			});
			ctx.ui.notify(`Swarm error: ${err?.message || err}`, "error");
		}
	};

	pi.registerCommand("swarm", {
		description: SWARM_COMMAND_DESCRIPTION,
		getArgumentCompletions: (argumentPrefix) => swarmArgumentCompletions(argumentPrefix),
		handler: async (args, ctx) => runCommand(args, ctx, "swarm"),
	});
	pi.registerCommand("swarm-agents", {
		description:
			"Agent lifecycle shortcuts for swarm: list | status | spawn | register | deregister | panes | stop | restart | role | pause | resume | sendkey | attach | release | mailbox | identity",
		getArgumentCompletions: (argumentPrefix) => swarmScopedArgumentCompletions("swarm-agents", argumentPrefix),
		handler: async (args, ctx) => runCommand(args, ctx, "swarm-agents"),
	});
	pi.registerCommand("swarm-tasks", {
		description: "Task graph shortcuts for swarm: list | graph | status | next | validate",
		getArgumentCompletions: (argumentPrefix) => swarmScopedArgumentCompletions("swarm-tasks", argumentPrefix),
		handler: async (args, ctx) => runCommand(args, ctx, "swarm-tasks"),
	});
	pi.registerCommand("swarm-msg", {
		description: "Messaging shortcut for swarm: send <to> <message>",
		getArgumentCompletions: (argumentPrefix) => swarmScopedArgumentCompletions("swarm-msg", argumentPrefix),
		handler: async (args, ctx) => runCommand(args, ctx, "swarm-msg"),
	});
	pi.registerCommand("swarm-mark", {
		description: "Audit checkpoints: [name] [note...] | list | show <id> | edit <id> <note...> | rm <id> | clear [--yes]",
		getArgumentCompletions: (argumentPrefix) => swarmScopedArgumentCompletions("swarm-mark", argumentPrefix),
		handler: async (args, ctx) => runCommand(args, ctx, "swarm-mark"),
	});
}
