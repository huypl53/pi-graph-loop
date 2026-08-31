// swarm/src/completion.ts — argument autocompletion for the /swarm slash command.
//
// Pi invokes `getArgumentCompletions(argumentPrefix)` with the ENTIRE string typed
// after `/swarm ` (e.g. `/swarm graph 1 te` → argumentPrefix = "graph 1 te"). Each
// returned AutocompleteItem.value must be the FULL argument string to substitute,
// because pi's applyCompletion replaces the whole prefix with item.value. We
// therefore split the prefix into already-typed tokens + the word being completed
// and emit values = "<kept tokens> <completed word>".
//
// Completion fires on the AUTO path (typing alphanumeric chars in a slash context);
// Tab past the command name falls back to file completion in pi, so argument picks
// appear as the user types the first char of each positional/flag.
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { listTasksIndexed } from "./reconcile.ts";
import { paths, readState } from "./state.ts";
import { safeId } from "./utils.ts";
import type { Paths } from "./types.ts";

const SUBCOMMANDS: { name: string; description: string }[] = [
	{ name: "init", description: "Initialize swarm state" },
	{ name: "list", description: "Show swarm summary (id, agent count, tmux)" },
	{ name: "status", description: "PM-facing status rollup" },
	{ name: "graph", description: "Print a task graph (text|mermaid|json)" },
	{ name: "tasks", description: "Indexed task list with age/next" },
	{ name: "task", description: "Detailed per-task status" },
	{ name: "next", description: "Ready nodes + suggested reusable agent" },
	{ name: "flow", description: "Read-only flow snapshot: nodes + agent lanes + recent events" },
	{ name: "validate", description: "Validate a task graph" },
	{ name: "spawn", description: "Spawn an agent: <id> [role]" },
	{ name: "register", description: "Adopt a tmux pane: <here|target> <id> [role] [flags]" },
	{ name: "panes", description: "List tmux panes/targets (for register)" },
	{ name: "stop", description: "Stop an agent: <id> [--force] [--no-kill]" },
	{ name: "restart", description: "Restart an agent: <id>" },
	{ name: "role", description: "Change role: <id> <role> [--kind K] [--caps a,b]" },
	{ name: "pause", description: "Pause an agent: <id>" },
	{ name: "resume", description: "Resume an agent: <id>" },
	{ name: "sendkey", description: "Send keys to a pane: <id> <keys> [--literal] [--enter]" },
	{ name: "attach", description: "Show tmux attach commands: <id>" },
	{ name: "release", description: "Release a task from an agent: <id> [<task-id>] [--force]" },
	{ name: "mailbox", description: "Mailbox maintenance: reset <id> --yes" },
	{ name: "send", description: "Send a message: <to> <body>" },
	{ name: "goal", description: "show | set [-i <time>] <text> | update [-i <time>] [<text>] | done [<goalId>] (show read-only; set/update/done orchestrator-only; -i accepts ms/s/m/h)" },
	{ name: "trace", description: "Show trace file path" },
	{ name: "capture", description: "Capture an agent's tmux pane: <id>" },
	{ name: "identity", description: "reload|show an agent's identity" },
	{ name: "pool", description: "Model pool: list | show | validate | help | preview-preflight | cooldown <slot> <ms> | clear <slot>" },
];

const SCOPED_COMMANDS: Record<string, { name: string; description: string; canonical: string }[]> = {
	"swarm-agents": [
		{ name: "list", description: "Show swarm summary (id, agent count, tmux)", canonical: "list" },
		{ name: "status", description: "PM-facing status rollup", canonical: "status" },
		{ name: "spawn", description: "Spawn an agent: <id> [role]", canonical: "spawn" },
		{ name: "register", description: "Adopt a tmux pane into the swarm", canonical: "register" },
		{ name: "panes", description: "List tmux panes/targets", canonical: "panes" },
		{ name: "stop", description: "Stop an agent", canonical: "stop" },
		{ name: "restart", description: "Restart an agent", canonical: "restart" },
		{ name: "role", description: "Change an agent role", canonical: "role" },
		{ name: "pause", description: "Pause an agent", canonical: "pause" },
		{ name: "resume", description: "Resume an agent", canonical: "resume" },
		{ name: "sendkey", description: "Send raw tmux keys to a pane", canonical: "sendkey" },
		{ name: "attach", description: "Show tmux attach commands", canonical: "attach" },
		{ name: "release", description: "Release stale task ownership from an agent", canonical: "release" },
		{ name: "mailbox", description: "Mailbox maintenance: reset <id> --yes", canonical: "mailbox" },
		{ name: "identity", description: "reload|show an agent's identity", canonical: "identity" },
	],
	"swarm-tasks": [
		{ name: "list", description: "Indexed task list with age/next", canonical: "tasks" },
		{ name: "graph", description: "Print a task graph (text|mermaid|json)", canonical: "graph" },
		{ name: "status", description: "Detailed per-task status", canonical: "task" },
		{ name: "next", description: "Ready nodes + suggested reusable agent", canonical: "next" },
		{ name: "validate", description: "Validate a task graph", canonical: "validate" },
	],
	"swarm-msg": [
		{ name: "send", description: "Send a message: <to> <body>", canonical: "send" },
	],
};

