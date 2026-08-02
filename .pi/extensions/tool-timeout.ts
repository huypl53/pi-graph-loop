/**
 * tool-timeout — Add a default execution timeout to pi tools.
 *
 * Coverage:
 *  - read / grep / find / ls / edit / write: re-registered with `execute`
 *    wrapped so an AbortSignal fires after the timeout. All built-in fs tools
 *    already honor AbortSignal, so they abort cleanly when the timeout hits.
 *  - bash: a default `timeout` (seconds) is injected via the `tool_call` event
 *    when the model omits it. The bash tool's native process-kill + partial
 *    output is used. The model's explicit timeout is respected so it can
 *    self-adjust: on a timeout it sees the error and may retry with a larger
 *    `timeout`. An optional ceiling PI_TOOL_TIMEOUT_MAX_S clamps that
 *    escalation. When a bash command times out, a hint is appended to the
 *    result telling the model how to retry.
 *  - The timeout policy (default / ceiling / how to self-adjust / env var
 *    names) is also injected into the system prompt via `before_agent_start`,
 *    so the model knows it proactively instead of only reacting after a kill.
 *
 * Config (env):
 *   PI_TOOL_TIMEOUT_S       default timeout in seconds (default 120). 0 disables.
 *   PI_TOOL_TIMEOUT_MAX_S   optional ceiling (seconds) the model may escalate a
 *                           bash timeout up to. Unset = no clamp (default).
 *
 * Limitation: tools registered by *other* extensions can't be wrapped this way
 * — the public API (`getAllTools`) exposes only their metadata, not `execute`.
 * All built-in tools are covered.
 *
 * Project-local: loads after the project is trusted. `/reload` hot-reloads.
 */

import {
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	isBashToolResult,
	isToolCallEventType,
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

const DEFAULT_TIMEOUT_S = 120;

function readTimeoutSeconds(): number {
	const raw = process.env.PI_TOOL_TIMEOUT_S;
	if (raw === undefined || raw === "") return DEFAULT_TIMEOUT_S;
	const n = Number(raw);
	if (!Number.isFinite(n) || n <= 0) return 0; // 0 / invalid → disabled
	return n;
}

/** Optional ceiling (seconds) the model may escalate a bash timeout up to. */
function readMaxSeconds(): number | undefined {
	const raw = process.env.PI_TOOL_TIMEOUT_MAX_S;
	if (raw === undefined || raw === "") return undefined;
	const n = Number(raw);
	if (!Number.isFinite(n) || n <= 0) return undefined;
	return n;
}

/** A signal that aborts when ANY of the given signals aborts. */
export function mergeAbortSignals(...signals: (AbortSignal | undefined)[]): AbortSignal {
	const ac = new AbortController();
	for (const s of signals) {
		if (!s) continue;
		if (s.aborted) {
			ac.abort(s.reason);
			return ac.signal;
		}
		s.addEventListener("abort", () => ac.abort(s.reason), { once: true });
	}
	return ac.signal;
}

/** Return a copy of `def` whose `execute` aborts after `ms` milliseconds. */
export function withTimeout(def: ToolDefinition, ms: number): ToolDefinition {
	const name = def.name;
	const run = def.execute.bind(def);
	const seconds = Math.round(ms / 1000);
	const timeoutMsg = () => `Tool "${name}" timed out after ${seconds}s`;

	return {
		...def,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const kill = new AbortController();
			const merged = mergeAbortSignals(signal, kill.signal);
			let timedOut = false;
			return await new Promise((resolve, reject) => {
				const timer = setTimeout(() => {
					timedOut = true;
					kill.abort(); // ask the tool to stop via the merged signal
					reject(new Error(timeoutMsg()));
				}, ms);

				run(toolCallId, params, merged, onUpdate, ctx).then(
					(value) => {
						clearTimeout(timer);
						resolve(value);
					},
					(error) => {
						clearTimeout(timer);
						reject(timedOut ? new Error(timeoutMsg()) : error);
					},
				);
			});
		},
	};
}

export default function (pi: ExtensionAPI) {
	const seconds = readTimeoutSeconds();
	if (seconds <= 0) return; // disabled

	const ms = seconds * 1000;
	const maxS = readMaxSeconds();
	const cwd = process.cwd();

	// Re-register the built-in fs tools, wrapping only `execute`. The factory
	// reproduces pi's built-in tool exactly (same package version), preserving
	// description / promptSnippet / renderCall / renderResult.
	const fsToolDefs: ToolDefinition[] = [
		createReadToolDefinition(cwd),
		createGrepToolDefinition(cwd),
		createFindToolDefinition(cwd),
		createLsToolDefinition(cwd),
		createEditToolDefinition(cwd),
		createWriteToolDefinition(cwd),
	];
	for (const def of fsToolDefs) {
		pi.registerTool(withTimeout(def, ms));
	}

	// bash: inject a default timeout (seconds) when the model omits it, and
	// (optionally) clamp the model's explicit timeout to the configured ceiling
	// so self-adjustment can't escalate past it.
	pi.on("tool_call", (event) => {
		if (!isToolCallEventType("bash", event)) return;
		if (event.input.timeout === undefined) event.input.timeout = seconds;
		if (maxS !== undefined && event.input.timeout > maxS) event.input.timeout = maxS;
	});

	// bash: when a command times out, append a hint so the model knows it can
	// retry with a larger `timeout` (and what the ceiling is, if any).
	pi.on("tool_result", (event) => {
		if (!isBashToolResult(event) || !event.isError) return;
		const text = event.content.map((c) => ("text" in c ? c.text : "")).join("\n");
		if (!/timed out after \d+ seconds?/i.test(text)) return;
		const ceiling = maxS !== undefined ? `, up to a maximum of ${maxS}s` : "";
		const hint = `The command was terminated because it exceeded the per-tool timeout. If it legitimately needs more time, call the bash tool again with a larger "timeout" parameter (in seconds)${ceiling}.`;
		return { content: [...event.content, { type: "text" as const, text: hint }] };
	});

	// Make the timeout policy known upfront (env var names included) so the model
	// can plan around it and self-adjust; the post-timeout hint is the fallback.
	pi.on("before_agent_start", (event) => {
		const maxClause = maxS !== undefined ? ` — up to a hard maximum of ${maxS}s` : "";
		const note =
			`\n\n[tool-timeout] A per-tool execution timeout is active. ` +
			`Bash commands use a default timeout of ${seconds}s if you omit the "timeout" parameter; if a command legitimately needs more time, call the bash tool again with a larger "timeout" (in seconds)${maxClause}. ` +
			`read/grep/find/ls/edit/write are also bounded by ${seconds}s. ` +
			`(Configurable via PI_TOOL_TIMEOUT_S / PI_TOOL_TIMEOUT_MAX_S.)`;
		return { systemPrompt: (event.systemPrompt ?? "") + note };
	});

	// Tiny status command so the active timeout is easy to verify.
	pi.registerCommand("timeout", {
		description: "Show the current per-tool timeout (set via PI_TOOL_TIMEOUT_S)",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;
			const where = `${CONFIG_DIR_NAME}/extensions/tool-timeout.ts`;
			const max = maxS !== undefined ? `; escalation ceiling: ${maxS}s` : "";
			ctx.ui.notify(
				`Per-tool timeout: ${seconds}s${process.env.PI_TOOL_TIMEOUT_S ? "" : " (default)"}${max}. Set PI_TOOL_TIMEOUT_S / PI_TOOL_TIMEOUT_MAX_S; 0 disables. (${where})`,
				"info",
			);
		},
	});
}
