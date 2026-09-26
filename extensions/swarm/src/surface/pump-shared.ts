// === swarm/surface/pump-shared.ts — pump helpers shared by pump.ts / pump-decision.ts ===
// Extracted verbatim from surface/pump.ts (Phase 7 split of ../surface.ts).
import { createHash } from "node:crypto";
import { now } from "../utils.ts";

// Helper to compute a fingerprint for a message record (sha256(messageId:lastUpdatedAt)). Used by
// the consumer receipt ledger to detect silent edits to message records between surfacing and
// reincarnation.
export function fingerprintMessage(rec: { id: string; updatedAt?: string; createdAt?: string }): string {
	const ts = rec.updatedAt || rec.createdAt || now();
	return createHash("sha256").update(`${rec.id}:${ts}`).digest("hex");
}
