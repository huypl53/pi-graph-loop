// V1.5 opt-in post-iteration proposal loop. Metadata only: it does NOT change node routing,
// branch logic, or task closure rules. When absent or enabled !== true, the graph behaves exactly
// as it does today. Loop state lives under .pi/swarm/loops/<taskId>.json (see loop helpers).
export type LoopConfig = {
	enabled: boolean;
	proposalAgents: string[];
	refreshAgents?: string[];
	maxRounds?: number;
};

export type LoopPhase = "idle" | "collecting_proposals" | "awaiting_plan" | "planned" | "refreshing" | "executing";

export type LoopProposalStatus = "requested" | "received" | "skipped" | "failed";

export type LoopProposal = {
	agentId: string;
	messageId?: string;
	status: LoopProposalStatus;
	receivedAt?: string;
	summary?: string;
	body?: string;
	error?: string;
};

export type LoopRefreshMode = "tmux_new" | "identity_reload" | "skipped";

export type LoopRefreshResult = {
	agentId: string;
	mode: LoopRefreshMode;
	tmuxAlive?: boolean;
	injected?: boolean;
	error?: string;
};

export type LoopPlan = {
	artifact: string;
	summary: string;
	nextSteps?: string;
	createdAt: string;
	createdBy: string;
};

export type LoopRound = {
	round: number;
	phase: LoopPhase;
	startedAt: string;
	endedAt?: string;
	proposalMessageIds: string[];
	proposals: LoopProposal[];
	plan?: LoopPlan;
	refreshResults: LoopRefreshResult[];
};

export type LoopState = {
	taskId: string;
	enabled: boolean;
	config: LoopConfig;
	currentRound: number;
	phase: LoopPhase;
	rounds: LoopRound[];
	createdAt: string;
	updatedAt: string;
};

export type MetricContract = {
	id: string;
	title: string;
	version?: number;
	primaryMetric: {
		id: string;
		direction: string; // maximize | minimize | target | passfail
		valueType: string; // number | boolean | string
		source: { type: string; artifactPath?: string; jsonPath?: string; command?: string };
		minimumMeaningfulChange?: number;
		target?: number; // goal value for direction=target
	};
	validityRules?: string[];
	evidenceRequired?: string[];
	notes?: string;
	status?: string;
	createdAt?: string;
	updatedAt?: string;
};

export type EvidenceDigest = { ref: string; sha256: string; size: number };

export type RunRecord = {
	runId: string;
	metricContractId?: string;
	metricContractVersion?: number;
	taskId?: string;
	nodeId?: string;
	agentId?: string;
	model?: string;
	provider?: string;
	status: string; // running | done | blocked | failed
	verdict?: string; // pass | fail | approved | rejected | blocked
	metrics?: Record<string, number | boolean | string>;
	inputs?: Record<string, unknown>;
	evidenceRefs?: string[];
	evidenceDigests?: EvidenceDigest[];
	notes?: string;
	startedAt?: string;
	endedAt?: string;
	git?: { available?: boolean; baseCommit?: string; headCommit?: string };
	recordedAt?: string;
};

export type MemoryRecord = {
	memoryId: string;
	claim: string;
	sourceRunId: string;
	evidenceRefs: string[];
	scope?: { kind?: string; id?: string };
	confidence?: number;
	status: string; // proposed | active | rejected | expired
	reviewedBy?: string;
	rejectionReason?: string;
	notes?: string;
	createdAt?: string;
	updatedAt?: string;
};

export type IterationEntry = {
	index: number;
	runId: string;
	label?: string;
	recordedAt: string;
};

export type IterationSession = {
	iterationId: string;
	metricContractId: string;
	goal?: string;
	scope?: { kind?: string; id?: string };
	baselineRunId?: string;
	iterations: IterationEntry[];
	bestRunId?: string;
	pinnedMemoryIds: string[];
	status: string; // active | archived
	notes?: string;
	createdAt: string;
	updatedAt: string;
};

export type IterationBest = {
	metricId: string;
	direction: string;
	target?: number;
	bestRunId?: string;
	bestValue?: number | boolean;
	baselineRunId?: string;
	baselineValue?: number | boolean;
	improvement?: number; // signed in the favored direction (positive = better); for target, reduction in distance
	passingCount?: number; // passfail only
	meaningful: boolean;
	missingCount: number;
	invalidCount: number;
	perRun: { runId: string; label?: string; value?: number | boolean; present: boolean; eligible: boolean; exclusionReasons: string[] }[];
	warnings: string[];
};
