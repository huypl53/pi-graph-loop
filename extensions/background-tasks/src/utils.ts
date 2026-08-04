// background-tasks/utils.ts — local copies of the swarm helpers (self-contained; design §8).
import { truncateHead, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { appendJsonl } from "./state.ts";

export function now(): string {
	return new Date().toISOString();
}

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export function safeId(input: string): string {
	const out = input
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return out || `bg-${randomUUID().slice(0, 8)}`;
}

export function genTaskId(label?: string): string {
	const base = label ? safeId(label) : "";
	return base || `bg-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`;
}

export function textResult(text: string, details: Record<string, unknown> = {}) {
	return { content: [{ type: "text" as const, text }], details };
}

export function truncate(text: string): string {
	const t = truncateHead(text, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
	if (!t.truncated) return text;
	return `${t.content}\n\n[truncated: ${t.outputLines}/${t.totalLines} lines (${formatSize(t.outputBytes)}/${formatSize(t.totalBytes)})]`;
}

export function humanAge(iso?: string | null): string {
	if (!iso) return "?";
	const ms = Date.now() - new Date(iso).getTime();
	if (!Number.isFinite(ms)) return "?";
	if (ms < 0) return "now";
	const s = Math.floor(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}h`;
	return `${Math.floor(h / 24)}d`;
}

// mm:ss elapsed since startedAt (for the TUI row).
export function elapsedMmSs(startedAt?: string | null): string {
	if (!startedAt) return "--:--";
	const ms = Date.now() - new Date(startedAt).getTime();
	if (!Number.isFinite(ms) || ms < 0) return "00:00";
	const total = Math.floor(ms / 1000);
	const m = Math.floor(total / 60);
	const s = total % 60;
	return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

// Wrap the trace append (events.jsonl) — same shape as swarm trace().
export async function trace(eventsFile: string, event: string, data: Record<string, unknown> = {}) {
	await appendJsonl(eventsFile, { ts: now(), event, ...data });
}

// Visible-string-width helper (best-effort, no unicode table dependency).
// Strips ANSI escapes then counts by codepoint; wide CJK counted as 2.
export function visibleWidth(str: string): number {
	const stripped = str.replace(/\x1b\[[0-9;]*m/g, "");
	let w = 0;
	for (const ch of stripped) {
		const code = ch.codePointAt(0) || 0;
		// Combine ranges treated as wide (CJK + fullwidth) — approximate but fine for truncation.
		if (
			(code >= 0x1100 && code <= 0x115f) ||
			(code >= 0x2e80 && code <= 0x303e) ||
			(code >= 0x3041 && code <= 0x33ff) ||
			(code >= 0x3400 && code <= 0x4dbf) ||
			(code >= 0x4e00 && code <= 0x9fff) ||
			(code >= 0xa000 && code <= 0xa4cf) ||
			(code >= 0xac00 && code <= 0xd7a3) ||
			(code >= 0xf900 && code <= 0xfaff) ||
			(code >= 0xfe30 && code <= 0xfe4f) ||
			(code >= 0xff00 && code <= 0xff60) ||
			(code >= 0xffe0 && code <= 0xffe6)
		) {
			w += 2;
		} else {
			w += 1;
		}
	}
	return w;
}

// Truncate a string to fit a visible column width, keeping a trailing ellipsis when cut.
export function truncateToWidth(str: string, width: number): string {
	if (width <= 1) return str.slice(0, width);
	const stripped = str.replace(/\x1b\[[0-9;]*m/g, "");
	if (visibleWidth(stripped) <= width) return str;
	// byte-ish slice; fine for the ASCII we render in rows.
	let out = "";
	let w = 0;
	for (const ch of stripped) {
		const cw = visibleWidth(ch);
		if (w + cw > width - 1) break;
		out += ch;
		w += cw;
	}
	return out + "…";
}
