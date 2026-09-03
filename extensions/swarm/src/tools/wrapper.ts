// === swarm/tools/wrapper.ts — common swarm-tool invocation wrapper (Issue 25 Phase 1) ===
//
// Emits a `tool.invoked` trace ONCE per call with the tool name, caller agent id, gate state,
// success/error class, and call duration. Pure telemetry; NEVER mutates tool results, NEVER
// inspects return values, NEVER swallows errors. The wrapper is mandatory for every tool in
// src/tools/*.ts so the §G telemetry acceptance criterion is met. Phase 1 ships the wrapper;
// under gate=0 the wrapper is purely additive and never changes behavior.
//
// Wrapping strategy (per plan §2.8 + review R5): applied at the per-tool `execute` handler so
// coverage is guaranteed and the existing registration / pi.getAllTools() counts are untouched.
// Telemetry failure is best-effort and never propagates.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PI_SWARM_MINIMAL_PROTOCOL, TRACE_TOOL_INVOKED } from "../constants.ts";
import { paths, trace } from "../state.ts";
import { currentAgentId } from "../session.ts";

export type ToolInvocationClass = "success" | "error" | "thrown";

// Issue 25 Phase 1 — common swarm-tool wrapper. Re-throws on thrown errors (verified by the
// new shadow test), stamps `cls: "thrown"` + errClass before re-throw. Successful returns are
// passed through verbatim. Best-effort: a trace failure is logged but never propagated.
export async function wrapSwarmToolInvocation<T>(
	pi: ExtensionAPI | any,
	cwd: string,
	toolName: string,
	exec: () => Promise<T>,
): Promise<T> {
	const start = Date.now();
	let cls: ToolInvocationClass = "success";
	let errClass: string | undefined;
	try {
		return await exec();
	} catch (err: any) {
		cls = "thrown";
		errClass = err?.code || err?.name || "Error";
		throw err;
	} finally {
		try {
			const p = paths(cwd);
			const durationMs = Date.now() - start;
			await trace(p, TRACE_TOOL_INVOKED, {
				tool: toolName,
				agentId: currentAgentId(),
				gate: PI_SWARM_MINIMAL_PROTOCOL,
				cls,
				errClass,
				durationMs,
			});
		} catch {
			// Telemetry is best-effort; never propagate a trace failure.
		}
	}
}
