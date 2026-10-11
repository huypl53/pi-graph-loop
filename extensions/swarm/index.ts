// swarm/index.ts — entry point. Helpers in ./src/, tools in ./src/tools/.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerSwarmHooks } from "./src/hooks.ts";
import { registerSwarmCommand } from "./src/command.ts";
import { registerAgentsTools } from "./src/tools/agents.ts";
import { registerMessagesTools } from "./src/tools/messages.ts";
import { registerTasksTools } from "./src/tools/tasks.ts";
import { registerAuditTools } from "./src/tools/audit.ts";
export { isDeliveryFailureRetryable } from "./src/delivery.ts";
export { providerForModel, currentProvider } from "./src/session.ts";
export { pickSlot, poolStatus, recordProviderError, recordSlotSuccess, setSlotCooldown, slotKey, effectiveConfig } from "./src/pool.ts";
export { isPiLikeCommand, isPanePiLike } from "./src/tmux.ts";
export { findIdempotentMessage, readMailbox, readMailboxCached } from "./src/mailbox.ts";
export {
	pickNextBusyAgent,
	maybeAutoFocusBusyAgent,
	maybeAutoFocusOnBusy,
	isAutoFocusEnabled,
	isCurrentActiveTmuxWindow,
	focusAgentWindow,
	AUTO_FOCUS_COOLDOWN_MS,
	getFocusStatus,
	formatFocusStatus,
} from "./src/focus.ts";

export default function (pi: ExtensionAPI) {
	// swarm-issues Phase 4: register the issue-skills directory via the real resources_discover
	// event so the swarm-issues skill is a genuinely loaded extension skill (not identity prose).
	// Module-relative path (NOT cwd) so registration works regardless of the project pi runs in.
	pi.on("resources_discover", async (_event, _ctx) => {
		return { skillPaths: [new URL("./issue-skills", import.meta.url).pathname] };
	});
	registerSwarmHooks(pi);
	registerAgentsTools(pi);
	registerMessagesTools(pi);
	registerTasksTools(pi);
	// swarm_gc tool surface retired from the default registration (2026-10 retired-surface
	// cleanup): the deleted file was ONLY the tool wrapper (registerGcTools) — no imports
	// remained (the stopped-gc lane was its sole external caller and now drives the shared
	// helpers directly). The shared GC/retention behavior is untouched and live:
	// src/gc.ts (pure pruneState), src/agent-gc.ts (stopped-purge predicates),
	// src/agent-gc-io.ts, the auto-GC config gate, and /swarm deregister --purge-stopped.
	registerAuditTools(pi);
	registerSwarmCommand(pi);
}
