// === swarm/types/loops.ts — RETIRED (task-202610110323-audit-and-retire-dormant) ===
//
// The dormant experimentation subsystem (metric contracts, runs, memory, iteration sessions,
// V1.5 post-iteration loop state) was audited with a full call-graph scan: no live caller of
// LoopConfig/LoopState/LoopRound/LoopPhase/LoopProposal/LoopRefreshResult/LoopPlan/
// IterationSession/IterationBest/IterationPhase/MetricContract/RunRecord/MemoryRecord/
// EvidenceDigest remained outside this file, so the type family was deleted.
//
// HISTORICAL DATA IS PRESERVED: existing files under .pi/swarm/{metrics,runs,memory,
// iterations,loops}/ and any `loop` key inside legacy task.json files are NOT read, written,
// deleted, or migrated by current code. Old JSON fields (including `loop`) survive reads and
// writes untouched (JSON.stringify round-trips unknown keys). Git history is the record.
export {};
