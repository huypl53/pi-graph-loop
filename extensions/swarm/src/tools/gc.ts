// === swarm/tools/gc.ts — swarm_gc tool: bounded retention/GC under the swarm lock ===
import { Type } from "typebox";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { paths, readState, trace, withLock, writeState } from "../state.ts";
import { pruneState, DEFAULT_KEEP_MESSAGES, type PruneOptions } from "../gc.ts";
import { textResult } from "../utils.ts";
import { currentAgentId } from "../session.ts";
import { requireOrchestratorAuthority } from "../identity.ts";

export function registerGcTools(pi: ExtensionAPI) {
	pi.registerTool(defineTool({
		name: "swarm_gc",
		label: "Swarm GC",
		description: "Bounded retention / garbage collection for swarm state. Under the swarm lock, drops only TERMINAL messages that fall outside the most-recent keepMessages window — dead_letter, acked-done (ackedAt with last ack status 'done'), or a verified/waived response. NEVER drops actionable messages (queued, mailbox_delivered, injected, intercepted, failed, acked-but-not-done). Also caps each delivered[agentId] ledger to the most-recent keepMessages ids (intersection-safe). dryRun defaults to true: pass dryRun:false to persist.",
		promptGuidelines: [
			"Orchestrator/admin maintenance tool. Run with dryRun:true (the default) FIRST to preview what would be removed before applying.",
			"Safe by construction: only prunes the terminal tail beyond keepMessages; in-flight/actionable coordination state is never dropped.",
		],
		parameters: Type.Object({
			keepMessages: Type.Optional(Type.Number({ description: "Number of most-recent messages to always retain. Defaults to 500." })),
			dryRun: Type.Optional(Type.Boolean({ description: "If true (default), report what would be removed without writing state." })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const p = paths(ctx.cwd);
			requireOrchestratorAuthority(currentAgentId(), "swarm_gc");
			const dryRun = params.dryRun !== false; // default true
			const opts: PruneOptions = { keepMessages: typeof params.keepMessages === "number" ? params.keepMessages : DEFAULT_KEEP_MESSAGES };
			const result = await withLock(p, async () => {
				const st = await readState(p, ctx.cwd);
				const before = Object.keys(st.messages || {}).length;
				// pruneState mutates st in place; we persist only when !dryRun, so a dry run leaves the
				// on-disk state untouched even though the in-memory snapshot was pruned for counting.
				const res = pruneState(st, opts);
				if (!dryRun) await writeState(p, st);
				return { before, after: before - res.removed, removed: res.removed, kept: res.kept };
			});
			await trace(p, "gc.prune", { dryRun, keepMessages: opts.keepMessages, removed: result.removed, kept: result.kept, before: result.before, after: result.after });
			return textResult(
				`Swarm GC ${dryRun ? "dry run" : "applied"}: removed ${result.removed} terminal message(s), kept ${result.kept} of ${result.before} (keepMessages=${opts.keepMessages}).${dryRun ? " State unchanged — pass dryRun:false to apply." : ` Messages: ${result.before} → ${result.after}.`}`,
				{ removed: result.removed, kept: result.kept, dryRun, keepMessages: opts.keepMessages, before: result.before, after: result.after },
			);
		},
	}));
}
