// swarm/index.ts — entry point. Helpers in ./src/, tools in ./src/tools/.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerSwarmHooks } from "./src/hooks.ts";
import { registerSwarmCommand } from "./src/command.ts";
import { registerAgentsTools } from "./src/tools/agents.ts";
import { registerMessagesTools } from "./src/tools/messages.ts";
import { registerTasksTools } from "./src/tools/tasks.ts";
import { registerMetricsTools } from "./src/tools/metrics.ts";
import { registerLoopTools } from "./src/tools/loop.ts";
import { registerGcTools } from "./src/tools/gc.ts";
export { isDeliveryFailureRetryable } from "./src/delivery.ts";
export { providerForModel, currentProvider } from "./src/session.ts";
export { pickSlot, poolStatus, recordSlotFailure, recordSlotSuccess, setSlotCooldown, slotKey, effectiveConfig } from "./src/pool.ts";
export { isPiLikeCommand, isPanePiLike } from "./src/tmux.ts";
export { findIdempotentMessage, readMailbox, readMailboxCached } from "./src/mailbox.ts";
export { validateRunAgainstContract, computeIterationBest } from "./src/metric.ts";

export default function (pi: ExtensionAPI) {
	registerSwarmHooks(pi);
	registerAgentsTools(pi);
	registerMessagesTools(pi);
	registerTasksTools(pi);
	registerMetricsTools(pi);
	registerLoopTools(pi);
	registerGcTools(pi);
	registerSwarmCommand(pi);
}
