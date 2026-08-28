// extensions/cron/src/command.ts — /cron slash command parser + handlers.
//
// Subcommands (small-scope, no names, no enable/disable/run):
//   /cron add --every <n><s|m|h> "<prompt>"
//   /cron list
//   /cron remove <#|last>
//
// Invalid usage returns clear error text. Jobs are identified by ordinal in
// /cron list output; `last` removes the most-recently-added job.
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { addJob, loadJobs, removeJobByIndex, removeLastJob } from "./store.ts";
import { parseEvery } from "./scheduler.ts";

export const USAGE =
	"Usage:\n" +
	"  /cron add --every <n><s|m|h> \"<prompt>\"\n" +
	"  /cron list\n" +
	"  /cron remove <#>          (or `last`)";

export interface ParsedArgs {
	subcommand: string;
	rest: string[];
}

export function parseArgs(input: string): ParsedArgs {
	// Naive shell-style tokeniser. Double-quoted strings are kept as one token
	// with the quotes stripped. Good enough for the small grammar; no escapes.
	const tokens: string[] = [];
	let i = 0;
	while (i < input.length) {
		while (i < input.length && /\s/.test(input[i])) i++;
		if (i >= input.length) break;
		if (input[i] === '"') {
			i++;
			let buf = "";
			while (i < input.length && input[i] !== '"') {
				buf += input[i++];
			}
			if (input[i] === '"') i++;
			tokens.push(buf);
		} else {
			let buf = "";
			while (i < input.length && !/\s/.test(input[i])) {
				buf += input[i++];
			}
			tokens.push(buf);
		}
	}
	if (tokens.length === 0) return { subcommand: "", rest: [] };
	return { subcommand: tokens[0], rest: tokens.slice(1) };
}

function formatTs(ms: number | null): string {
	if (ms == null) return "-";
	const d = new Date(ms);
	return d.toISOString().replace("T", " ").slice(0, 19) + "Z";
}

function formatEvery(ms: number): string {
	if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
	if (ms % 60_000 === 0) return `${ms / 60_000}m`;
	return `${ms / 1_000}s`;
}

export async function handleCron(args: string, ctx: ExtensionCommandContext): Promise<void> {
	const trimmed = (args || "").trim();
	if (!trimmed) {
		ctx.ui.notify(USAGE, "info");
		return;
	}
	const parsed = parseArgs(trimmed);
	switch (parsed.subcommand) {
		case "add":
			return handleAdd(parsed.rest, ctx);
		case "list":
			return handleList(ctx);
		case "remove":
			return handleRemove(parsed.rest, ctx);
		default:
			ctx.ui.notify(`Unknown subcommand: ${parsed.subcommand}\n\n${USAGE}`, "warning");
			return;
	}
}

function handleAdd(rest: string[], ctx: ExtensionCommandContext): void {
	// Expected: --every <spec> "<prompt>"
	let everyMs: number | null = null;
	let prompt = "";
	let i = 0;
	while (i < rest.length) {
		const tok = rest[i];
		if (tok === "--every") {
			const spec = rest[i + 1];
			if (!spec) {
				ctx.ui.notify("Missing value for --every\n\n" + USAGE, "warning");
				return;
			}
			try {
				everyMs = parseEvery(spec);
			} catch (err) {
				ctx.ui.notify((err as Error).message, "warning");
				return;
			}
			i += 2;
			continue;
		}
		// Everything after the flag is the prompt.
		prompt = rest.slice(i).join(" ");
		break;
	}
	if (everyMs == null) {
		ctx.ui.notify("Missing --every flag\n\n" + USAGE, "warning");
		return;
	}
	if (!prompt.trim()) {
		ctx.ui.notify("Empty prompt\n\n" + USAGE, "warning");
		return;
	}
	const jobs = loadJobs(ctx.cwd);
	const job = addJob(ctx.cwd, everyMs, prompt);
	const ordinal = jobs.length + 1; // 1-based position after the new push.
	ctx.ui.notify(
		`Added cron job #${ordinal} every=${formatEvery(job.everyMs)} (id=${job.id})`,
		"info",
	);
}

function handleList(ctx: ExtensionCommandContext): void {
	const jobs = loadJobs(ctx.cwd);
	if (jobs.length === 0) {
		ctx.ui.notify("(no cron jobs)", "info");
		return;
	}
	const lines = jobs.map((j, idx) => {
		const ordinal = idx + 1;
		const preview = j.prompt.length > 60 ? j.prompt.slice(0, 57) + "..." : j.prompt;
		const next = j.lastRunAt == null ? "next tick" : formatTs(j.lastRunAt + j.everyMs);
		return `#${ordinal}  every=${formatEvery(j.everyMs)}  next=${next}  last=${formatTs(j.lastRunAt)}  ${preview}`;
	});
	ctx.ui.notify(lines.join("\n"), "info");
}

function handleRemove(rest: string[], ctx: ExtensionCommandContext): void {
	const target = (rest[0] || "").trim();
	if (!target) {
		ctx.ui.notify("remove: missing <#> or `last`\n\n" + USAGE, "warning");
		return;
	}
	if (target === "last") {
		const removed = removeLastJob(ctx.cwd);
		if (!removed) {
			ctx.ui.notify("remove: no jobs to remove", "warning");
			return;
		}
		ctx.ui.notify(`Removed last cron job (id=${removed.id})`, "info");
		return;
	}
	if (!/^[1-9][0-9]*$/.test(target)) {
		ctx.ui.notify(`remove: invalid target ${JSON.stringify(target)} (use <#> or 'last')`, "warning");
		return;
	}
	const removed = removeJobByIndex(ctx.cwd, Number(target));
	if (!removed) {
		ctx.ui.notify(`remove: no job at #${target}`, "warning");
		return;
	}
	ctx.ui.notify(`Removed cron job #${target} (id=${removed.id})`, "info");
}
