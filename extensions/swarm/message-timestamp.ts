/**
 * message-timestamp — Show the time at the beginning of every pi agent message.
 *
 * What it does:
 *   Renders a small, dim timestamp line at the start of each agent (assistant)
 *   message in the TUI, e.g.:
 *
 *       say hi                 ← user message
 *       14:23:05               ← timestamp (this extension)
 *       Hi! 👋                ← agent reply
 *
 * How it works:
 *   - We listen to `message_start` and, when a new ASSISTANT message begins,
 *     append a custom timestamp entry. It lands right at the start of that
 *     agent message (after the user message / tool results, before the reply).
 *   - Custom entries are TUI-only, so the timestamp is purely visual and never
 *     sent to the LLM (no context noise).
 *
 * Why `message_start` (assistant) and not `turn_start`?
 *   `turn_start` fires before the user message is committed to the session log,
 *   so an entry appended there renders ABOVE the user message. `message_start`
 *   for the assistant role fires as the agent reply itself begins, so the entry
 *   sits at the very top of the agent message — which is what we want.
 *
 * Why not prepend to the message content (e.g. via `message_end`)?
 *   That would put the timestamp inside the assistant message body, which then
 *   gets fed back to the model on later turns — polluting the LLM context.
 *   Using a TUI-only entry keeps the model transcript clean.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

const ENTRY_TYPE = "message-timestamp";

interface TimestampEntryData {
	timestamp: number;
}

/** Format an epoch-ms timestamp as HH:MM:SS (24h, locale time zone). */
function formatTime(ts: number): string {
	const d = new Date(ts);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export default function (pi: ExtensionAPI) {
	// Render the timestamp as a single dim line.
	pi.registerEntryRenderer<TimestampEntryData>(
		ENTRY_TYPE,
		(entry, _options, theme) => {
			const time = formatTime(entry.data.timestamp);
			return new Text(theme.fg("dim", time), 1, 0);
		},
	);

	// A new assistant message is starting — stamp it. Using the message's own
	// timestamp keeps the displayed time consistent with pi's internal record.
	pi.on("message_start", (event) => {
		if (event.message.role !== "assistant") return;
		pi.appendEntry<TimestampEntryData>(ENTRY_TYPE, {
			timestamp: event.message.timestamp ?? Date.now(),
		});
	});
}
