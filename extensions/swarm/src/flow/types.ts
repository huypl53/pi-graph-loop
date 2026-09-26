import type { computeTaskClosure } from "../taskgraph.ts";
import type { SwarmState, TaskPaths, TaskState } from "../types.ts";

export const FLOW_OVERLAY_OPTIONS = {
	width: "96%",
	minWidth: 60,
	maxHeight: "78%",
	anchor: "center",
	margin: { top: 1, bottom: 1 },
} as const;

export const PICKER_OVERLAY_OPTIONS = {
	width: "70%",
	minWidth: 58,
	maxHeight: "68%",
	anchor: "center",
	margin: { top: 1, bottom: 1 },
} as const;

export const DEFAULT_EVENT_LIMIT = 20;
export const WATCH_AGE_MS = 2 * 60 * 1000;
export const FRESHNESS_MS = 60 * 1000;

export type Severity = "act" | "watch" | "info";
export type Section = "ATTENTION" | "FLOW" | "LANES" | "EVENTS";

export interface FlowAttentionItem {
	severity: Severity;
	kind: "node" | "message" | "agent";
	title: string;
	summary: string;
	detail: string;
	hint: string;
	taskId?: string;
	nodeId?: string;
	agentId?: string;
	messageId?: string;
}

export interface FlowLaneItem {
	id: string;
	status: string;
	runtimeStatus: string;
	health: string;
	roleKind: string;
	activeTaskIds: string[];
	nodeIds: string[];
	missing?: boolean;
}

export interface FlowDialogData {
	refreshedAt: string;
	freshnessLabel: string;
	stale: boolean;
	task: TaskState;
	tp: TaskPaths;
	st: SwarmState;
	open: number;
	staleCount: number;
	ready: string[];
	current: string[];
	attention: FlowAttentionItem[];
	lanes: FlowLaneItem[];
	otherAgentsCount: number;
	events: Array<{ text: string; raw: Record<string, any> }>;
	eventLimit: number;
	closure: ReturnType<typeof computeTaskClosure>;
}

export interface FlowDialogOpts {
	eventLimit?: number;
}

export interface PickerEntry {
	index: number;
	taskId: string;
	title: string;
	status: string;
	updatedAt: string;
	attentionCount: number;
	priority: number;
}

export interface Row {
	section: Section;
	id: string;
	title: string;
	summary: string;
	detail: string;
	hint: string;
	search: string;
	severity: Severity;
	nodeId?: string;
	agentId?: string;
	messageId?: string;
}

export interface NodeMessage {
	from: string;
	to: string;
	subject?: string;
	body?: string;
	messageId: string;
	lifecycle: string;
	timestamp: string;
}

export interface FlowHandoffLine {
	edge: string;
	messageId?: string;
	text: string;
	nodeId?: string;
}

export interface FlowEventGroup {
	title: string;
	items: Array<{ text: string; raw: Record<string, any> }>;
}

export interface GraphTreeEntry {
	index: number;
	nodeId: string;
	depth: number;
	parentIndex: number | null;
	edgeFrom?: string;
	edgeWhen?: string;
	edgeRework?: boolean;
	repeated: boolean;
	children: number[];
}

export interface GraphTreeModel {
	entries: GraphTreeEntry[];
	firstIndexByNodeId: Map<string, number>;
}
