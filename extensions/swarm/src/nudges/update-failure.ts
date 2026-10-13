// === swarm/nudges/update-failure.ts — class-based update-failure signals (Stage B) ===
//
// Plan: docs/swarm/plans/2026-10-13-worker-task-closure-gaps.md §1.2. Incident
// (worker p9-prompt-assembly-fix, 2026-10-13): the worker called swarm_update_task ONCE with
// closure intent, failed, and went idle — a pure streak-3 gate never fires in exactly that
// scenario. Failures are therefore CLASSIFIED:
//   closure — the call carried terminal intent (status done/failed/blocked/cancelled or
//             cancelTask): the worker believes the work is FINISHED; a failed attempt leaves a
//             dangling done-in-head worker. → IMMEDIATE self-nudge + root notice.
//   orphan  — TASK_NOT_FOUND with an empty myActiveTaskIds: no net exists for this worker
//             (settle-notify keys on activeTaskIds; artifact-progress on assigned nodes).
//             → IMMEDIATE self-nudge + root notice.
//   work    — everything else (mid-work transition/outcome/ownership errors): the model is
//             still in-turn, reads the structured Stage A error text, may self-correct.
//             → streak-gated: self-nudge at 3, root escalation at 6.
//
// Called from tools/tasks/update.ts inside the EXISTING swarm lock (the recording must never
// acquire its own lock). Root failures are never recorded (root failures are root-visible by
// construction). Emission failures go to logSwarmError and never fail the tool result
// (no-silent-swallow mandate: they land in .pi/swarm/traces/errors.jsonl).
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Paths, SwarmState } from "../types.ts";
import { deliverMessageLocked } from "../mailbox.ts";
import {
	formatNotifyKey,
	NOTIFY_KEY_UPDATE_FAILURE_SELF,
	NOTIFY_KEY_UPDATE_FAILURE_ROOT,
	UPDATE_FAILURE_ROOT_COOLDOWN_MS,
	UPDATE_FAILURE_ROOT_NOTICE_CAP,
} from "../constants.ts";
import { logSwarmError } from "../errorlog.ts";
import { now } from "../utils.ts";

export type UpdateFailureClass = "closure" | "orphan" | "work";

const TERMINAL_INTENT_STATUSES = new Set(["done", "failed", "blocked", "cancelled"]);

// Pure classification (plan §1.2). params is the raw swarm_update_task params object;
// myActiveTaskIds is the CALLER's activeTaskIds snapshot taken before any mutation.
// Prioritize orphan classification: TASK_NOT_FOUND with empty myActiveTaskIds means no net
// is tracking the worker regardless of whether the call carried terminal intent.
export function classifyUpdateFailure(params: any, errorCode: string | undefined, myActiveTaskIds: string[]): UpdateFailureClass {
	if (errorCode === "TASK_NOT_FOUND" && myActiveTaskIds.length === 0) return "orphan";
	if (params?.cancelTask === true || TERMINAL_INTENT_STATUSES.has(String(params?.status ?? ""))) return "closure";
	return "work";
}

type RecordArgs = {
	pi: ExtensionAPI;
	cwd: string;
	p: Paths;
	st: SwarmState;
	agentId: string;
	ok: boolean;
	errorCode?: string;
	classification?: UpdateFailureClass;
	taskId?: string;
	nodeId?: string;
};

