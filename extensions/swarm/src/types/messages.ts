export type MessageStatus = "queued" | "mailbox_delivered" | "injected" | "intercepted" | "acked" | "failed" | "dead_letter";

export type MessageResponseStatus = "not_required" | "missing" | "sent" | "verified" | "waived";

export type MessageRecord = {
	id: string;
	from: string;
	to: string;
	status: MessageStatus;
	createdAt: string;
	updatedAt: string;
	queuedAt?: string;
	injectedAt?: string;
	interceptedAt?: string;
	ackedAt?: string;
	surfacedAt?: string;
	failedAt?: string;
	ackMissingAt?: string;
	// Bounded re-injection of delivered-but-unacked messages (issue A): count of re-injections since
	// the original delivery, capped by MAX_REINJECTS so an unresponsive-but-alive agent is not spammed.
	reinjects?: number;
	lastReinjectAt?: string;
	attempts: number;
	requiresAck: boolean;
	requiresResponse?: boolean;
	response?: {
		status: MessageResponseStatus;
		resultMessageId?: string;
		missingAt?: string;
		sentAt?: string;
		verifiedAt?: string;
		waivedAt?: string;
		waivedBy?: string;
		lastError?: string;
	};
	conversationId?: string;
	replyTo?: string;
	lastError?: string;
	lastAck?: { by: string; status: string; note?: string; resultMessageId?: string; at: string };
	subject?: string;
	ttlMs?: number;
	idempotencyKey?: string;
	// Set when a newer assignment supersedes this open assignment message (idempotency/supersede fix).
	superseded?: { at: string; by: string; supersededBy: string };

	// === Issue 83b — late-result rejection count ===
	// Number of times a worker attempted to apply a result against this message's `attemptId`
	// after the attempt was superseded. Distinct from the message-level `superseded` field
	// (which records the supersede event itself): `lateResultRejectionCount` counts the
	// late-arrival rejections — a quality signal for roots to detect a stuck worker
	// that is still trying to apply results against its old lease.
	lateResultRejectionCount?: number;
	// ISO timestamp of the most recent late-result rejection. Paired with `lateResultRejectionCount`
	// for ops dashboards (`/swarm status` / trace census).
	lastLateResultRejectionAt?: string;

	// --- Issue 25 Phase 1: v2 lifecycle evidence schema ---
	// Each field has a distinct meaning (see proposal §A); none of them overloads the
	// existing delivered/ack fields. Under gate=0 these are SHADOW ONLY: the engine does
	// not mutate state or change completion decisions. Under gate=1 (Phase 2) the same
	// derivation paths become authoritative.
	mailboxDeliveredAt?: string; // durable mailbox append succeeded (transport receipt)
	seenAt?: string; // API-level surface/read receipt (NOT pane injection)
	processingAt?: string; // recipient action scoped to task/node/assignment
	respondedAt?: string; // accepted, non-superseded replyTo response received
	terminalAt?: string; // inferred terminal disposition reached
	terminalReason?: string; // evidence source label (e.g. "response_verified", "task_node_terminal", "supersession", "deadline_exceeded", "ttl_expired")
	lifecycleStage?: "delivered" | "surfaced" | "seen" | "processing" | "responded" | "terminal"; // derived stage at last derivation; shadow-only under gate=0
	lifecycleSource?: string; // the evidence source that drove the last derivation (e.g. "mailbox.read", "task.tool", "reply.accepted")
	// Optional forward-compat fields on the send side. NOT exposed in normal tool
	// schemas during Phase 1; the migration tool may stamp `expectResponse` on legacy
	// envelopes when it can derive a response expectation without inventing one.
	expectResponse?: boolean;
	responseDeadlineMs?: number;
	escalateIfSilent?: boolean;
	// Migration provenance (Issue 25 Phase 1 §D). Additive audit field; set by the migration
	// command only. Absent on pre-migration records.
	migrationRunId?: string; // runId of the migration that last touched this record
	migratedAt?: string; // ISO timestamp of the last successful migration write
};

// Durable recipient receipt entry for the root mailbox consumer (issue 11). Populated
// when a TUI-side delivery succeeds (surfacedAt stamped) OR by the one-time migration back-fill
// for legacy `requiresAck: true` messages that are no longer actionable. Per-message fingerprint
// (sha256(messageId + lastUpdatedAt)) protects a reincarnated consumer against silent message
// record edits. Primary dedupe gate for the root pump across PID recycle / restart.
// conversationId stores the raw "task:taskId:nodeId" reference for later parsing.
export type RootReceiptEntry = {
	surfacedAt: string;
	ackedAt?: string;
	requiresAck: boolean;
	conversationId?: string;
	fingerprint: string;
};

export type SwarmMessage = {
	id: string;
	swarmId: string;
	from: string;
	to: string;
	subject?: string;
	priority: string;
	type: "swarm.message";
	schemaVersion: number;
	createdAt: string;
	body: string;
	conversationId?: string;
	replyTo?: string;
	requiresAck: boolean;
	requiresResponse?: boolean;
	ttlMs?: number;
	idempotencyKey?: string;
	headers: Record<string, string>;
};