const GRAPH_FORMATS = ["text", "mermaid", "json"];
const GOAL_SUBS = ["show", "set", "update", "done"];
const PROTOCOL_SUBS = ["migrate"];
const RUNTIME_FLAGS = ["runtime", "--runtime", "-r"];
const ROLE_KINDS = ["orchestrator", "planner", "reviewer", "tester", "implementer", "worker", "observer"];
const IDENTITY_SUBS = ["reload", "show"];
const MAILBOX_SUBS = ["reset"];
const REGISTER_FLAGS = ["--kind", "--model", "--provider", "--inject", "--no-inject"];
const STOP_FLAGS = ["--force", "--no-kill"];
const ROLE_FLAGS = ["--kind", "--caps"];
const SENDKEY_FLAGS = ["--literal", "--enter"];
const RELEASE_FLAGS = ["--force"];
const MAILBOX_RESET_FLAGS = ["--yes"];

// getArgumentCompletions receives no ctx, so we remember the project cwd from
// session_start (the command handler uses ctx.cwd; this keeps parity). Fallback
// is process.cwd(), which is pi's main-session cwd anyway.
let lastCwd = process.cwd();

export function registerCwdTracking(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		lastCwd = ctx.cwd;
	});
}

interface Parsed {
	/** Fully-typed preceding tokens (e.g. ["graph", "1"] for "graph 1 te"). */
	tokens: string[];
	/** Word currently being completed; "" when the prefix ends with whitespace. */
	currentWord: string;
}

function parsePrefix(argumentPrefix: string): Parsed {
	const endsWithSpace = /\s$/.test(argumentPrefix);
	const tokens = argumentPrefix.trim().split(/\s+/).filter(Boolean);
	const currentWord = endsWithSpace ? "" : (tokens.pop() ?? "");
	return { tokens, currentWord };
}

/** Fixed prefix to prepend to every emitted value (= "<tokens> " or ""). */
function kept(tokens: string[]): string {
	return tokens.length ? `${tokens.join(" ")} ` : "";
}

function startsWith(word: string, prefix: string): boolean {
	return word.toLowerCase().startsWith(prefix.toLowerCase());
}

/**
 * Task picker. graph/task/next/validate accept an index OR a task-id (resolveTaskArg),
 * so by default we offer the "#" form when the word is empty/numeric and the id form
 * otherwise.
 */
async function taskSuggestions(
	p: Paths,
	b: string,
	currentWord: string,
	{ idOnly = false }: { idOnly?: boolean } = {},
): Promise<AutocompleteItem[]> {
	const list = await listTasksIndexed(p);
	const numeric = /^\d*$/.test(currentWord);
	const items: AutocompleteItem[] = [];
	for (const t of list) {
		const idx = String(t.index);
		const title = t.title ? ` — ${t.title}` : "";
		if (!idOnly && numeric) {
			if (!idx.startsWith(currentWord)) continue;
			items.push({ value: `${b}${idx}`, label: `#${idx}`, description: `${t.taskId}${title} (${t.status})` });
		} else if (startsWith(t.taskId, currentWord)) {
			items.push({ value: `${b}${t.taskId}`, label: t.taskId, description: `#${idx}${title} (${t.status})` });
		}
	}
	return items;
}

async function agentSuggestions(p: Paths, cwd: string, b: string, currentWord: string): Promise<AutocompleteItem[]> {
	const st = await readState(p, cwd);
	const agents = Object.values(st.agents).sort((a, c) => a.id.localeCompare(c.id));
	return agents
		.filter((a) => startsWith(a.id, currentWord))
		.map((a) => ({ value: `${b}${a.id}`, label: a.id, description: `${a.role} [${a.status}]` }));
}

