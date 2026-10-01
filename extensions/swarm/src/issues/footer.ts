// === swarm/issues/footer.ts — advisory issue-run line in the Pi footer (L3 visible surface) ===
//
// Pi runtime contract: footer rendering is L3 (visible surface, NON-authoritative) per
// docs/swarm/pi-runtime-contract.md §1 — ctx.ui.setStatus is evidenced (§7/§8). An L3 write
// makes NO delivery or freshness claim; the durable SwarmState.issueRun (L1) is the only
// source of truth. The renderer is a PURE function over getIssueRun(st) output — it NEVER
// infers issue/task status from agent activity. Bounded (60-char cap), content-free (issueId
// + counts + mode/status only — never snapshot hashes, titles, or issue bodies), and
// malformed-safe (optional-chaining + guarded caller; failures route to logSwarmError —
// never thrown into the pump/command path).
import type { Paths } from "../types.ts";
import { logSwarmError, expected } from "../errorlog.ts";

const FOOTER_KEY = "swarm-issues";
const MAX_LEN = 80;

/** Terminal-unsuccessful queue statuses that justify the paused wording. */
const BLOCKED_STATUSES = ["cancelled", "blocked", "failed"];

function truncate(line: string): string {
	if (line.length <= MAX_LEN) return line;
	return line.slice(0, MAX_LEN - 1) + "…";
}

/**
 * Render the advisory footer line from durable issue-run state, or undefined when the slot
 * must be cleared (no run, inert run). Pure: no I/O, no agent-activity reads, never throws
 * on malformed input (optional-chaining degrades to undefined / best-effort fields).
 */
export function renderIssueFooterLine(run: any): string | undefined {
	if (!run || typeof run !== "object") return undefined;
	const status = run.status;
	if (status !== "running" && status !== "paused") return undefined; // complete/stopped/inactive → clear
	const queue: any[] = Array.isArray(run.queue) ? run.queue : [];
	const total = queue.length;
	if (total === 0) return undefined; // no queue → no line (never fabricate one)
	const done = queue.filter((e) => e && (e.status === "done" || e.status === "cancelled" || e.status === "blocked" || e.status === "failed")).length;
	const parts: string[] = [];
	// advisory issue id: the active issue, else the first terminal-unsuccessful entry (the
	// thing the run is resting on), else the last done entry — never a fabricated id.
	const active = queue.find((e) => e && e.status === "active");
	const blocked = queue.find((e) => e && BLOCKED_STATUSES.includes(e.status));
	const focus = active ?? blocked ?? queue[total - 1];
	const focusId = typeof focus?.issueId === "string" ? focus.issueId : "issue";
	parts.push(`issues: ${focusId}`);
	parts.push(`${done}/${total}`);
	const modes: string[] = [];
	if (run.advancementMode === "manual") modes.push("manual");
	if (run.workflowMode === "single") modes.push("single");
	const modeSuffix = modes.length > 0 ? ` (${modes.join(",")})` : "";
	if (status === "paused") {
		parts.push(`paused${modeSuffix} — /swarm issues status`);
	} else if (run.advancement === "waiting-manual") {
		parts.push(`manual-wait${modeSuffix} — /swarm issues resume`);
	} else if (active) {
		parts.push(`running${modeSuffix}`);
	} else {
		// running with nothing active = resting orphan (exhausted-blocked shape)
		parts.push(blocked ? `blocked${modeSuffix} — /swarm issues status` : `running${modeSuffix}`);
	}
	return truncate(parts.join(" "));
}

/**
 * Guarded L3 write: set (or clear) the swarm-issues status slot. No-op without UI
 * (print/JSON mode); any unexpected failure routes to the durable error log — NEVER thrown
 * into the pump/command path (evidence §7).
 */
export async function setIssueFooter(pi: any, ctx: any, st: any, p: Paths): Promise<void> {
	if (!ctx?.hasUI || typeof ctx?.ui?.setStatus !== "function") return;
	let line: string | undefined;
	try {
		line = renderIssueFooterLine(st?.issueRun);
	} catch (err: unknown) {
		// expected(): malformed run state is the documented degrade path (no crash, slot cleared)
		await logSwarmError(ctx.cwd ?? ".", "issues-footer", "footer_render_failed", expected("issue-run footer: malformed run state") && err, {});
		line = undefined;
	}
	try {
		ctx.ui.setStatus(FOOTER_KEY, line);
	} catch (err: unknown) {
		await logSwarmError(ctx.cwd ?? ".", "issues-footer", "footer_set_failed", err, { key: FOOTER_KEY });
	}
}
