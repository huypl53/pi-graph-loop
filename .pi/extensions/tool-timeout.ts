/**
 * tool-timeout — Add a default execution timeout to pi tools.
 *
 * Coverage:
 *  - read / grep / find / ls / edit / write: re-registered with `execute`
 *    wrapped so an AbortSignal fires after the timeout. All built-in fs tools
 *    already honor AbortSignal, so they abort cleanly when the timeout hits.
 *  - bash: a default `timeout` (seconds) is injected via the `tool_call` event
 *    ONLY when the model omits it. The bash tool's native process-kill + partial
 *    output is used. The model's explicit timeout is always respected (no
 *    clamping) — leave the cap to pi / a future flag.
 *
 * Config (env):
 *   PI_TOOL_TIMEOUT_S   default timeout in seconds (default 120). 0 disables.
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

	// bash: inject a default timeout (seconds) only when the model omits it.
	pi.on("tool_call", (event) => {
		if (isToolCallEventType("bash", event) && event.input.timeout === undefined) {
			event.input.timeout = seconds;
		}
	});

	// Tiny status command so the active timeout is easy to verify.
	pi.registerCommand("timeout", {
		description: "Show the current per-tool timeout (set via PI_TOOL_TIMEOUT_S)",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;
			const where = `${CONFIG_DIR_NAME}/extensions/tool-timeout.ts`;
			ctx.ui.notify(
				`Per-tool timeout: ${seconds}s${process.env.PI_TOOL_TIMEOUT_S ? "" : " (default)"}. Set PI_TOOL_TIMEOUT_S to change; 0 disables. (${where})`,
				"info",
			);
		},
	});
}