/** The active task-ids of a given agent (for `/swarm release <id> <task-id>`). */
async function activeTaskSuggestions(p: Paths, cwd: string, agentId: string, b: string, currentWord: string): Promise<AutocompleteItem[]> {
	const st = await readState(p, cwd);
	const agent = st.agents[safeId(agentId)];
	if (!agent) return [];
	return (agent.activeTaskIds || [])
		.filter((id) => startsWith(id, currentWord))
		.map((id) => ({ value: `${b}${id}`, label: id, description: `active on ${agent.id}` }));
}

function simple(items: string[], b: string, currentWord: string): AutocompleteItem[] {
	return items.filter((v) => startsWith(v, currentWord)).map((v) => ({ value: `${b}${v}`, label: v }));
}

/**
 * Flag picker. Offer flag names when the word is empty or already starts with "-"
 * (so flags never clutter ordinary positional typing). Returns [] for non-dash words.
 */
function flagSuggestions(flags: string[], b: string, currentWord: string): AutocompleteItem[] {
	if (currentWord && !currentWord.startsWith("-")) return [];
	return flags.filter((v) => startsWith(v, currentWord)).map((v) => ({ value: `${b}${v}`, label: v }));
}

/**
 * Argument autocompletion for `/swarm`. Returns the candidate full-argument strings
 * (each item.value replaces everything after `/swarm `), or null/[] to offer nothing.
 * Never throws — a completion error must not break typing.
 */
export async function swarmArgumentCompletions(argumentPrefix: string): Promise<AutocompleteItem[] | null> {
	try {
		const cwd = lastCwd;
		const p = paths(cwd);
		const { tokens, currentWord } = parsePrefix(argumentPrefix);
		const b = kept(tokens);
		const prev = tokens[tokens.length - 1];

		// Position 0: completing the subcommand name.
		if (tokens.length === 0) {
			return SUBCOMMANDS.filter((s) => startsWith(s.name, currentWord)).map((s) => ({
				value: `${b}${s.name}`,
				label: s.name,
				description: s.description,
			}));
		}

		switch (tokens[0]) {
			case "graph":
				if (tokens.length === 1) return await taskSuggestions(p, b, currentWord);
				if (tokens.length === 2) return simple(GRAPH_FORMATS, b, currentWord);
				return [];
			case "task":
			case "validate":
				if (tokens.length === 1) return await taskSuggestions(p, b, currentWord);
				if (tokens.length === 2) return simple(RUNTIME_FLAGS, b, currentWord);
				return [];
			case "next":
				return tokens.length === 1 ? await taskSuggestions(p, b, currentWord) : [];
			case "flow":
				if (tokens.length === 1) return await taskSuggestions(p, b, currentWord);
				if (tokens.length === 2) return simple(["--events"], b, currentWord);
				return [];
			case "capture":
			case "attach":
			case "restart":
			case "pause":
			case "resume":
				return tokens.length === 1 ? await agentSuggestions(p, cwd, b, currentWord) : [];
			case "send":
				// <to> <body...>: complete the recipient, then body is free text.
				return tokens.length === 1 ? await agentSuggestions(p, cwd, b, currentWord) : [];
			case "spawn":
				// <id> [role]: id is free text; offer role kinds at the role position.
				return tokens.length === 2 ? simple(ROLE_KINDS, b, currentWord) : [];
			case "stop":
				if (tokens.length === 1) return await agentSuggestions(p, cwd, b, currentWord);
				return flagSuggestions(STOP_FLAGS, b, currentWord);
			case "sendkey":
				// <id> <keys...> [--literal] [--enter]: id then free-text keys; offer flags only.
				if (tokens.length === 1) return await agentSuggestions(p, cwd, b, currentWord);
				return flagSuggestions(SENDKEY_FLAGS, b, currentWord);
			case "role":
				if (tokens.length === 1) return await agentSuggestions(p, cwd, b, currentWord);
				if (tokens.length === 2) return simple(ROLE_KINDS, b, currentWord);
				if (prev === "--kind") return simple(ROLE_KINDS, b, currentWord);
				return flagSuggestions(ROLE_FLAGS, b, currentWord);
			case "register":
				// <here|tmux-target> <id> [role...] [flags]: 'here' adopts the current pane; otherwise the
				// target is free text (use '/swarm panes' to discover explicit targets).
				if (tokens.length === 1) {
					return startsWith("here", currentWord)
						? [{ value: `${b}here`, label: "here", description: "the current tmux pane" }]
						: [];
				}
				if (tokens.length === 3) return simple(ROLE_KINDS, b, currentWord);
				if (tokens.length >= 4) {
					if (prev === "--kind") return simple(ROLE_KINDS, b, currentWord);
					return flagSuggestions(REGISTER_FLAGS, b, currentWord);
				}
				return [];
			case "release":
				// <id> [<task-id>] [--force]: at pos 2 offer the agent's active tasks (or --force).
				if (tokens.length === 1) return await agentSuggestions(p, cwd, b, currentWord);
				if (tokens.length === 2) {
					if (currentWord.startsWith("-")) return flagSuggestions(RELEASE_FLAGS, b, currentWord);
					return await activeTaskSuggestions(p, cwd, tokens[1], b, currentWord);
				}
				return flagSuggestions(RELEASE_FLAGS, b, currentWord);
			case "identity":
				if (tokens.length === 1) return simple(IDENTITY_SUBS, b, currentWord);
				if (tokens.length === 2 && IDENTITY_SUBS.includes(tokens[1]))
					return await agentSuggestions(p, cwd, b, currentWord);
				return [];
			case "mailbox":
				if (tokens.length === 1) return simple(MAILBOX_SUBS, b, currentWord);
				if (tokens.length === 2 && tokens[1] === "reset") {
					const here = startsWith("here", currentWord) ? [{ value: `${b}here`, label: "here", description: "the current swarm pane identity" }] : [];
					return [...here, ...(await agentSuggestions(p, cwd, b, currentWord))];
				}
				if (tokens.length >= 3) return flagSuggestions(MAILBOX_RESET_FLAGS, b, currentWord);
				return [];
			case "goal":
				if (tokens.length === 1) return simple(GOAL_SUBS, b, currentWord);
				return [];
			case "protocol":
				if (tokens.length === 1) return simple(PROTOCOL_SUBS, b, currentWord);
				if (tokens.length === 2)
					return currentWord.startsWith("-")
						? [{ value: `${b}--dry-run`, label: "--dry-run", description: "Preview migration without writing" }]
						: [];
				return [];
			case "init":
			case "list":
			case "status":
			case "tasks":
			case "trace":
				// No meaningful positional args.
				return [];
			default:
				return [];
		}
	} catch {
		return null;
	}
}

