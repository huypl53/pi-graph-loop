// === swarm/tools/gc.ts — swarm_gc tool: bounded retention/GC under the swarm lock ===
import { Type } from "typebox";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { paths, readState, trace, withLock, writeState } from "../state.ts";
import { pruneState, DEFAULT_KEEP_MESSAGES, type PruneOptions } from "../gc.ts";
import { stoppedGcCandidates, applyStoppedGc, DEFAULT_STOPPED_OLDER_THAN_MS } from "../agent-gc.ts";
import { loadTaskGraphsForGc } from "../agent-gc-io.ts";
import { textResult } from "../utils.ts";
import { currentAgentId } from "../session.ts";
import { requireRootAuthority } from "../identity.ts";
import { wrapSwarmToolInvocation } from "./wrapper.ts";

export function registerGcTools(pi: ExtensionAPI) {
	pi.registerTool(
		defineTool({
			name: "swarm_gc",
			label: "Swarm GC",
			description:
				"Bounded retention / garbage collection for swarm state. Under the swarm lock, drops only TERMINAL messages that fall outside the most-recent keepMessages window — dead_letter, acked-done (ackedAt with last ack status 'done'), or a verified/waived response. NEVER drops actionable messages (queued, mailbox_delivered, injected, intercepted, failed, acked-but-not-done). Also caps each delivered[agentId] ledger to the most-recent keepMessages ids (intersection-safe). dryRun defaults to true: pass dryRun:false to persist.",
			promptGuidelines: [
				"Root/admin maintenance tool. Run with dryRun:true (the default) FIRST to preview what would be removed before applying.",
				"Safe by construction: only prunes the terminal tail beyond keepMessages; in-flight/actionable coordination state is never dropped.",
			],
			parameters: Type.Object({
				keepMessages: Type.Optional(
					Type.Number({ description: "Number of most-recent messages to always retain. Defaults to 500." }),
				),
				dryRun: Type.Optional(
					Type.Boolean({ description: "If true (default), report what would be removed without writing state." }),
				),
				purgeStopped: Type.Optional(
					Type.Boolean({
						description:
							"Also purge stopped agent records gated on: stopped >= stoppedOlderThanMs (default 24h) AND no non-terminal task node references them AND no response debt. Blocked candidates are reported, never removed.",
					}),
				),
				stoppedOlderThanMs: Type.Optional(
					Type.Number({ description: "Minimum stopped age for purgeStopped. Defaults to 24h (86400000 ms)." }),
				),
			}),
			async execute(_id, params, _signal, _onUpdate, ctx) {
				return wrapSwarmToolInvocation(pi, ctx.cwd, "swarm_gc", async () => {
					const p = paths(ctx.cwd);
					requireRootAuthority(currentAgentId(), "swarm_gc");
					const dryRun = params.dryRun !== false; // default true
					const opts: PruneOptions = {
						keepMessages: typeof params.keepMessages === "number" ? params.keepMessages : DEFAULT_KEEP_MESSAGES,
					};
					const purgeStopped = params.purgeStopped === true;
					const stoppedOlderThanMs =
						typeof params.stoppedOlderThanMs === "number" && params.stoppedOlderThanMs >= 0
							? params.stoppedOlderThanMs
							: DEFAULT_STOPPED_OLDER_THAN_MS;
					const result = await withLock(p, async () => {
						const st = await readState(p, ctx.cwd);
						const before = Object.keys(st.messages || {}).length;
						// pruneState mutates st in place; we persist only when !dryRun, so a dry run leaves the
						// on-disk state untouched even though the in-memory snapshot was pruned for counting.
						const res = pruneState(st, opts);
						// stopped-agent-records-gc: optional gated purge of stopped agent records. Same lock,
						// same dryRun semantics; eligibility is decided by the pure predicate in agent-gc.ts
						// (age >= stoppedOlderThanMs AND no non-terminal task assignee reference AND no debt).
						let stoppedPurge: { purged: string[]; blocked: Array<{ agentId: string; blocked: string[] }> } | undefined;
						if (purgeStopped) {
							const taskGraphs = await loadTaskGraphsForGc(p);
							const candidates = stoppedGcCandidates(st, { nowMs: Date.now(), taskGraphs, stoppedOlderThanMs });
							const applied = applyStoppedGc(st, candidates, { dryRun });
							stoppedPurge = {
								purged: applied.purged,
								blocked: candidates
									.filter((c) => !c.eligible)
									.map((c) => ({ agentId: c.agentId, blocked: c.blocked })),
							};
						}
						if (!dryRun) await writeState(p, st);
						return { before, after: before - res.removed, removed: res.removed, kept: res.kept, stoppedPurge };
					});
					await trace(p, "gc.prune", {
						dryRun,
						keepMessages: opts.keepMessages,
						removed: result.removed,
						kept: result.kept,
						before: result.before,
						after: result.after,
						...(result.stoppedPurge ? { stoppedPurge: result.stoppedPurge, stoppedOlderThanMs } : {}),
					});
					const stoppedLine = result.stoppedPurge
						? ` Stopped-agent purge ${dryRun ? "preview" : "applied"}: ${result.stoppedPurge.purged.length} purged${result.stoppedPurge.purged.length ? ` (${result.stoppedPurge.purged.join(", ")})` : ""}, ${result.stoppedPurge.blocked.length} blocked (${result.stoppedPurge.blocked.map((b) => `${b.agentId}: ${b.blocked.join("/")}`).join("; ") || "none"}).`
						: "";
					return textResult(
						`Swarm GC ${dryRun ? "dry run" : "applied"}: removed ${result.removed} terminal message(s), kept ${result.kept} of ${result.before} (keepMessages=${opts.keepMessages}).${stoppedLine}${dryRun ? " State unchanged — pass dryRun:false to apply." : ` Messages: ${result.before} → ${result.after}.`}`,
						{ removed: result.removed, kept: result.kept, dryRun, keepMessages: opts.keepMessages, before: result.before, after: result.after, stoppedPurge: result.stoppedPurge },
					);
				});
			},
		}),
	);
}
