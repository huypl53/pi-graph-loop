// === swarm/taskgraph/graph.ts — graph construction, validation, formatting (Phase 6) ===
// Graph building, cycle detection, rework activation, and ASCII/Mermaid formatting
// live in the canonical ../taskgraph.ts. This module re-exports the graph surface.

export {
	buildGraphFromInput,
	validateTaskGraph,
	buildTaskMarkdown,
	buildAssignmentBody,
	activateReworkNodes,
	graphJsonSummary,
	printGraphMermaid,
	printGraphText,
} from "../taskgraph.ts";