function completionEntry(commandName: string, firstToken: string) {
	return (SCOPED_COMMANDS[commandName] || []).find((entry) => entry.name === firstToken) || null;
}

function mapScopedValue(entry: { name: string; canonical: string }, value: string): string {
	const canonicalTokens = entry.canonical.split(/\s+/).filter(Boolean);
	const valueTokens = value.split(/\s+/).filter(Boolean);
	if (canonicalTokens.some((token, idx) => valueTokens[idx] !== token)) return value;
	return [entry.name, ...valueTokens.slice(canonicalTokens.length)].join(" ");
}

export async function swarmScopedArgumentCompletions(commandName: string, argumentPrefix: string): Promise<AutocompleteItem[] | null> {
	if (commandName === "swarm") return swarmArgumentCompletions(argumentPrefix);
	try {
		const entries = SCOPED_COMMANDS[commandName] || [];
		const { tokens, currentWord } = parsePrefix(argumentPrefix);
		if (tokens.length === 0) {
			return entries
				.filter((entry) => startsWith(entry.name, currentWord))
				.map((entry) => ({ value: entry.name, label: entry.name, description: entry.description }));
		}
		const entry = completionEntry(commandName, tokens[0]);
		if (!entry) return [];
		const canonicalTokens = entry.canonical.split(/\s+/).filter(Boolean);
		const rebuilt = [...canonicalTokens, ...tokens.slice(1)];
		if (currentWord) rebuilt.push(currentWord);
		let canonicalPrefix = rebuilt.join(" ");
		if (/\s$/.test(argumentPrefix)) canonicalPrefix += " ";
		const items = await swarmArgumentCompletions(canonicalPrefix);
		return (items || []).map((item) => ({
			...item,
			value: mapScopedValue(entry, item.value),
		}));
	} catch {
		return null;
	}
}
