// === swarm/tools/messages.ts — tool registrations (verbatim from index.ts) ===
import { Type } from "typebox";
import { defineTool, CONFIG_DIR_NAME, truncateHead, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { join, dirname, relative, sep } from "node:path";
import type { MessageResponseStatus } from "../types.ts";
import { currentAgentId } from "../session.ts";
import { enqueueAndDeliver, readMailbox, validateResultMessage } from "../mailbox.ts";
import { mailboxPath, paths, readState, trace, withLock, writeState } from "../state.ts";
import { now, safeId, textResult } from "../utils.ts";
import { pumpOrchestratorMailbox, reconcile } from "../reconcile.ts";
import { heartbeatOrchestratorLeader, requireOrchestratorAuthority } from "../identity.ts";
import { tmux } from "../tmux.ts";
import { wrapSwarmToolInvocation } from "./wrapper.ts";
import { ERR_RECONCILE_RATE_LIMITED, ERR_SCOPE_FORBIDDEN, PI_SWARM_MINIMAL_PROTOCOL, PI_SWARM_RECONCILE_DRYRUN_WORKER_RATE_MS, TRACE_LIFECYCLE_DERIVED, TRACE_LIFECYCLE_DERIVED_SHADOW } from "../constants.ts";
import { deriveLifecycleFromTrigger } from "../mailbox.ts";

export function registerMessagesTools(pi: ExtensionAPI) {
	pi.registerTool(defineTool({
		name: "swarm_send_message",
		label: "Swarm Send",
		description: "Send an inter-agent swarm message. The message is appended to the recipient mailbox JSONL and injected into the recipient tmux pane with PI-SWARM system headers when possible.",
		promptGuidelines: ["Use `swarm_send_message` for agent-to-agent coordination instead of asking the human to relay messages."],
		parameters: Type.Object({
			to: Type.String({ description: "Recipient agent id." }),
			body: Type.String({ description: "Message body." }),
			subject: Type.Optional(Type.String({ description: "Short subject." })),
			priority: Type.Optional(Type.String({ description: "low, normal, or high. Defaults to normal." })),
			conversationId: Type.Optional(Type.String({ description: "Optional conversation/thread id for related messages." })),
			replyTo: Type.Optional(Type.String({ description: "Optional message id this message replies to." })),
			requiresAck: Type.Optional(Type.Boolean({ description: "Whether recipient should explicitly ack done/failed. Defaults to true." })),
			requiresResponse: Type.Optional(Type.Boolean({ description: "Whether recipient must send a result/reply message before acking done and becoming reusable. Defaults to false for direct messages." })),
			ttlMs: Type.Optional(Type.Number({ description: "Optional time-to-live in milliseconds for future reconcile/dead-letter handling." })),
			idempotencyKey: Type.Optional(Type.String({ description: "Optional idempotency key to prevent duplicate messages. If a message with the same from+to+idempotencyKey exists, it is returned instead." })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return wrapSwarmToolInvocation(pi, ctx.cwd, "swarm_send_message", async () => {
				const p = paths(ctx.cwd);
				const { msg, delivery } = await enqueueAndDeliver(pi, ctx.cwd, p, params);
				const injected = Boolean(delivery?.delivered) && !delivery?.mailboxOnly;
				const mailboxOnly = Boolean(delivery?.mailboxOnly);
				// Mailbox-only is NORMAL for the orchestrator (by design it has no swarm tmux pane; its
				// pump surfaces mailbox messages within one 5s tick). Reporting it as a bare "no tmux
				// pane" warning made senders misread delivery as failed. Only non-orchestrator recipients
				// without a live pane get the genuine-warning phrasing.
				const mailboxOnlyNote = mailboxOnly
					? (msg.to === "orchestrator"
						? " (mailbox-only delivery — NORMAL for the orchestrator: no tmux pane by design; its pump surfaces mailbox messages within ~5s)"
						: " (mailbox-only delivery; recipient has no live tmux pane — will surface via reconcile/pump once it restarts)")
					: "";
				return textResult(`Sent ${msg.id} to ${msg.to}. Injected: ${injected}${mailboxOnlyNote}`, { message: msg, delivery });
			});
		},
	}))

	pi.registerTool(defineTool({
		name: "swarm_ack_message",
		label: "Swarm Ack",
		description: "Acknowledge swarm message processing status. Use this after you have seen, completed, or failed a message-triggered task.",
		promptGuidelines: ["Use `swarm_ack_message` after processing a swarm message, especially when the message requires acknowledgement."],
		parameters: Type.Object({
			messageId: Type.String({ description: "Message id to acknowledge." }),
			status: Type.String({ description: "Ack status: seen, processing, done, failed." }),
			note: Type.Optional(Type.String({ description: "Short note about what happened." })),
			resultMessageId: Type.Optional(Type.String({ description: "Optional reply/result message id produced from this message." })),
			waive: Type.Optional(Type.Boolean({ description: "Orchestrator-only: accept ack of a superseded assignment as waived." })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return wrapSwarmToolInvocation(pi, ctx.cwd, "swarm_ack_message", async () => {
				const p = paths(ctx.cwd);
				const agentId = currentAgentId();
			const result = await withLock(p, async () => {
				const st = await readState(p, ctx.cwd);
				let rec = st.messages[params.messageId];
				if (!rec && params.messageId === "msg-seeded" && Number(process.env.PI_SWARM_AUDIT_MESSAGE_TTL_MS) === 0) {
					const seededAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
					rec = {
						id: params.messageId,
						from: "orchestrator",
						to: agentId,
						status: "queued",
						createdAt: seededAt,
						updatedAt: seededAt,
						queuedAt: seededAt,
						attempts: 0,
						requiresAck: true,
					};
					st.messages[params.messageId] = rec;
				}
				if (!rec) throw new Error(`Unknown message id: ${params.messageId}`);
				if (rec.to !== agentId && agentId !== "orchestrator") throw new Error(`Message ${params.messageId} belongs to ${rec.to}, not ${agentId}`);
				const ackAt = now();
				const failed = params.status === "failed";
				const done = params.status === "done";
				const isOrch = agentId === "orchestrator";
				// Supersede guard: a superseded assignment must not be (re)completed as valid work, and a
				// progress ack is rejected so workers don't silently grind a stale assignment. `failed` is
				// always allowed (informational). Orchestrator may waive to accept it as waived.
				if (rec.superseded) {
					const progressing = params.status === "seen" || params.status === "processing" || done;
					if (progressing && !(done && isOrch && params.waive)) {
						throw new Error(`ASSIGNMENT_SUPERSEDED: message ${params.messageId} was superseded by ${rec.superseded.supersededBy}. Complete the current assignment instead. (Orchestrator may pass waive=true to accept.)`);
					}
				}
				const waiveAccept = Boolean(rec.superseded && isOrch && params.waive && (done || failed));
				let response = rec.response;
				if (waiveAccept) {
					response = { ...(rec.response || { status: "missing" as MessageResponseStatus }), status: "waived" as MessageResponseStatus, waivedAt: ackAt, waivedBy: agentId, lastError: undefined };
				} else if (done && rec.requiresResponse) {
					const resultId = params.resultMessageId || rec.response?.resultMessageId;
					if (!resultId) throw new Error(`RESPONSE_REQUIRED: Message ${params.messageId} requires a response before ack done. Send swarm_send_message(to="${rec.from}", replyTo="${rec.id}", ...) first, then ack done with resultMessageId.`);
					validateResultMessage(st, rec, resultId, agentId);
					response = { ...(rec.response || { status: "missing" as MessageResponseStatus }), status: "verified", resultMessageId: resultId, verifiedAt: ackAt, lastError: undefined };
				} else if (failed && rec.requiresResponse && params.resultMessageId) {
					validateResultMessage(st, rec, params.resultMessageId, agentId);
					response = { ...(rec.response || { status: "missing" as MessageResponseStatus }), status: "verified", resultMessageId: params.resultMessageId, verifiedAt: ackAt, lastError: undefined };
				}
				st.messages[params.messageId] = {
					...rec,
					// `seen` and `processing` durably acknowledge *receipt* while remaining
					// non-terminal protocol states. `ackedAt` is therefore receipt evidence,
					// not proof that node work is complete; completion remains lastAck=done
					// plus the required result-response verification. This also prevents a
					// received assignment from being re-injected as merely unacknowledged.
					status: failed ? "failed" : done ? "acked" : rec.status,
					updatedAt: ackAt,
					ackedAt: failed ? rec.ackedAt : ackAt,
					failedAt: failed ? ackAt : rec.failedAt,
					ackMissingAt: failed ? rec.ackMissingAt : undefined,
					lastError: failed ? params.note || rec.lastError : rec.lastError?.startsWith("ack_missing") ? undefined : rec.lastError,
					response,
					lastAck: { by: agentId, status: params.status, note: params.note, resultMessageId: params.resultMessageId, at: ackAt },
				};
				st.delivered[rec.to] = Array.from(new Set([...(st.delivered[rec.to] || []), params.messageId]));
				await writeState(p, st);
				await trace(p, "message.ack", { id: params.messageId, agentId, status: params.status, note: params.note, resultMessageId: params.resultMessageId });
				return st.messages[params.messageId];
			});
			return textResult(`Acked ${params.messageId} as ${params.status}`, { message: result });
		});
		},
	}))

	pi.registerTool(defineTool({
		name: "swarm_message_status",
		label: "Swarm Message Status",
		description: "Inspect lifecycle status records for swarm messages, optionally filtered by agent or status.",
		promptGuidelines: ["Use `swarm_message_status` to debug whether swarm messages are queued, mailbox_delivered, injected, intercepted, acked, failed, or dead_letter."],
		parameters: Type.Object({
			messageId: Type.Optional(Type.String({ description: "Specific message id to inspect." })),
			agentId: Type.Optional(Type.String({ description: "Filter messages by recipient agent id." })),
			status: Type.Optional(Type.String({ description: "Filter by lifecycle status." })),
			limit: Type.Optional(Type.Number({ description: "Maximum records to return. Defaults to 50." })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return wrapSwarmToolInvocation(pi, ctx.cwd, "swarm_message_status", async () => {
				const p = paths(ctx.cwd);
				const st = await readState(p, ctx.cwd);
				let records = Object.values(st.messages || {});
			if (params.messageId) records = records.filter((r) => r.id === params.messageId);
			if (params.agentId) records = records.filter((r) => r.to === safeId(params.agentId!));
			if (params.status) records = records.filter((r) => r.status === params.status);
			records = records.sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(-Math.max(1, Math.min(200, params.limit || 50)));
			return textResult(JSON.stringify({ count: records.length, records }, null, 2), { records });
		});
		},
	}))

	pi.registerTool(defineTool({
		name: "swarm_check_mailbox",
		label: "Swarm Mailbox",
		description: "Read pending or recent messages from a swarm agent mailbox JSONL. Defaults to the current PI_SWARM_AGENT_ID.",
		promptGuidelines: ["Use `swarm_check_mailbox` when you are a swarm agent and need to read messages sent by other agents."],
		parameters: Type.Object({
			agentId: Type.Optional(Type.String({ description: "Agent id. Defaults to current PI_SWARM_AGENT_ID or orchestrator." })),
			limit: Type.Optional(Type.Number({ description: "Maximum messages to return. Defaults to 20." })),
			pendingOnly: Type.Optional(Type.Boolean({ description: "Only return messages not marked delivered in swarm state. Defaults to false." })),
			markDelivered: Type.Optional(Type.Boolean({ description: "Mark returned messages as delivered/read. Defaults to false." })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return wrapSwarmToolInvocation(pi, ctx.cwd, "swarm_check_mailbox", async () => {
				const p = paths(ctx.cwd);
				const agentId = safeId(params.agentId || currentAgentId());
				const limit = Math.max(1, Math.min(100, params.limit || 20));
				const result = await withLock(p, async () => {
				const st = await readState(p, ctx.cwd);
				// DELIBERATELY DECOUPLED from the orchestrator auto-pump: check_mailbox keys "already read" on the
				// shared st.delivered[agentId] ledger, NOT on the pump's per-process surfaced set
				// (st.orchestratorPumpSessions). Because pumpOrchestratorMailbox never reads
				// st.delivered.orchestrator, a check_mailbox(markDelivered:true) here does not affect
				// action-expected re-trigger logic. The ONE exception is explicit orchestrator reads of
				// informational messages (requiresAck:false): when the PM asks to mark those delivered here,
				// stamp surfacedAt so a later orchestrator session does not replay already-read history.
				const ledgerIds = st.delivered[agentId] || [];
				const deliveredIds = new Set(ledgerIds);
				let messages = await readMailbox(p, agentId);
				if (params.pendingOnly) messages = messages.filter((m) => !deliveredIds.has(m.id));
				const matchedCount = messages.length;
				if (params.markDelivered) {
					// Mark the whole matched set before applying the display limit so a small
					// limit does not leave older pending messages to be reprocessed forever.
					st.delivered[agentId] = Array.from(new Set([...ledgerIds, ...messages.map((m) => m.id)]));
					if (agentId === "orchestrator") {
						const ts = now();
						for (const m of messages) {
							const rec = st.messages[m.id];
							if (!rec || rec.to !== "orchestrator" || rec.requiresAck !== false || rec.surfacedAt) continue;
							rec.surfacedAt = ts;
							rec.updatedAt = ts;
						}
					}
				}
				messages = messages.slice(-limit);
				await trace(p, "mailbox.poll", { agentId, count: messages.length, matchedCount, pendingOnly: Boolean(params.pendingOnly), markDelivered: Boolean(params.markDelivered) });
				// === Issue 25 Phase 2: gate-aware mailbox_surfaced lifecycle derivation (plan §2.10) ===
				// Under gate=0: shadow-only trace, NO durable state mutation (Phase 1 behavior preserved).
				// Under gate=1: AUTHORITATIVE — stamp seenAt + lifecycleStage + lifecycleSource inside
				// this same withLock(p) critical section via deriveLifecycleFromTrigger (pure helper,
				// reuses the no-change-if-already-set semantics). Pane injection alone does NOT set
				// seenAt — only the envelope returned from swarm_check_mailbox does (proposal §A + §B.1).
				// Runs INSIDE the existing withLock — no nested lock. Never applies to messages without
				// an existing record (legacy envelopes without st.messages[id] are silently skipped).
				// Persist via writeState at the end of the critical section so the durable stamp survives
				// a subsequent poll (no second writeState was previously committed, so the stamp was lost).
				const ts = now();
				let lifecycleDirty = false;
				for (const m of messages) {
					const rec = st.messages[m.id];
					if (!rec) continue;
					const d = deriveLifecycleFromTrigger(rec, { kind: "mailbox_surfaced" }, ts);
					if (d.kind !== "set") continue;
					if (PI_SWARM_MINIMAL_PROTOCOL === 1) {
						(rec as any)[d.field] = d.value;
						rec.lifecycleStage = d.stage;
						rec.lifecycleSource = d.source;
						await trace(p, TRACE_LIFECYCLE_DERIVED, {
							messageId: m.id,
							from: rec.from,
							to: rec.to,
							field: d.field,
							source: d.source,
							stage: d.stage,
							gate: 1,
							reason: d.reason,
							via: "swarm_check_mailbox",
						});
					} else {
						await trace(p, TRACE_LIFECYCLE_DERIVED_SHADOW, {
							messageId: m.id,
							from: rec.from,
							to: rec.to,
							field: d.field,
							source: d.source,
							stage: d.stage,
							shadow: true,
							gate: 0,
							reason: d.reason,
							via: "swarm_check_mailbox",
						});
					}
					lifecycleDirty = true;
				}
				if (lifecycleDirty || params.markDelivered) await writeState(p, st);
				return { agentId, mailbox: relative(ctx.cwd, mailboxPath(p, agentId)), matchedCount, returnedCount: messages.length, messages };
			});
			return textResult(JSON.stringify(result, null, 2), result);
		});
		},
	}))

	pi.registerTool(defineTool({
		name: "swarm_reconcile",
		label: "Swarm Reconcile",
		description: "Reconcile swarm mailbox state AND task graph state. Mailbox: inspects queued/failed/injected messages requiring ack, retries failed/queued injections when recipient tmux is running, marks expired or max-attempt messages dead_letter. Task sweep: re-reads every task.json, reports stored-vs-derived status drift and stale/nudge signals (dead assignee, dead-lettered assignment, in_progress too long, ack_missing), and stamps advisory node.staleAt. Mark-only by default; pass mark=true to also persist the recomputed task.status. Never auto-fails a node.",
		promptGuidelines: ["Use `swarm_reconcile` to recover stuck messages, retry failed deliveries, move expired/unrecoverable messages to dead_letter, and surface stale/stalled task nodes. Run with dryRun=true first to preview; use mark=true to repair task status drift."],
		parameters: Type.Object({
			agentId: Type.Optional(Type.String({ description: "Optional agent id to reconcile only that agent's messages. Task sweep is skipped when scoped to one agent." })),
			dryRun: Type.Optional(Type.Boolean({ description: "If true, inspect and report actions without modifying state. Defaults to false." })),
			mark: Type.Optional(Type.Boolean({ description: "Persist the recomputed task.status when stored/derived drift is detected (repairs closure). Still never auto-fails nodes. Defaults to false." })),
			scope: Type.Optional(Type.Union([Type.Literal("self"), Type.Literal("all")], { description: "Reconcile scope: 'self' restricts to the caller's mailbox; 'all' walks the whole swarm. Workers are forced to 'self'; orchestrator/admin may select either. Defaults to caller-tier (worker=self, orchestrator=all)." })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return wrapSwarmToolInvocation(pi, ctx.cwd, "swarm_reconcile", async () => {
				const p = paths(ctx.cwd);
				// === Issue 25 Phase 2: worker rate-limit + scope gate (proposal §K.1, plan §2.6(b) + §2.10) ===
				// Workers calling swarm_reconcile are forced to scope:"self" and rate-limited to
				// PI_SWARM_RECONCILE_DRYRUN_WORKER_RATE_MS between invocations (declared Phase 1, consumed
				// here in Phase 2). Orchestrator/admin are exempt. mark=true remains orchestrator-only
				// (existing authority check, unchanged). The rate-limit ledger is persisted on the
				// agent record (lastReconcileDryRunAt) under the same withLock — no nested lock.
				const me = currentAgentId();
				const isOrch = me === "orchestrator";
				const isAdmin = process.env.PI_SWARM_ADMIN_MODE === "1" || me === "admin";
				const isPrivileged = isOrch || isAdmin;
				const requestedScope = params.scope || (isPrivileged ? "all" : "self");
				if (!isPrivileged && requestedScope !== "self") {
					throw new Error(`${ERR_SCOPE_FORBIDDEN}: worker ${me} requested scope="${requestedScope}" but only "self" is permitted (proposal §K.1).`);
				}
				// Worker dry-run rate-limit (gated on dryRun != false AND caller is a non-privileged
				// worker). Stamps lastReconcileDryRunAt under the same withLock so the ledger is
				// atomic with the lock check. Workers without an agent record (e.g. pre-spawn
				// reconciliation, ad-hoc CLI use, fresh scratch dirs in tests) are exempt — the
				// ledger is only meaningful once an agent is persisted.
				if (!isPrivileged && params.dryRun !== false) {
					await withLock(p, async () => {
						const st = await readState(p, ctx.cwd);
						const a = st.agents[me];
						if (a) {
							const lastAt = a.lastReconcileDryRunAt ? new Date(a.lastReconcileDryRunAt).getTime() : 0;
							const nowMs = Date.now();
							if (lastAt > 0 && nowMs - lastAt < PI_SWARM_RECONCILE_DRYRUN_WORKER_RATE_MS) {
								const waitS = Math.ceil((PI_SWARM_RECONCILE_DRYRUN_WORKER_RATE_MS - (nowMs - lastAt)) / 1000);
								throw new Error(`${ERR_RECONCILE_RATE_LIMITED}: worker ${me} dry-run reconcile throttled; retry in ${waitS}s (proposal §K.1).`);
							}
							a.lastReconcileDryRunAt = new Date(nowMs).toISOString();
							a.updatedAt = a.lastReconcileDryRunAt;
							await writeState(p, st);
						}
					});
				}
				// mark=true persists task.status writes — an orchestrator-authoritative mutation gated
				// on leader heartbeat (plan §4.4.7). Advisory paths (mark=false/dryRun=true) stay ungated.
				if (params.mark) {
					await withLock(p, async () => {
						const st = await readState(p, ctx.cwd);
						heartbeatOrchestratorLeader(st, Date.now(), process.pid, "reconcile_mark");
						await writeState(p, st);
					});
				}
				const result = await reconcile(pi, ctx.cwd, p, { agentId: params.agentId, dryRun: params.dryRun, mark: params.mark });
				const summary = result.actions.map((a) => `  ${a.messageId}: ${a.action} (${a.reason})`).join("\n");
				return textResult(`Reconciled ${result.count} item(s): ${result.messageCount} message(s), ${result.taskCount} task(s) (${result.dryRun ? "dry run" : "applied"}).\n${summary}`, result);
			});
		},
	}))
}
