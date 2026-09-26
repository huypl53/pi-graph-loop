import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { deliverMessageLocked, findIdempotentMessage } from "../mailbox.ts";
import { listTasksIndexed, renderTasksIndexedList, resolveTaskArg } from "../reconcile.ts";
import { currentAgentId } from "../session.ts";
import { readState, readTaskState, taskPaths, trace, traceTask, withLock, writeState, writeTaskState } from "../state.ts";
import { checkStallNotificationStale, deriveNodeAttention } from "../taskgraph.ts";
import type { Paths } from "../types.ts";
import { safeId } from "../utils.ts";

export async function handleAttentionCommand(
	cmd: "attention" | "remind",
	rest: string[],
	ctx: any,
	p: Paths,
	pi: ExtensionAPI,
): Promise<void> {
	if (cmd === "attention") {
		if (currentAgentId() !== "root") {
			ctx.ui.notify("attention is root-only: run it in the PM session (PI_SWARM_IS_ROOT=1 or /swarm register here root)", "warning");
			return;
		}
		const arg = rest.shift();
		const list = await listTasksIndexed(p);
		const targets = arg ? await resolveTaskArg(p, arg) : { list };
		if (arg && !targets.hit) {
			const hint = targets.ambiguous
				? `Ambiguous "${arg}" matches: ${targets.ambiguous.join(", ")}`
				: targets.missReason || "task not found";
			ctx.ui.notify(`${hint}\n\n${renderTasksIndexedList(list)}`, "warning");
			return;
		}
		const scope = targets.hit ? [{ task: targets.hit.task, tp: targets.hit.tp }] : list.map((t) => ({ task: t.task, tp: t.tp }));
		const st = await readState(p, ctx.cwd);
		const nowMs = Date.now();
		const lines: string[] = [
			arg ? `Attention report — task ${targets.hit!.task.taskId}` : `Attention report — ${scope.length} task(s)`,
		];
		let actionable = 0,
			reminders = 0,
			escalations = 0;
		for (const { task, tp: _tp } of scope) {
			const nodeLines: string[] = [];
			for (const [nodeId, node] of Object.entries(task.nodes)) {
				const att = deriveNodeAttention(st, task, nodeId, nowMs);
				if (att.category === "none" || att.category === "terminal") continue;
				if (att.workerReminderEligible) reminders++;
				if (att.rootDecision) escalations++;
				actionable++;
				nodeLines.push(
					`  ${nodeId} (${node.status}, assignee ${node.assignee || "-"}) → ${att.category}${att.workerReminderEligible ? ` — /swarm remind ${task.taskId} ${nodeId}` : ""}`,
				);
				for (const e of att.evidence) nodeLines.push(`      • ${e}`);
			}
			if (nodeLines.length) lines.push(``, `${task.taskId} (${task.status}):`, ...nodeLines);
		}
		lines.push(
			"",
			`Summary: ${actionable} node signal(s); reminder-eligible: ${reminders}; root decisions: ${escalations}. Advisory only — nothing is auto-reassigned, cancelled, or completed.`,
		);
		await trace(p, "swarm.attention", { by: currentAgentId(), tasks: scope.length, actionable, reminders, escalations });
		ctx.ui.notify(lines.join("\n"), "info");
		return;
	}

	if (cmd === "remind") {
		if (currentAgentId() !== "root") {
			ctx.ui.notify("remind is root-only: run it in the PM session (PI_SWARM_IS_ROOT=1 or /swarm register here root)", "warning");
			return;
		}
		const taskIdRaw = rest.shift();
		const nodeId = rest.shift();
		if (!taskIdRaw || !nodeId) {
			ctx.ui.notify("Usage: /swarm remind <task-id> <node-id> (root-only; see /swarm attention for eligibility)", "warning");
			return;
		}
		const taskId = safeId(taskIdRaw);
		const tp = taskPaths(p, taskId);
		if (!existsSync(tp.taskJson)) {
			ctx.ui.notify(`No task ${taskId}`, "warning");
			return;
		}
		const outcome = await withLock(p, async () => {
			const st = await readState(p, ctx.cwd);
			const nowMs = Date.now();
			const task = await readTaskState(tp.taskJson);
			const node = task.nodes[nodeId];
			if (!node) return { sent: false, reason: `node ${nodeId} does not exist in ${taskId}` };
			const att = deriveNodeAttention(st, task, nodeId, nowMs);
			if (att.category !== "reminder_eligible" || !att.workerReminderEligible) {
				return { sent: false, reason: `not eligible: ${att.category} — ${att.evidence.join("; ")}` };
			}
			const currentMsg = st.messages[node.assignmentMessageId!];
			if (!currentMsg || !(currentMsg.lastAck?.status === "seen" || currentMsg.lastAck?.status === "processing")) {
				return {
					sent: false,
					reason: `not eligible: receipt not confirmed on current assignment ${node.assignmentMessageId} (lastAck ${currentMsg?.lastAck?.status || "none"})`,
				};
			}
			const attemptId = node.activeAttemptId as string;
			const attempt = (node.attemptHistory || []).find((a: any) => a.attemptId === attemptId);
			if (!attempt || attempt.status !== "active") {
				return { sent: false, reason: `not eligible: attempt ${attemptId} is ${attempt?.status || "missing"}` };
			}
			const assignee = node.assignee || attempt.assignee;
			if (!assignee) return { sent: false, reason: `not eligible: node ${nodeId} has no assignee` };
			const msg = st.messages[node.assignmentMessageId!];
			const anchorMs = Math.max(
				msg?.lastAck?.at ? new Date(msg.lastAck.at).getTime() : 0,
				node.lastActivityAt ? new Date(node.lastActivityAt).getTime() : 0,
				attempt.lastActivityAt ? new Date(attempt.lastActivityAt).getTime() : 0,
				new Date(attempt.assignedAt).getTime(),
			);
			const key = `task:${taskId}:node:${nodeId}:attempt:${attemptId}:reminder`;
			const existing = findIdempotentMessage(st, "root", assignee, key);
			if (existing || attempt.reminder) {
				const reminderId = attempt.reminder?.reminderId || existing?.id || "unknown";
				let repaired = false;
				if (!attempt.reminder && existing) {
					attempt.reminder = {
						reminderId,
						sentAt: existing.createdAt,
						messageId: existing.id,
						attemptId,
						noProgressSince: new Date(anchorMs).toISOString(),
					};
					repaired = true;
					await writeTaskState(tp, task);
				}
				return {
					sent: false,
					reason: `already sent for attempt ${attemptId} (reminder message ${attempt.reminder?.messageId || existing?.id})`,
					repaired,
				};
			}
			const remindStaleCheck = checkStallNotificationStale(st, task, nodeId, assignee, Date.now());
			if (remindStaleCheck.stale) {
				await traceTask(tp, "notification.stale.suppressed", {
					site: "swarm_remind.reminder",
					taskId,
					nodeId,
					to: assignee,
					reason: remindStaleCheck.reason,
					evidence: remindStaleCheck.evidence,
				});
				return { sent: false, reason: `stale: ${remindStaleCheck.reason} (${remindStaleCheck.evidence.join("; ")})` };
			}
			const { msg: rmsg, delivery } = await deliverMessageLocked(pi, ctx.cwd, p, st, {
				to: assignee,
				subject: `Reminder: node ${nodeId} of ${taskId} awaiting progress`,
				body: `You acknowledged the assignment for task ${taskId}, node ${nodeId} (${node.role}), but there has been no durable progress since ${new Date(anchorMs).toISOString()} (${Math.round((nowMs - anchorMs) / 60000)} minutes).\n\nRequired actions (choose one):\n1. If complete: swarm_update_task(taskId="${taskId}", nodeId="${nodeId}", status="done", outcome="<result>")\n2. If blocked: swarm_update_task(taskId="${taskId}", nodeId="${nodeId}", status="blocked", note="<reason>")\n3. If still working: continue, and update the node when finished.\n\nThis reminder is informational; it does not change your task status, assignment, or create any reply obligation. At most one reminder is sent per attempt.`,
				replyTo: currentMsg.id,
				conversationId: currentMsg.conversationId,
				requiresAck: false,
				requiresResponse: false,
				priority: "normal",
				idempotencyKey: key,
			});
			const taskNow = await readTaskState(tp.taskJson);
			const attemptNow = (taskNow.nodes[nodeId].attemptHistory || []).find((a: any) => a.attemptId === attemptId);
			if (attemptNow && !attemptNow.reminder) {
				attemptNow.reminder = {
					reminderId: rmsg.id,
					sentAt: rmsg.createdAt,
					messageId: rmsg.id,
					attemptId,
					noProgressSince: new Date(anchorMs).toISOString(),
				};
				await writeTaskState(tp, taskNow);
			}
			await writeState(p, st);
			await traceTask(tp, "reminder.sent", {
				taskId,
				nodeId,
				attemptId,
				messageId: rmsg.id,
				assignee,
				anchor: new Date(anchorMs).toISOString(),
				injected: Boolean(delivery?.delivered),
			});
			return {
				sent: true,
				messageId: rmsg.id,
				attemptId,
				assignee,
				injected: Boolean(delivery?.delivered) || delivery?.reused === true,
				reason: delivery?.reason,
			};
		});
		if (outcome.sent) {
			ctx.ui.notify(
				`Reminder sent: message ${outcome.messageId} → ${outcome.assignee} (attempt ${outcome.attemptId}; injected=${outcome.injected}). Informational only; one per attempt, ever.`,
				"info",
			);
		} else {
			ctx.ui.notify(
				`Reminder NOT sent: ${outcome.reason}${outcome.repaired ? " (crash-repaired the attempt reminder record)" : ""}`,
				"warning",
			);
		}
	}
}
