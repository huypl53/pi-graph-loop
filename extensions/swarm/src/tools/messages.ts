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
import { tmux } from "../tmux.ts";

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
			const p = paths(ctx.cwd);
			const { msg, delivery } = await enqueueAndDeliver(pi, ctx.cwd, p, params);
			const injected = Boolean(delivery?.delivered) && !delivery?.mailboxOnly;
			const mailboxOnly = Boolean(delivery?.mailboxOnly);
			return textResult(`Sent ${msg.id} to ${msg.to}. Injected: ${injected}${mailboxOnly ? " (mailbox-only delivery; recipient has no tmux pane)" : ""}`, { message: msg, delivery });
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
			const p = paths(ctx.cwd);
			const agentId = currentAgentId();
			const result = await withLock(p, async () => {
				const st = await readState(p, ctx.cwd);
				const rec = st.messages[params.messageId];
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
			const p = paths(ctx.cwd);
			const st = await readState(p, ctx.cwd);
			let records = Object.values(st.messages || {});
			if (params.messageId) records = records.filter((r) => r.id === params.messageId);
			if (params.agentId) records = records.filter((r) => r.to === safeId(params.agentId!));
			if (params.status) records = records.filter((r) => r.status === params.status);
			records = records.sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(-Math.max(1, Math.min(200, params.limit || 50)));
			return textResult(JSON.stringify({ count: records.length, records }, null, 2), { records });
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
					await writeState(p, st);
				}
				messages = messages.slice(-limit);
				await trace(p, "mailbox.poll", { agentId, count: messages.length, matchedCount, pendingOnly: Boolean(params.pendingOnly), markDelivered: Boolean(params.markDelivered) });
				return { agentId, mailbox: relative(ctx.cwd, mailboxPath(p, agentId)), matchedCount, returnedCount: messages.length, messages };
			});
			return textResult(JSON.stringify(result, null, 2), result);
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
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const p = paths(ctx.cwd);
			const result = await reconcile(pi, ctx.cwd, p, { agentId: params.agentId, dryRun: params.dryRun, mark: params.mark });
			const summary = result.actions.map((a) => `  ${a.messageId}: ${a.action} (${a.reason})`).join("\n");
			return textResult(`Reconciled ${result.count} item(s): ${result.messageCount} message(s), ${result.taskCount} task(s) (${result.dryRun ? "dry run" : "applied"}).\n${summary}`, result);
		},
	}))
}
