import type { TaskState } from "../types.ts";
import type { GraphTreeEntry, GraphTreeModel } from "./types.ts";

export function outgoingEdges(task: TaskState, nodeId: string) {
	return task.edges.filter((edge) => edge.from === nodeId);
}

export function outgoingEdgeCount(task: TaskState, nodeId: string): number {
	return task.edges.filter((e) => e.from === nodeId).length;
}

export function buildGraphTree(task: TaskState): GraphTreeModel {
	const entries: GraphTreeEntry[] = [];
	const firstIndexByNodeId = new Map<string, number>();
	const inOrderRoots = task.nodes[task.start]
		? [task.start]
		: Object.keys(task.nodes).filter((id) => !task.edges.some((edge) => edge.to === id));
	const roots = inOrderRoots.length ? inOrderRoots : Object.keys(task.nodes);
	const visit = (
		nodeId: string,
		depth: number,
		parentIndex: number | null,
		edge?: { from: string; when: string; rework?: boolean },
		path = new Set<string>(),
	): number => {
		const node = task.nodes[nodeId];
		if (!node) return -1;
		const repeated = firstIndexByNodeId.has(nodeId);
		const index = entries.length;
		entries.push({
			index,
			nodeId,
			depth,
			parentIndex,
			edgeFrom: edge?.from,
			edgeWhen: edge?.when,
			edgeRework: edge?.rework,
			repeated,
			children: [],
		});
		if (!firstIndexByNodeId.has(nodeId)) firstIndexByNodeId.set(nodeId, index);
		if (path.has(nodeId)) return index;
		const nextPath = new Set(path);
		nextPath.add(nodeId);
		for (const childEdge of outgoingEdges(task, nodeId)) {
			const childIndex = visit(childEdge.to, depth + 1, index, childEdge, nextPath);
			if (childIndex >= 0) entries[index].children.push(childIndex);
		}
		return index;
	};
	for (const root of roots) visit(root, 0, null, undefined, new Set());
	return { entries, firstIndexByNodeId };
}

export function collectGraphPaths(
	task: TaskState,
): Array<{ nodes: string[]; edges: Array<{ from: string; to: string; when: string; rework?: boolean }> }> {
	const outgoing = new Map<string, Array<{ from: string; to: string; when: string; rework?: boolean }>>();
	for (const edge of task.edges) {
		const arr = outgoing.get(edge.from) || [];
		arr.push(edge);
		outgoing.set(edge.from, arr);
	}
	for (const edges of outgoing.values()) {
		edges.sort((a, b) => (a.when || "").localeCompare(b.when || "") || a.to.localeCompare(b.to));
	}
	const roots = task.nodes[task.start]
		? [task.start]
		: Object.keys(task.nodes).filter((id) => !task.edges.some((edge) => edge.to === id));
	const paths: Array<{ nodes: string[]; edges: Array<{ from: string; to: string; when: string; rework?: boolean }> }> = [];
	const walk = (
		nodeId: string,
		nodes: string[],
		edges: Array<{ from: string; to: string; when: string; rework?: boolean }>,
		seen: Set<string>,
	) => {
		const next = outgoing.get(nodeId) || [];
		const nextNodes = [...nodes, nodeId];
		if (!next.length || seen.has(nodeId) || nextNodes.length > Object.keys(task.nodes).length + 3) {
			paths.push({ nodes: nextNodes, edges });
			return;
		}
		for (const edge of next) walk(edge.to, nextNodes, [...edges, edge], new Set([...seen, nodeId]));
	};
	for (const root of roots) walk(root, [], [], new Set());
	return paths.length ? paths : Object.keys(task.nodes).map((id) => ({ nodes: [id], edges: [] }));
}

export function deriveCurrentNodeIds(task: TaskState): string[] {
	const explicit = (task.currentNodes || []).filter((id) => Boolean(task.nodes[id]));
	if (explicit.length) return explicit;
	const inProgress = Object.entries(task.nodes)
		.filter(([, node]) => node.status === "in_progress")
		.map(([id]) => id);
	if (inProgress.length) return inProgress;
	const assigned = Object.entries(task.nodes)
		.filter(([, node]) => node.status === "assigned")
		.map(([id]) => id);
	if (assigned.length) return assigned;
	return Object.entries(task.nodes)
		.filter(([, node]) => node.status === "ready")
		.map(([id]) => id);
}