// Record one swarm_update_task outcome for a NON-ROOT caller and emit the class-based
// notifications. Caller MUST hold the swarm lock (mutates st in place; the surrounding
// wrapper's writeState persists). Root calls are ignored entirely.
export async function recordUpdateOutcomeLocked(args: RecordArgs): Promise<void> {
	const { pi, cwd, p, st, agentId, ok } = args;
	if (agentId === "root") return;
	const agent = st.agents?.[agentId];
	if (!agent) return;
	const ts = now();
	if (ok) {
		agent.updateFailureStreak = 0;
		delete agent.lastUpdateFailureAt;
		delete agent.lastUpdateFailureCode;
		delete agent.lastUpdateFailureClass;
		agent.updatedAt = ts;
		return;
	}
	const classification = args.classification ?? "work";
	const code = args.errorCode ?? "UNKNOWN";
	agent.updateFailureStreak = (agent.updateFailureStreak ?? 0) + 1;
	agent.lastUpdateFailureAt = ts;
	agent.lastUpdateFailureCode = code;
	agent.lastUpdateFailureClass = classification;
	agent.updatedAt = ts;

	const selfKey = NOTIFY_KEY_UPDATE_FAILURE_SELF;
	const rootKey = NOTIFY_KEY_UPDATE_FAILURE_ROOT;
	const streak = agent.updateFailureStreak;

	const immediate = classification === "closure" || classification === "orphan";
	const workSelf = classification === "work" && streak === 3;
	const workRoot = classification === "work" && streak === 6;
	if (!immediate && !workSelf && !workRoot) return;

	const hintLine =
		code === "TASK_NOT_FOUND"
			? `No task graph is tracking your work (your activeTaskIds is empty). If the work is done or blocked, report it with swarm_send_message(to="root") — swarm_update_task is not required without an assigned node.`
			: `Fix the call using the errorCode guidance in the failed tool result${args.taskId ? ` (task ${args.taskId}${args.nodeId ? `, node ${args.nodeId}` : ""})` : ""}.`;

	const selfBody =
		`Your swarm_update_task call failed (${classification}-intent class, streak ${streak}, errorCode ${code}).\n\n` +
		`${hintLine}\n\n` +
		`If you cannot fix the call, report status to root via swarm_send_message — do not silently go idle believing the node is recorded.`;

	const taskIdPart = safeKeyPart(args.taskId) ?? "notask";
	const nodeIdPart = safeKeyPart(args.nodeId) ?? "nonode";

	// Immediate classes: notify on EVERY failure, but both channels are idempotency-deduped per
	// (agent, task, node, class) inside deliverMessageLocked, and the root channel is additionally
	// cooldown+cap-gated here so a retry storm cannot flood the root mailbox.
	if (immediate || workSelf) {
		try {
			await deliverMessageLocked(pi, cwd, p, st, {
				to: agentId,
				subject: `[Swarm] swarm_update_task failed (${classification}, ${code})`,
				body: selfBody,
				requiresAck: false,
				requiresResponse: false,
				priority: "high",
				idempotencyKey: formatNotifyKey(selfKey, {
					agentId,
					taskId: taskIdPart,
					nodeId: nodeIdPart,
					classification: safeKeyPart(classification),
				}),
			});
		} catch (err) {
			await logSwarmError(p, "update-failure", "self_nudge_failed", err, { agentId, classification, code, streak });
		}
	}
	if (immediate || workRoot) {
		// Root-notice cooldown + cap ledger (per agent): immediate classes fire on first failure
		// but repeats within UPDATE_FAILURE_ROOT_COOLDOWN_MS are suppressed; after
		// UPDATE_FAILURE_ROOT_NOTICE_CAP notices the root is left alone (it already has the
		// escalation; reconcile re-injects undelivered rows).
		const nowMs = Date.now();
		const lastRootAt = agent.lastUpdateFailureRootNoticeAt ? Date.parse(agent.lastUpdateFailureRootNoticeAt) : NaN;
		if (Number.isFinite(lastRootAt) && nowMs - lastRootAt < UPDATE_FAILURE_ROOT_COOLDOWN_MS) return;
		const rootNotices = agent.updateFailureRootNoticeCount ?? 0;
		if (rootNotices >= UPDATE_FAILURE_ROOT_NOTICE_CAP) return;
		agent.lastUpdateFailureRootNoticeAt = new Date(nowMs).toISOString();
		agent.updateFailureRootNoticeCount = rootNotices + 1;
		try {
			await deliverMessageLocked(pi, cwd, p, st, {
				to: "root",
				subject: `agent ${agentId} failed swarm_update_task (${classification}, ${code}, streak ${streak})`,
				body:
					`Agent ${agentId} failed swarm_update_task: class=${classification}, errorCode=${code}, streak=${streak}` +
					`${args.taskId ? `, task=${args.taskId}` : ""}${args.nodeId ? `, node=${args.nodeId}` : ""}.\n\n` +
					`Options: inspect the agent (swarm_agent_status), reassign the node (swarm_assign_task force=true), or force-close/waive the record (swarm_update_task force=true as root). The worker was self-nudged to report via swarm_send_message; this notice is the durable backstop if it cannot.`,
				requiresAck: false,
				requiresResponse: false,
				idempotencyKey: formatNotifyKey(rootKey, {
					agentId,
					taskId: taskIdPart,
					nodeId: nodeIdPart,
					classification: safeKeyPart(classification),
				}),
			});
		} catch (err) {
			await logSwarmError(p, "update-failure", "root_notice_failed", err, { agentId, classification, code, streak });
		}
	}
}

// Notify-key params must satisfy SAFE_ID_RE; task/node ids are caller-supplied strings that may
// be arbitrary (the failing call itself may have an invalid id) — compact them to a safe form.
function safeKeyPart(v: string | undefined | null): string | undefined {
	if (!v) return undefined;
	const compact = String(v)
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40);
	return compact || undefined;
}
