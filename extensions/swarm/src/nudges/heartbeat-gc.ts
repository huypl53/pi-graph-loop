// === swarm/nudges/heartbeat-gc.ts — agent heartbeat GC (Phase 6) ===
// agentHeartbeatGCLocked lives in graph-advance.ts.
// Calls driver.isTargetAlive() via the terminal driver abstraction (Phase 1/2).

export { agentHeartbeatGCLocked } from "./graph-advance.ts";
