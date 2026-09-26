import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import {
	TRACE_PROTOCOL_MIGRATION_COMPLETED,
	TRACE_PROTOCOL_MIGRATION_RECORD,
} from "../constants.ts";
import { readState, trace, withLock, writeState } from "../state.ts";
import type { Paths } from "../types.ts";
import { now } from "../utils.ts";
import { parseFlags } from "./parser.ts";

export async function handleProtocolCommand(
	cmd: "protocol",
	rest: string[],
	ctx: any,
	p: Paths,
	_pi: ExtensionAPI,
): Promise<void> {
	const sub = rest.shift();
	if (sub !== "migrate") {
		ctx.ui.notify("Usage: /swarm protocol migrate [--dry-run]", "warning");
		return;
	}
	const dryRun = rest.some((t) => t === "--dry-run" || t === "-n");
	const flags = parseFlags(rest.filter((t) => t !== "--dry-run" && t !== "-n"));
	if (flags.rest.length) {
		ctx.ui.notify("Usage: /swarm protocol migrate [--dry-run]", "warning");
		return;
	}
	const outcome = await withLock(p, async () => {
		const st = await readState(p, ctx.cwd);
		const ts = now();
		const runId = `pmig-${ts.replace(/[-:.TZ]/g, "").slice(0, 14)}-${randomUUID().slice(0, 6)}`;
		let scanned = 0;
		let migrated = 0;
		let skipped = 0;
		const errors = 0;
		const plan: Array<{ messageId: string; action: string; reason: string }> = [];
		for (const [msgId, rec] of Object.entries(st.messages || {})) {
			scanned++;
			let action: "skip" | "stamp" | "plan" = "skip";
			let reason = "";
			if (rec.migrationRunId) {
				skipped++;
				action = "skip";
				reason = "migrationRunId already set";
			} else {
				const deliveredArr = st.delivered?.[rec.to] || [];
				const backfill =
					!rec.mailboxDeliveredAt && deliveredArr.includes(msgId)
						? { mailboxDeliveredAt: rec.injectedAt || rec.createdAt }
						: null;
				if (!backfill) {
					skipped++;
					action = "skip";
					reason = "no transport receipt to stamp; other v2 fields derived lazily";
				} else if (dryRun) {
					action = "plan";
					reason = "would back-fill transport-only mailboxDeliveredAt from delivered[] entry";
				} else {
					const updated: typeof rec = { ...rec };
					updated.mailboxDeliveredAt = backfill.mailboxDeliveredAt;
					updated.migrationRunId = runId;
					updated.migratedAt = ts;
					st.messages[msgId] = updated;
					action = "stamp";
					reason = "back-filled transport-only mailboxDeliveredAt from delivered[] entry";
					migrated++;
				}
			}
			plan.push({ messageId: msgId, action, reason });
			await trace(p, TRACE_PROTOCOL_MIGRATION_RECORD, {
				runId,
				messageId: msgId,
				from: rec.from,
				to: rec.to,
				action,
				reason,
				fields: action === "skip" ? [] : ["mailboxDeliveredAt"],
				auditOnly: true,
				dryRun,
			});
		}
		if (!dryRun && (migrated > 0 || scanned > 0)) await writeState(p, st);
		await trace(p, TRACE_PROTOCOL_MIGRATION_COMPLETED, {
			runId,
			scanned,
			migrated,
			skipped,
			errors,
			dryRun,
			via: "command",
			gate: 0,
		});
		return { runId, scanned, migrated, skipped, errors, dryRun, plan };
	});
	const head = `Migration ${outcome.dryRun ? "(dry-run) " : ""}complete. runId=${outcome.runId} scanned=${outcome.scanned} migrated=${outcome.migrated} skipped=${outcome.skipped} errors=${outcome.errors} dryRun=${outcome.dryRun}`;
	ctx.ui.notify(head, outcome.errors > 0 ? "warning" : "info");
}
