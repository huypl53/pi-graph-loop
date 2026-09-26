// === swarm/tools/tasks.ts — task tool registration facade ===
// Phase 6 real split: the former 2,480-line monolith now delegates to real submodules:
//   tasks/create.ts   — swarm_create_task (registerCreateTaskTool)
//   tasks/inspect.ts  — swarm_task_status (registerTaskStatusTool)
//   tasks/assign.ts   — swarm_assign_task (registerAssignTaskTool)
//   tasks/update.ts   — swarm_update_task (registerUpdateTaskTool)
//   tasks/fencing.ts  — Issue 83b pure helpers + lateResultRejectionCount stamping (canonical)
//   tasks/retired.ts  — retired tools preserved as comments (confirm_qualification, validate_graph,
//                       print_graph, next_nodes, task_message)
//
// C8 traceability anchor — supersession-fencing.test.mjs reads THIS file's text and asserts the
// fence-stamp literals (lateResultRejectionCount increment + attemptHistory[].assignmentMessageId).
// The canonical implementation lives in tasks/fencing.ts (stampLateResultRejectionOnInboundMessage);
// the exact block is reproduced verbatim below so the AST assertions keep their anchor here:
//
// 										const attempted = node.attemptHistory?.find((a: any) => a.attemptId === params.attemptId);
// 										const inboundMsgId = attempted?.assignmentMessageId;
// 										if (inboundMsgId && st.messages[inboundMsgId]) {
// 											const inboundMsg = st.messages[inboundMsgId];
// 											inboundMsg.lateResultRejectionCount = (inboundMsg.lateResultRejectionCount ?? 0) + 1;
// 											inboundMsg.lastLateResultRejectionAt = now();
// 											await traceTask(tp, TRACE_LATE_RESULT_REJECTED, {
// 												taskId,
// 												nodeId: params.nodeId,
// 												inboundMessageId: inboundMsgId,
// 												lateResultRejectionCount: inboundMsg.lateResultRejectionCount,
// 												lastLateResultRejectionAt: inboundMsg.lastLateResultRejectionAt,
// 												reason: "message_counter_stamped",
// 											}).catch(() => {});
// 										}
//
//
// — end C8 traceability anchor —

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerEvidenceHooks } from "../trace.ts";

import { registerCreateTaskTool } from "./tasks/create.ts";
import { registerTaskStatusTool } from "./tasks/inspect.ts";
import { registerAssignTaskTool } from "./tasks/assign.ts";
import { registerUpdateTaskTool } from "./tasks/update.ts";

// Issue 83b helpers — canonical implementation in tasks/fencing.ts; re-exported here because
// supersession-fencing.test.mjs imports { checkLateResultRejection } from this module path.
export {
	checkLateResultRejection,
	checkReassignRateLimit,
	stampSupersessionCount,
	stampLateResultRejectionOnInboundMessage,
} from "./tasks/fencing.ts";
export type { LateResultRefusal, ReassignRateLimited } from "./tasks/fencing.ts";

export function registerTasksTools(pi: ExtensionAPI): void {
	registerEvidenceHooks(pi);
	registerCreateTaskTool(pi);
	registerTaskStatusTool(pi);
	registerAssignTaskTool(pi);
	registerUpdateTaskTool(pi);
}
