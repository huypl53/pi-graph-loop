import { randomBytes } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { currentAgentId } from "./session.ts";
import type { Paths, TaskPaths } from "./types.ts";
import { now } from "./utils.ts";
import { paths, trace } from "./state.ts";

export type EvidenceAttestation = {
	claim: string;
	tool: string;
	eventId: string;
	ts: string;
};

export type AttestationCheck =
	| { ok: true; checked: number; matchedClaims: string[] }
	| { ok: false; checked: number; matchedClaims: string[]; errors: string[] };

const PASS_FAIL_CLAIM_RE = /(^|\n)\s*((Passed|Failed)\s*:[^\n]+)/gi;

function evidenceId() {
	return `e-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
}

function normalizeClaim(text: string) {
	return text.trim().toLowerCase().replace(/\s+/g, " ");
}

function claimKind(claim: string): "passed" | "failed" | undefined {
	const m = claim.match(/^(Passed|Failed)\s*:/i);
	if (!m) return undefined;
	return m[1].toLowerCase() as "passed" | "failed";
}

function isFailureEvent(event: Record<string, any>) {
	if (!event) return false;
	if (event.isError === true) return true;
	if (event.cls && event.cls !== "success") return true;
	if (typeof event.exitCode === "number" && event.exitCode !== 0) return true;
	if (typeof event.code === "number" && event.code !== 0) return true;
	return false;
}

function eventFailureLabel(event: Record<string, any>) {
	if (!event) return "unknown";
	if (event.isError === true) return "isError=true";
	if (event.cls && event.cls !== "success") return `cls=${event.cls}`;
	if (typeof event.exitCode === "number") return `exitCode=${event.exitCode}`;
	if (typeof event.code === "number") return `code=${event.code}`;
	return "success";
}

function eventRef(event: Record<string, any>) {
	return `tool=${event?.tool || "?"}, eid=${event?.eid || event?.eventId || event?.evidenceId || "?"}, ts=${event?.ts || "?"}`;
}

function claimMatchesAttestation(claim: string, att: EvidenceAttestation) {
	const c = normalizeClaim(claim);
	const a = normalizeClaim(att.claim);
	return c.includes(a) || a.includes(c);
}

export async function readTraceEvents(p: Paths): Promise<Record<string, any>[]> {
	let raw = "";
	try {
		raw = await readFile(p.events, "utf8");
	} catch {
		return [];
	}
	return raw.split("\n").filter(Boolean).map((line) => {
		try { return JSON.parse(line); } catch { return null; }
	}).filter(Boolean);
}

export function resolveAttestedEvent(events: Record<string, any>[], att: EvidenceAttestation) {
	const byId = events.find((ev) => ev?.eid === att.eventId || ev?.eventId === att.eventId || ev?.evidenceId === att.eventId);
	if (byId) return byId;
	return events.find((ev) => String(ev?.tool || "") === String(att.tool || "") && String(ev?.ts || "") === String(att.ts || ""));
}

export function extractClaims(text: string): string[] {
	const out: string[] = [];
	for (const m of text.matchAll(PASS_FAIL_CLAIM_RE)) {
		const claim = (m[2] || "").trim();
		if (claim) out.push(claim);
	}
	return out;
}

export async function validateAttestations(p: Paths, opts: { note?: string; artifactText?: string; attestations?: EvidenceAttestation[] }): Promise<AttestationCheck> {
	const combined = [opts.note || "", opts.artifactText || ""].filter(Boolean).join("\n\n");
	const claims = extractClaims(combined);
	const attestations = opts.attestations || [];
	if (!claims.length) return { ok: true, checked: 0, matchedClaims: [] };
	if (!attestations.length) {
		return { ok: false, checked: 0, matchedClaims: [], errors: claims.map((claim) => `ATTESTATION_MISSING: claim "${claim}" has no evidence citation`) };
	}

	const events = await readTraceEvents(p);
	const matchedClaims: string[] = [];
	const errors: string[] = [];

	for (const claim of claims) {
		const att = attestations.find((item) => claimMatchesAttestation(claim, item));
		if (!att) {
			errors.push(`ATTESTATION_MISSING: claim "${claim}" has no matching attestation entry`);
			continue;
		}
		matchedClaims.push(claim);
		const event = resolveAttestedEvent(events, att);
		if (!event) {
			errors.push(`EVENT_NOT_FOUND: claim "${claim}" cites ${att.tool}/${att.eventId} @ ${att.ts}, but no trace event matched`);
			continue;
		}
		if (String(event.ts || "") !== String(att.ts || "")) {
			errors.push(`TS_MISMATCH: claim "${claim}" cites ts=${att.ts} but trace event ts=${event.ts}`);
			continue;
		}
		const kind = claimKind(claim);
		const failed = isFailureEvent(event);
		if (kind === "passed" && failed) {
			errors.push(`EXIT_MISMATCH: claim "${claim}" says Passed, but ${eventRef(event)} shows failure (${eventFailureLabel(event)})`);
			continue;
		}
		if (kind === "failed" && !failed) {
			errors.push(`EXIT_MISMATCH: claim "${claim}" says Failed, but ${eventRef(event)} shows success`);
			continue;
		}
	}

	if (errors.length) return { ok: false, checked: matchedClaims.length, matchedClaims, errors };
	return { ok: true, checked: matchedClaims.length, matchedClaims };
}

export async function registerEvidenceHooks(pi: ExtensionAPI) {
	pi.on("tool_execution_end", async (event: any, ctx: any) => {
		try {
			if (!ctx?.cwd) return;
			const p = paths(ctx.cwd);
			const record = {
				ts: typeof event?.ts === "string" ? event.ts : now(),
				event: "tool.executed",
				eid: event?.eid || event?.eventId || evidenceId(),
				tool: event?.toolName || event?.tool || event?.name || event?.tool_id || "unknown",
				toolCallId: event?.toolCallId || event?.callId || event?.id || null,
				agentId: currentAgentId(),
				isError: Boolean(event?.isError ?? event?.error ?? (event?.cls && event.cls !== "success")),
				exitCode: typeof event?.exitCode === "number" ? event.exitCode : (typeof event?.code === "number" ? event.code : null),
				cls: event?.cls || (event?.error ? "error" : "success"),
			};
			await mkdir(dirname(p.events), { recursive: true });
			await appendFile(p.events, `${JSON.stringify(record)}\n`, "utf8");
		} catch {
			// best-effort evidence tracing; never block tool execution.
		}
	});
}

export async function writeBaselineCommit(pi: ExtensionAPI, tp: TaskPaths): Promise<{ available: boolean; baseline?: string }> {
	try {
		const r = await pi.exec("git", ["rev-parse", "HEAD"], { timeout: 5000 });
		if (r.code !== 0) return { available: false };
		const head = (r.stdout || "").trim();
		if (!head) return { available: false };
		await writeFile(join(tp.root, "baseline.txt"), `${head}\n`, "utf8");
		return { available: true, baseline: head };
	} catch {
		return { available: false };
	}
}

export async function attachGitDiffStat(pi: ExtensionAPI, cwd: string, tp: TaskPaths): Promise<{ available: boolean; baseline?: string; stat?: string; note?: string }> {
	let baseline = "";
	try {
		baseline = (await readFile(join(tp.root, "baseline.txt"), "utf8")).trim();
	} catch {
		return { available: false, note: "baseline_missing" };
	}
	if (!baseline) return { available: false, baseline, note: "baseline_empty" };
	try {
		const r = await pi.exec("git", ["diff", "--stat", baseline], { timeout: 10_000 });
		if (r.code !== 0) return { available: false, baseline, note: `git_diff_failed:${(r.stderr || r.stdout || "unknown").trim().slice(0, 200)}` };
		const stat = (r.stdout || "").trim();
		return { available: true, baseline, stat: stat || "(no diff)" };
	} catch (err: any) {
		return { available: false, baseline, note: `git_diff_failed:${String(err?.message || err)}` };
	}
}
