// === swarm/tools/messages.ts — tool registrations (verbatim from index.ts) ===
import { Type } from "typebox";
import {
	defineTool,
	CONFIG_DIR_NAME,
	truncateHead,
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { join, dirname, relative, sep } from "node:path";
import type { MessageResponseStatus } from "../types.ts";
import { currentAgentId } from "../session.ts";
import { enqueueAndDeliver, readMailbox, validateResultMessage } from "../mailbox.ts";
import { mailboxPath, paths, readState, trace, withLock, writeState } from "../state.ts";
import { humanAge, now, safeId, textResult } from "../utils.ts";
import { pumpRootMailbox, reconcile } from "../reconcile.ts";
import { heartbeatRootLeader, requireRootAuthority } from "../identity.ts";
import { tmux } from "../tmux.ts";
import { wrapSwarmToolInvocation } from "./wrapper.ts";
import {
	ERR_RECONCILE_RATE_LIMITED,
	ERR_SCOPE_FORBIDDEN,
	FULL_BODY_MAX_CHARS,
	PI_SWARM_MESSAGE_BODY_MAX_BYTES,
	PI_SWARM_MINIMAL_PROTOCOL,
	PI_SWARM_RECONCILE_DRYRUN_WORKER_RATE_MS,
	TRACE_LIFECYCLE_DERIVED,
	TRACE_LIFECYCLE_DERIVED_SHADOW,
} from "../constants.ts";
import { deriveLifecycleFromTrigger } from "../mailbox.ts";
import { fingerprintMessage } from "../surface/pump-shared.ts";

// === tool-output-slim §1 helpers — check_mailbox scan/read split ==============================

// Read-only unread computation for the envelope. DOES NOT write any ledger.
//   worker: same st.delivered[agentId] ledger pendingOnly already uses.
//   root:   durable read markers — surfacedAt (informational), consumerReceipts entries
//           (actionable messages the pump surfaced; surfacedAt is deliberately NOT stamped
//           for those, see pump.ts), or ackedAt (legacy pre-minimal-protocol acks).
// NEVER reads or writes st.delivered.root; never touches rootPumpSessions (pump decoupling).
//
// unread-drain fix (2026-10-02): previously root unread keyed ONLY on !surfacedAt, but
// surfacedAt is stamped exclusively on the requiresAck:false path (both here in the
// markDelivered branch and in the root pump). Actionable messages (requiresAck:true —
// task-stall, graph-advance, goal-escalation nudges under the legacy flag) got a
// consumerReceipts entry instead, which this predicate never consulted, and
// swarm_ack_message is not registered, so unread stuck at >0 forever and the model
// re-polled + re-dumped full bodies (live evidence: same 5,841B result ≥5 times in one
// root session). Root read-ness now = surfacedAt OR consumerReceipt OR ackedAt.
function rootMessageIsRead(st: any, m: any): boolean {
	const rec = st?.messages?.[m.id];
	if (!rec || rec.to !== "root") return true; // no record / not root traffic → not unread debt
	if (rec.surfacedAt) return true;
	if (rec.ackedAt) return true;
	if (st.consumerReceipts?.root?.entries?.[m.id]) return true;
	return false;
}

function computeUnreadForTool(st: any, agentId: string, messages: Array<any>): number {
	if (agentId === "root") {
		return messages.filter((m) => !rootMessageIsRead(st, m)).length;
	}
	const delivered = new Set(st.delivered?.[agentId] || []);
	return messages.filter((m) => !delivered.has(m.id)).length;
}

// Compact scan row: keep id/from/subject/age/unread/requiresResponse/preview
// (+ conversationId/replyTo only when set). Drop transport fields from the model view.
function slimMailboxRow(m: any, st: any, agentId: string, previewLen: number): any {
	let unread: boolean;
	if (agentId === "root") {
		unread = !rootMessageIsRead(st, m);
	} else {
		const delivered = new Set(st?.delivered?.[agentId] || []);
		unread = !delivered.has(m.id);
	}
	const row: any = {
		id: m.id,
		from: m.from,
		subject: m.subject,
		age: humanAge(m.createdAt),
		unread,
		requiresResponse: Boolean(m.requiresResponse) === true ? true : undefined,
	};
	if (previewLen > 0) {
		const body = typeof m.body === "string" ? m.body : "";
		const needsTrunc = body.length > previewLen;
		row.preview = needsTrunc ? `${body.slice(0, previewLen)}\n…[+${body.length - previewLen} chars — fullBody:true]` : body;
	}
	if (m.conversationId) row.conversationId = m.conversationId;
	if (m.replyTo) row.replyTo = m.replyTo;
	if (row.requiresResponse === undefined) delete row.requiresResponse;
	return row;
}

// Full-body row: legacy envelope minus the transport fields that never belonged in the model view.
// Bodies are clamped to FULL_BODY_MAX_CHARS chars + an escape-hint suffix naming the durable
// mailbox JSONL path so a 200MB legacy/out-of-band line cannot blow the model context. The raw
// full body remains available via details.messages (programmatic/harness escape, never model context).
function fullMailboxRow(m: any, mailboxFile: string): any {
	const {
		swarmId: _s,
		to: _to,
		priority: _p,
		type: _t,
		schemaVersion: _sv,
		requiresAck: _ra,
		idempotencyKey: _ik,
		headers: _h,
		body,
		...rest
	} = m;
	const rawBody = typeof body === "string" ? body : "";
	if (rawBody.length > FULL_BODY_MAX_CHARS) {
		const truncated = rawBody.length - FULL_BODY_MAX_CHARS;
		rest.body = `${rawBody.slice(0, FULL_BODY_MAX_CHARS)}\n…[+${truncated} chars truncated — re-read with fullBody:true and a smaller limit to page through the rest]`;
	} else {
		rest.body = rawBody;
	}
	return rest;
}

// Serialize the lock result into the model-visible view. Default = compact scan;
// fullBody:true = complete bodies (clamped to FULL_BODY_MAX_CHARS + escape-hint naming mailboxFile).
// `details` keeps the raw full messages for programmatic use.
function serializeMailboxView(result: any, opts: { fullBody: boolean; previewLen: number; mailboxFile: string }) {
	const { agentId, unread, matchedCount, returnedCount, messages } = result;
	if (opts.fullBody) {
		const full: Record<string, unknown> = {
			agentId,
			unread,
			returned: returnedCount,
			messages: messages.map((m: any) => fullMailboxRow(m, opts.mailboxFile)),
		};
		if (matchedCount !== returnedCount) full.matched = matchedCount;
		return full;
	}
	const rows = messages.map((m: any) => slimMailboxRow(m, result.__st, agentId, opts.previewLen));
	const compact: Record<string, unknown> = { agentId, unread, returned: returnedCount, messages: rows };
	// matched only when pagination actually hid something (returned !== matched)
	if (matchedCount !== returnedCount) compact.matched = matchedCount;
	return compact;
}

export function registerMessagesTools(pi: ExtensionAPI) {
	pi.registerTool(
		defineTool({
			name: "swarm_send_message",
			label: "Swarm Send",
			description:
				"Send an inter-agent swarm message. The message is durably queued for the recipient and injected into the recipient tmux pane with PI-SWARM system headers when possible.",
			promptGuidelines: ["Use `swarm_send_message` for agent-to-agent coordination instead of asking the human to relay messages."],
			parameters: Type.Object({
				to: Type.String({ description: "Recipient agent id." }),
				body: Type.String({ description: "Message body." }),
				subject: Type.Optional(Type.String({ description: "Short subject." })),
				priority: Type.Optional(Type.String({ description: "low, normal, or high. Defaults to normal." })),
				conversationId: Type.Optional(Type.String({ description: "Optional conversation/thread id for related messages." })),
				replyTo: Type.Optional(Type.String({ description: "Optional message id this message replies to." })),
				requiresAck: Type.Optional(
					Type.Boolean({
						description:
							PI_SWARM_MINIMAL_PROTOCOL === 1
								? "Optional legacy flag. Under minimal protocol (default), acknowledgements are handled automatically. Defaults to false."
								: "Whether recipient should explicitly ack done/failed. Defaults to true.",
					}),
				),
				requiresResponse: Type.Optional(
					Type.Boolean({
						description:
							"Whether recipient must send a result/reply message before acking done and becoming reusable. Defaults to false for direct messages.",
					}),
				),
				ttlMs: Type.Optional(
					Type.Number({ description: "Optional time-to-live in milliseconds for future reconcile/dead-letter handling." }),
				),
				idempotencyKey: Type.Optional(
					Type.String({
						description:
							"Optional idempotency key to prevent duplicate messages. If a message with the same from+to+idempotencyKey exists, it is returned instead.",
					}),
				),
			}),
			async execute(_id, params, _signal, _onUpdate, ctx) {
				return wrapSwarmToolInvocation(pi, ctx.cwd, "swarm_send_message", async () => {
					// F4 — mailbox body clamp at the tool boundary (plan §5). Reject (throw, not
					// isError-return per pi-runtime-contract §9) BEFORE any mailbox append or state
					// write. The clamp lives at the tool boundary only — deliverMessageLocked stays
					// unclamped on purpose: engine-internal senders (nudges, escalations, hints) must
					// not fail closed at delivery; their content is engine-generated and bounded.
					const bodyBytes = Buffer.byteLength(params.body ?? "", "utf8");
					if (bodyBytes > PI_SWARM_MESSAGE_BODY_MAX_BYTES) {
						throw new Error(
							`MESSAGE_BODY_TOO_LARGE: body is ${formatSize(bodyBytes)} (cap ${formatSize(PI_SWARM_MESSAGE_BODY_MAX_BYTES)} — PI_SWARM_MESSAGE_BODY_MAX_BYTES). Trim the body or reference an artifact path instead.`,
						);
					}
					const p = paths(ctx.cwd);
					const { msg, delivery } = await enqueueAndDeliver(pi, ctx.cwd, p, params);
					const injected = Boolean(delivery?.delivered) && !delivery?.mailboxOnly;
					const mailboxOnly = Boolean(delivery?.mailboxOnly);
					const deliveryStatus = injected ? "delivered_to_pane" : "queued_in_mailbox";
					const mailboxPath = join(p.mailboxes, `${msg.to}.jsonl`);
					const receipt = {
						messageId: msg.id,
						to: msg.to,
						deliveryStatus,
						mailboxPath,
						requiresResponse: Boolean(params.requiresResponse),
					};
					return textResult(
						`Sent ${msg.id} to ${msg.to}.`,
						{ message: msg, delivery, receipt },
					);
				});
			},
		}),
	);

	// swarm_ack_message / swarm_message_status were retired from the live surface
	// (minimal protocol derives message lifecycle from replies + swarm_update_task).
	// Their former comment-preserved bodies were removed in the 2026-10 retired-surface cleanup.


	pi.registerTool(
		defineTool({
			name: "swarm_check_mailbox",
			label: "Swarm Mailbox",
			description:
			"Read pending or recent messages from a swarm agent's mailbox. Defaults to the current PI_SWARM_AGENT_ID. The default compact scan (id/from/subject/age/unread) is the correct poll shape; unread drains durably once messages are surfaced or marked delivered, so a repeated poll returning unread:0 needs no re-reading. Use bodyPreview to triage bodies; use fullBody only to read specific message(s) you have already selected from a scan (pass a small limit).",
			promptGuidelines: [
				"Use `swarm_check_mailbox` when you are a swarm agent and need to read messages sent by other agents. Poll with the default compact scan; do not re-read with fullBody when unread is 0.",
			],
			parameters: Type.Object({
				agentId: Type.Optional(Type.String({ description: "Agent id. Defaults to current PI_SWARM_AGENT_ID or root." })),
				limit: Type.Optional(Type.Number({ description: "Maximum messages to return. Defaults to 20." })),
				pendingOnly: Type.Optional(
					Type.Boolean({ description: "Only return messages not marked delivered in swarm state. Defaults to false." }),
				),
				markDelivered: Type.Optional(Type.Boolean({ description: "Mark returned messages as delivered/read. Defaults to false." })),
				fullBody: Type.Optional(
					Type.Boolean({
						description:
							"Return complete message bodies (legacy envelope minus transport fields). Defaults to false (compact scan rows; use bodyPreview to include previews).",
					}),
				),
				bodyPreview: Type.Optional(
					Type.Number({
						description:
							"Include body previews in scan rows, truncated to this many chars (clamped 50\u20132000). Omitted = headers-only scan. Truncated previews end with \u2026[+N chars \u2014 fullBody:true] so the model can discover the escape hatch.",
					}),
				),
			}),
			async execute(_id, params, _signal, _onUpdate, ctx) {
				return wrapSwarmToolInvocation(pi, ctx.cwd, "swarm_check_mailbox", async () => {
					const p = paths(ctx.cwd);
					const agentId = safeId(params.agentId || currentAgentId());
					const limit = Math.max(1, Math.min(100, params.limit || 20));
					// tool-output-slim §1: fullBody keeps the legacy envelope (minus transport fields);
					// the default scan is a headers-only compact view (id/from/subject/age/unread) so a
					// 20-message poll stays under the 2,000B context budget. bodyPreview (clamped
					// 50–2000) opts the scan rows into body previews; fullBody:true reads complete bodies.
					const fullBody = params.fullBody === true;
					const bodyPreviewGiven = typeof params.bodyPreview === "number";
					const previewLen = Math.max(50, Math.min(2000, Math.round(params.bodyPreview ?? 300)));
					const result = await withLock(p, async () => {
						const st = await readState(p, ctx.cwd);
						// DELIBERATELY DECOUPLED from the root auto-pump: check_mailbox keys "already read" on the
						// shared st.delivered[agentId] ledger, NOT on the pump's per-process surfaced set
						// (st.rootPumpSessions). Because pumpRootMailbox never reads
						// st.delivered.root, a check_mailbox(markDelivered:true) here does not affect
						// action-expected re-trigger logic. The ONE exception is explicit root reads of
						// informational messages (requiresAck:false): when the PM asks to mark those delivered here,
						// stamp surfacedAt so a later root session does not replay already-read history.
						const ledgerIds = st.delivered[agentId] || [];
						const deliveredIds = new Set(ledgerIds);
						let messages = await readMailbox(p, agentId);
						if (params.pendingOnly) messages = messages.filter((m) => !deliveredIds.has(m.id));
						const matchedCount = messages.length;
						if (params.markDelivered) {
							// Mark the whole matched set before applying the display limit so a small
							// limit does not leave older pending messages to be reprocessed forever.
							st.delivered[agentId] = Array.from(new Set([...ledgerIds, ...messages.map((m) => m.id)]));
							if (agentId === "root") {
								const ts = now();
								for (const m of messages) {
									const rec = st.messages[m.id];
									if (!rec || rec.to !== "root" || rec.surfacedAt) continue;
									// informational messages: legacy surfacedAt stamp (unchanged semantics)
									if (rec.requiresAck === false) {
										rec.surfacedAt = ts;
										rec.updatedAt = ts;
										continue;
									}
									// actionable messages (requiresAck !== false): unread-drain fix (2026-10-02) —
									// the read marker is a consumer receipt (mirrors what the pump writes when IT
									// surfaces actionable traffic). rec.ackedAt is left alone (ack is not our business
									// here); a pre-existing ackedAt already counts as read via rootMessageIsRead.
									if (!st.consumerReceipts) st.consumerReceipts = {};
									if (!st.consumerReceipts.root) st.consumerReceipts.root = { entries: {}, revision: 0 };
									if (!st.consumerReceipts.root.entries) st.consumerReceipts.root.entries = {};
									if (!st.consumerReceipts.root.entries[m.id]) {
										st.consumerReceipts.root.entries[m.id] = {
											surfacedAt: ts,
											ackedAt: rec.ackedAt,
											requiresAck: true,
											conversationId: rec.conversationId,
											fingerprint: fingerprintMessage(rec),
										};
										st.consumerReceipts.root.revision = (st.consumerReceipts.root.revision || 0) + 1;
										}
								}
							}
						}
						messages = messages.slice(-limit);
						await trace(p, "mailbox.poll", {
							agentId,
							count: messages.length,
							matchedCount,
							pendingOnly: Boolean(params.pendingOnly),
							markDelivered: Boolean(params.markDelivered),
						});
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
						return {
							agentId,
							unread: computeUnreadForTool(st, agentId, messages),
							matchedCount,
							returnedCount: messages.length,
							messages,
							__st: st,
						};
					});
					// tool-output-slim §1: serialization happens AFTER the withLock returns — the lock
					// block above is untouched except for the read-only unread computation inside the
					// returned envelope. Default scan: compact rows, no pretty-print, no raw bodies.
					const compact = serializeMailboxView(result, {
						fullBody,
						previewLen: bodyPreviewGiven ? previewLen : 0,
						mailboxFile: join(p.mailboxes, `${agentId}.jsonl`),
					});
					return textResult(JSON.stringify(compact), { ...compact, messages: result.messages });
				});
			},
		}),
	);

	pi.registerTool(
		defineTool({
			name: "swarm_reconcile",
			label: "Swarm Reconcile",
			description:
				"Reconcile swarm mailbox state AND task graph state. Mailbox: inspects queued/failed/injected messages requiring ack, retries failed/queued injections when recipient tmux is running, marks expired or max-attempt messages dead_letter. Task sweep: re-reads every task graph, reports stored-vs-derived status drift and stale/nudge signals (dead assignee, dead-lettered assignment, in_progress too long, ack_missing), and stamps advisory node.staleAt. Use offset to skip reconciliation actions already returned by an earlier call. Mark-only by default; pass mark=true to also persist the recomputed task.status. Never auto-fails a node.",
			promptGuidelines: [
				"Use `swarm_reconcile` to recover stuck messages, retry failed deliveries, move expired/unrecoverable messages to dead_letter, and surface stale/stalled task nodes. Run with dryRun=true first to preview; reuse the returned nextOffset as offset to skip already-seen actions; use mark=true to repair task status drift.",
			],
			parameters: Type.Object({
				agentId: Type.Optional(
					Type.String({
						description:
							"Optional agent id to reconcile only that agent's messages. Task sweep is skipped when scoped to one agent.",
					}),
				),
				dryRun: Type.Optional(
					Type.Boolean({ description: "If true, inspect and report actions without modifying state. Defaults to false." }),
				),
				mark: Type.Optional(
					Type.Boolean({
						description:
							"Persist the recomputed task.status when stored/derived drift is detected (repairs closure). Still never auto-fails nodes. Defaults to false.",
					}),
				),
				scope: Type.Optional(
					Type.Union([Type.Literal("self"), Type.Literal("all")], {
						description:
							"Reconcile scope: 'self' restricts to the caller's mailbox; 'all' walks the whole swarm. Workers are forced to 'self'; root/admin may select either. Defaults to caller-tier (worker=self, root=all).",
					}),
				),
				offset: Type.Optional(
					Type.Number({
						minimum: 0,
						description:
							"Zero-based action offset. Skips this many actions from the current deterministic reconcile result; pass the prior result's nextOffset to avoid returning old actions again. Defaults to 0.",
					}),
				),
			}),
			async execute(_id, params, _signal, _onUpdate, ctx) {
				return wrapSwarmToolInvocation(pi, ctx.cwd, "swarm_reconcile", async () => {
					const p = paths(ctx.cwd);
					// === Issue 25 Phase 2: worker rate-limit + scope gate (proposal §K.1, plan §2.6(b) + §2.10) ===
					// Workers calling swarm_reconcile are forced to scope:"self" and rate-limited to
					// PI_SWARM_RECONCILE_DRYRUN_WORKER_RATE_MS between invocations (declared Phase 1, consumed
					// here in Phase 2). Root/admin are exempt. mark=true remains root-only
					// (existing authority check, unchanged). The rate-limit ledger is persisted on the
					// agent record (lastReconcileDryRunAt) under the same withLock — no nested lock.
					const me = currentAgentId();
					const isOrch = me === "root";
					const isAdmin = process.env.PI_SWARM_ADMIN_MODE === "1";
					const isPrivileged = isOrch || isAdmin;
					const requestedScope = params.scope || (isPrivileged ? "all" : "self");
					if (!isPrivileged && requestedScope !== "self") {
						throw new Error(
							`${ERR_SCOPE_FORBIDDEN}: worker ${me} requested scope="${requestedScope}" but only "self" is permitted (proposal §K.1).`,
						);
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
									throw new Error(
										`${ERR_RECONCILE_RATE_LIMITED}: worker ${me} dry-run reconcile throttled; retry in ${waitS}s (proposal §K.1).`,
									);
								}
								a.lastReconcileDryRunAt = new Date(nowMs).toISOString();
								a.updatedAt = a.lastReconcileDryRunAt;
								await writeState(p, st);
							}
						});
					}
					// mark=true persists task.status writes — an root-authoritative mutation gated
					// on leader heartbeat (plan §4.4.7). Advisory paths (mark=false/dryRun=true) stay ungated.
					if (params.mark) {
						await withLock(p, async () => {
							const st = await readState(p, ctx.cwd);
							heartbeatRootLeader(st, Date.now(), process.pid, "reconcile_mark");
							await writeState(p, st);
						});
					}
					const result = await reconcile(pi, ctx.cwd, p, {
						agentId: params.agentId,
						dryRun: params.dryRun,
						mark: params.mark,
						offset: params.offset,
					});
					const summary = result.actions.map((a) => `  ${a.messageId}: ${a.action} (${a.reason})`).join("\n");
					const page =
						result.offset > 0 || result.count !== result.totalCount
							? `Reconciled ${result.count} of ${result.totalCount} item(s) from offset ${result.offset}: ${result.messageCount} message(s), ${result.taskCount} task(s)`
							: `Reconciled ${result.count} item(s): ${result.messageCount} message(s), ${result.taskCount} task(s)`;
					return textResult(
						`${page} (${result.dryRun ? "dry run" : "applied"}). Next offset: ${result.nextOffset}.\n${summary}`,
						result,
					);
				});
			},
		}),
	);
}
