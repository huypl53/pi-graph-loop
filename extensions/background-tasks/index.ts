// background-tasks/index.ts — packaged extension entry.
// Lets a pi agent run long-running shell commands in the background (detached, durable, observable),
// with a live user-facing TUI. Mirrors the swarm/compact-resume patterns. Design: docs/background-tasks-design.md.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerHooks } from "./src/hooks.ts";
import { registerTools } from "./src/tools/index.ts";
import { registerCommand } from "./src/command.ts";
import { readSettings } from "./src/settings.ts";

export { isAlive, reconcile } from "./src/lifecycle.ts";

export default function (pi: ExtensionAPI) {
	const settings = readSettings();
	if (!settings.enabled) return; // mirror compact-resume disable gate
	registerHooks(pi, settings);
	registerTools(pi, settings);
	registerCommand(pi, settings);
}
