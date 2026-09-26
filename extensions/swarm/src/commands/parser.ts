export type ScopedSwarmCommandName = "swarm" | "swarm-agents" | "swarm-tasks" | "swarm-msg" | "swarm-mark";

export const SWARM_COMMAND_DESCRIPTION =
	"Manage pi swarm agents: init | list | status (rollup) | tasks (indexed list w/ age) | graph [<#|task-id> [text|mermaid|json]] — no-arg lists tasks | task <#|task-id> [runtime] | next <#|task-id> (ready nodes + suggested agent) | attention [<#|task-id>] (root-only: durable recovery attention report) | remind <task-id> <node-id> (root-only: send the one bounded worker reminder) | flow <#|task-id> [--events N] (read-only observatory snapshot) | validate <#|task-id> [runtime] | spawn <id> [role] | register <here|tmux-target> <id> [role...] (adopt a pane; 'here' = current pane) | deregister <here|id> [--force] [--purge] (self-service exit from a role; pane stays alive; other-agent id root-only) | panes (list tmux targets) | stop <id> [--force] [--no-kill] | restart <id> | role <id> <role...> [--kind …] [--caps a,b] | pause <id> | resume <id> | lease <id> [--reuse|--park] [--until <iso>] [--reason <text>] [--clear] (root-only) | sendkey <id> <keys...> [--literal] [--enter] | attach <id> | release <id> [<task-id>] [--force] | mailbox reset <id> --yes | send <to> <message> | goal [show] | goal set [-i <time>] [-n <count>] <text> | goal update [-i <time>] [-n <count>] [<text>] | goal nudges [<count>] | goal done [<goalId>] (show read-only; set/update/done root-only) | trace | capture <id> | identity reload <id> [note] | identity show <id> | pool [list|show|validate|help|preview-preflight|rotate] | pool cooldown <slot> <ms> | pool clear <slot>";

export interface ParsedFlags {
	rest: string[];
	force: boolean;
	kill: boolean;
	literal: boolean;
	enter: boolean;
	yes: boolean;
	purge: boolean;
	inject?: boolean;
	kind?: string;
	model?: string;
	provider?: string;
	caps?: string;
	interval?: string;
	nudges?: string;
	origin?: string;
	"set-by-scope"?: string;
}

export function parseFlags(tokens: string[]): ParsedFlags {
	const out: ParsedFlags = { rest: [], force: false, kill: true, literal: false, enter: false, yes: false, purge: false };
	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i];
		if (t === "--force") out.force = true;
		else if (t === "--no-kill") out.kill = false;
		else if (t === "--purge") out.purge = true;
		else if (t === "--literal") out.literal = true;
		else if (t === "--enter") out.enter = true;
		else if (t === "--inject") out.inject = true;
		else if (t === "--yes") out.yes = true;
		else if (t === "--no-inject") out.inject = false;
		else if (t === "--kind") out.kind = tokens[++i];
		else if (t === "--model") out.model = tokens[++i];
		else if (t === "--provider") out.provider = tokens[++i];
		else if (t === "--caps") out.caps = tokens[++i];
		else if (t === "--interval" || t === "-i") out.interval = tokens[++i];
		else if (t === "--max-nudges" || t === "--nudges" || t === "-n") out.nudges = tokens[++i];
		else if (t === "--origin") out.origin = tokens[++i];
		else if (t === "--set-by-scope") out["set-by-scope"] = tokens[++i];
		else out.rest.push(t);
	}
	return out;
}

export function parseGoalMaxNudges(raw: string): { ok: true; count: number } | { ok: false; error: string } {
	const input = String(raw || "").trim();
	if (!input) return { ok: false, error: "missing nudges count" };
	const count = Number(input);
	if (!Number.isInteger(count) || (count <= 0 && count !== -1)) {
		return { ok: false, error: `invalid nudges count "${raw}" (must be positive integer, or -1 for infinite)` };
	}
	return { ok: true, count };
}

export function parseGoalSetInterval(raw: string): { ok: true; ms: number } | { ok: false; error: string } {
	const input = String(raw || "")
		.trim()
		.toLowerCase();
	if (!input) return { ok: false, error: "missing interval" };
	const m = input.match(/^(\d+)(ms|s|m|h)?$/);
	if (!m) return { ok: false, error: `invalid interval "${raw}"` };
	const value = Number(m[1]);
	const unit = m[2] || "ms";
	if (!Number.isFinite(value) || value <= 0) return { ok: false, error: `invalid interval "${raw}"` };
	const ms = unit === "h" ? value * 3_600_000 : unit === "m" ? value * 60_000 : unit === "s" ? value * 1_000 : value;
	if (!Number.isFinite(ms) || ms <= 0) return { ok: false, error: `invalid interval "${raw}"` };
	return { ok: true, ms: Math.floor(ms) };
}

export function scopedSwarmUsage(commandName: ScopedSwarmCommandName): string {
	switch (commandName) {
		case "swarm-agents":
			return "Usage: /swarm-agents <list|status|spawn|register|panes|stop|restart|role|pause|resume|sendkey|attach|release|mailbox|identity|focus|auto-focus> ...";
		case "swarm-tasks":
			return "Usage: /swarm-tasks <list|graph|status|next|validate> ...";
		case "swarm-msg":
			return "Usage: /swarm-msg send <to> <message>";
		case "swarm-mark":
			return "Usage: /swarm-mark [name] [note...] | list | show <id> | edit <id> <note...> | rm <id> | clear [--yes]";
		default:
			return "Usage: /swarm ...";
	}
}

export function normalizeScopedSwarmArgs(commandName: ScopedSwarmCommandName, args: string): string | null {
	if (commandName === "swarm") return args;
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	if (commandName === "swarm-mark") {
		return ["mark", ...tokens].join(" ");
	}
	if (!tokens.length) return null;
	const [cmd, ...rest] = tokens;
	if (commandName === "swarm-agents") {
		if (
			![
				"list",
				"status",
				"spawn",
				"register",
				"deregister",
				"panes",
				"stop",
				"restart",
				"role",
				"pause",
				"resume",
				"sendkey",
				"attach",
				"release",
				"mailbox",
				"identity",
				"focus",
				"auto-focus",
				"focus-busy",
			].includes(cmd)
		)
			return null;
		return [cmd, ...rest].join(" ");
	}
	if (commandName === "swarm-tasks") {
		if (cmd === "list") return ["tasks", ...rest].join(" ");
		if (cmd === "status") return ["task", ...rest].join(" ");
		if (["graph", "next", "validate"].includes(cmd)) return [cmd, ...rest].join(" ");
		return null;
	}
	if (commandName === "swarm-msg") return cmd === "send" ? [cmd, ...rest].join(" ") : null;
	return null;
}
