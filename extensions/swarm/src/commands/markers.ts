import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { relative } from "node:path";
import { currentAgentId } from "../session.ts";
import { captureGitCommit, readState, trace, withLock, writeState } from "../state.ts";
import { capturePane } from "../tmux.ts";
import { maybeRotateTraces } from "../tools/audit.ts";
import type { Paths, SwarmMarker } from "../types.ts";
import { now, safeId } from "../utils.ts";
import { parseFlags } from "./parser.ts";

export function formatMarkerSuffix(d = new Date()): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	const y = d.getFullYear();
	const m = pad(d.getMonth() + 1);
	const day = pad(d.getDate());
	const h = pad(d.getHours());
	const min = pad(d.getMinutes());
	const s = pad(d.getSeconds());
	return `${y}${m}${day}-${h}${min}${s}`;
}

export function buildMarkerId(rawLabel?: string, d = new Date()): { id: string; label: string } {
	const suffix = formatMarkerSuffix(d);
	const clean = (rawLabel || "")
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/^-+|-+$/g, "");
	const label = clean || "mark";
	return {
		id: `${label}-${suffix}`,
		label,
	};
}

export function findMarker(markers: Record<string, SwarmMarker> | undefined, query: string): { marker?: SwarmMarker; error?: string } {
	if (!markers || !Object.keys(markers).length) {
		return { error: "no checkpoints found in state" };
	}
	const q = query.trim().toLowerCase();
	if (!q) return { error: "missing marker identifier" };
	if (markers[query]) return { marker: markers[query] };
	const exactId = Object.keys(markers).find((k) => k.toLowerCase() === q);
	if (exactId) return { marker: markers[exactId] };
	const prefixMatches = Object.keys(markers).filter((k) => k.toLowerCase().startsWith(q));
	if (prefixMatches.length === 1) return { marker: markers[prefixMatches[0]] };
	if (prefixMatches.length > 1) {
		return {
			error: `ambiguous identifier "${query}" (matches: ${prefixMatches.slice(0, 5).join(", ")}${prefixMatches.length > 5 ? "..." : ""})`,
		};
	}
	const labelMatches = Object.keys(markers).filter((k) => markers[k].label?.toLowerCase() === q);
	if (labelMatches.length === 1) return { marker: markers[labelMatches[0]] };
	if (labelMatches.length > 1) {
		return {
			error: `ambiguous label "${query}" (matches: ${labelMatches.slice(0, 5).join(", ")}${labelMatches.length > 5 ? "..." : ""})`,
		};
	}
	return { error: `checkpoint "${query}" not found` };
}

export async function handleMarkersCommand(
	cmd: "mark" | "markers" | "capture" | "audit",
	rest: string[],
	ctx: any,
	p: Paths,
	pi: ExtensionAPI,
): Promise<void> {
	if (cmd === "audit") {
		let mode = rest[0] && !String(rest[0]).startsWith("--") ? rest.shift() : "events";
		let json = false;
		let messageId: string | undefined;
		let limit: number | undefined;
		let event: string | undefined;
		let since: string | number | undefined;
		let until: string | number | undefined;
		let agent: string | undefined;
		let task: string | undefined;
		let cid: string | undefined;
		let rollupWindowMs: number | undefined;
		let generations: boolean | undefined;
		let rotate = false;
		for (let i = 0; i < rest.length; i++) {
			const t = rest[i];
			if (t === "--json") json = true;
			else if (t === "--probes") mode = "probes";
			else if (t === "--invariants") mode = "invariants";
			else if (t === "--timeline") mode = "timeline";
			else if (t === "--events") mode = "events";
			else if (t === "--rotate") rotate = true;
			else if (t === "--event") event = rest[++i];
			else if (t === "--since") since = rest[++i];
			else if (t === "--until") until = rest[++i];
			else if (t === "--agent") agent = rest[++i];
			else if (t === "--task") task = rest[++i];
			else if (t === "--cid") cid = rest[++i];
			else if (t === "--message") messageId = rest[++i];
			else if (t === "--limit") limit = Number(rest[++i]);
			else if (t === "--rollup-window") rollupWindowMs = Number(rest[++i]);
			else if (t === "--no-generations") generations = false;
		}
		if (rotate || mode === "rotate") {
			const res = await maybeRotateTraces(p, {});
			ctx.ui.notify(json ? JSON.stringify(res, null, 2) : `Trace rotation: ${JSON.stringify(res)}`, "info");
			return;
		}
		const { readAuditEvents, auditTimeline, checkInvariants } = await import("../tools/audit.ts");
		const filters = { event, since, until, agent, task, cid, limit };
		if (mode === "timeline") {
			const res = await auditTimeline(p, String(messageId || ""), { ...filters, generations });
			ctx.ui.notify(json ? JSON.stringify(res, null, 2) : JSON.stringify(res.timeline, null, 2), "info");
			return;
		}
		if (mode === "invariants") {
			const st = await readState(p, ctx.cwd);
			const res = await checkInvariants(p, st);
			ctx.ui.notify(json ? JSON.stringify(res, null, 2) : JSON.stringify(res.invariants, null, 2), "info");
			return;
		}
		if (mode === "probes") {
			const st = await readState(p, ctx.cwd);
			const eventsRes = await readAuditEvents(p, { ...filters, generations, rollupWindowMs });
			const payload = { ...eventsRes, probes: { P1: [], P2: [], P3: [], P4: [] } };
			const auditMod = await import("../tools/audit.ts");
			payload.probes = {
				P1: auditMod.__test.probeP1(st),
				P2: auditMod.__test.probeP2(st),
				P3: auditMod.__test.probeP3(eventsRes.events || []),
				P4: auditMod.__test.probeP4(eventsRes.events || []),
			};
			ctx.ui.notify(json ? JSON.stringify(payload, null, 2) : JSON.stringify(payload.probes, null, 2), "info");
			return;
		}
		const res = await readAuditEvents(p, { ...filters, generations, rollupWindowMs });
		ctx.ui.notify(json ? JSON.stringify(res, null, 2) : JSON.stringify(res, null, 2), "info");
		return;
	}

	if (cmd === "mark") {
		const subOrLabel = rest.shift();
		if (subOrLabel === "list") {
			const st = await readState(p, ctx.cwd);
			const markers = Object.values(st.markers || {}).sort((a, b) => (a.ts < b.ts ? 1 : -1));
			if (!markers.length) {
				ctx.ui.notify("No checkpoints marked yet. Usage: /swarm-mark [name] [note...]", "info");
				return;
			}
			const lines = markers.slice(0, 15).map((m) => {
				const noteStr = m.note ? ` — "${m.note}"` : "";
				const gitStr = m.gitHead ? ` [git: ${m.gitHead.slice(0, 7)}]` : "";
				return `  • ${m.id} (${m.ts.replace("T", " ").slice(0, 19)})${noteStr}${gitStr}`;
			});
			ctx.ui.notify(`📍 Checkpoints (${markers.length}):\n${lines.join("\n")}`, "info");
			return;
		}
		if (subOrLabel === "show") {
			const query = rest.shift();
			if (!query) {
				ctx.ui.notify("Usage: /swarm-mark show <id>", "warning");
				return;
			}
			const st = await readState(p, ctx.cwd);
			const { marker, error } = findMarker(st.markers, query);
			if (!marker) {
				ctx.ui.notify(error || `Checkpoint "${query}" not found`, "warning");
				return;
			}
			const noteStr = marker.note ? `\n  • Note: "${marker.note}"` : "\n  • Note: (none)";
			const gitStr = marker.gitHead ? `\n  • Git Commit: ${marker.gitHead}` : "\n  • Git Commit: (none)";
			const updatedStr = marker.updatedAt ? `\n  • Updated: ${marker.updatedAt.replace("T", " ").slice(0, 19)}` : "";
			const agentsStr = marker.activeAgents?.length
				? `\n  • Active Workers (${marker.activeAgents.length}):\n      ${marker.activeAgents.map((a) => `- ${a}`).join("\n      ")}`
				: "\n  • Active Workers: (none)";
			const tasksStr = marker.inFlightTasks?.length
				? `\n  • In-flight Tasks: ${marker.inFlightTasks.join(", ")}`
				: "\n  • In-flight Tasks: (none)";
			ctx.ui.notify(
				`📍 Checkpoint: ${marker.id}\n  • Label: ${marker.label}\n  • Created: ${marker.ts.replace("T", " ").slice(0, 19)} by ${marker.by}${updatedStr}${noteStr}${gitStr}${agentsStr}${tasksStr}`,
				"info",
			);
			return;
		}
		if (subOrLabel === "edit" || subOrLabel === "note") {
			const query = rest.shift();
			const newNote = rest.join(" ").trim();
			if (!query || !newNote) {
				ctx.ui.notify("Usage: /swarm-mark edit <id> <new note...>", "warning");
				return;
			}
			await withLock(p, async () => {
				const st = await readState(p, ctx.cwd);
				const { marker, error } = findMarker(st.markers, query);
				if (!marker) {
					ctx.ui.notify(error || `Checkpoint "${query}" not found`, "warning");
					return;
				}
				const oldNote = marker.note;
				marker.note = newNote;
				marker.updatedAt = now();
				st.markers![marker.id] = marker;
				await trace(p, "audit.checkpoint_updated", {
					markerId: marker.id,
					label: marker.label,
					oldNote,
					newNote,
					by: currentAgentId(),
				});
				await writeState(p, st);
				ctx.ui.notify(`📍 Checkpoint updated: ${marker.id} — "${newNote}"`, "info");
			});
			return;
		}
		if (subOrLabel === "rm" || subOrLabel === "delete") {
			const query = rest.shift();
			if (!query) {
				ctx.ui.notify("Usage: /swarm-mark rm <id>", "warning");
				return;
			}
			await withLock(p, async () => {
				const st = await readState(p, ctx.cwd);
				const { marker, error } = findMarker(st.markers, query);
				if (!marker) {
					ctx.ui.notify(error || `Checkpoint "${query}" not found`, "warning");
					return;
				}
				delete st.markers![marker.id];
				await trace(p, "audit.checkpoint_removed", {
					markerId: marker.id,
					label: marker.label,
					by: currentAgentId(),
				});
				await writeState(p, st);
				ctx.ui.notify(`🗑️ Checkpoint removed: ${marker.id}`, "info");
			});
			return;
		}
		if (subOrLabel === "clear") {
			const flags = parseFlags(rest);
			if (!flags.yes && !rest.includes("--yes")) {
				ctx.ui.notify("To remove all checkpoints, run: /swarm-mark clear --yes", "warning");
				return;
			}
			await withLock(p, async () => {
				const st = await readState(p, ctx.cwd);
				const count = Object.keys(st.markers || {}).length;
				st.markers = {};
				await trace(p, "audit.checkpoints_cleared", {
					count,
					by: currentAgentId(),
				});
				await writeState(p, st);
				ctx.ui.notify(`🗑️ Cleared all checkpoints (${count})`, "info");
			});
			return;
		}
		const note = rest.join(" ").trim() || undefined;
		const { id: markerId, label } = buildMarkerId(subOrLabel);
		const gitInfo = await captureGitCommit(pi);
		const gitHead = gitInfo.headCommit || undefined;
		const by = currentAgentId();
		const ts = now();
		await withLock(p, async () => {
			const st = await readState(p, ctx.cwd);
			st.markers ||= {};
			const activeAgents = Object.values(st.agents || {})
				.filter((a) => a.status === "running")
				.map((a) => `${a.id}(${a.runtimeStatus || "idle"})`);
			const inFlightTasks = Array.from(
				new Set(
					Object.values(st.agents || {})
						.flatMap((a) => a.activeTaskIds || [])
						.filter(Boolean),
				),
			);
			const markerRecord: SwarmMarker = {
				id: markerId,
				label,
				ts,
				note,
				gitHead,
				activeAgents,
				inFlightTasks,
				by,
			};
			st.markers[markerId] = markerRecord;
			await trace(p, "audit.checkpoint", {
				markerId,
				label,
				note,
				gitHead,
				activeAgents,
				inFlightTasks,
				by,
			});
			await writeState(p, st);
		});
		ctx.ui.notify(
			`📍 Checkpoint marked: ${markerId}${note ? ` — "${note}"` : ""}${gitHead ? ` [git: ${gitHead.slice(0, 7)}]` : ""}\nTrace logged to: ${relative(ctx.cwd, p.events)}`,
			"info",
		);
		return;
	}

	if (cmd === "markers") {
		const st = await readState(p, ctx.cwd);
		const markers = Object.values(st.markers || {}).sort((a, b) => (a.ts < b.ts ? 1 : -1));
		if (!markers.length) {
			ctx.ui.notify("No checkpoints marked yet. Usage: /swarm-mark [name] [note...]", "info");
			return;
		}
		const lines = markers.slice(0, 15).map((m) => {
			const noteStr = m.note ? ` — "${m.note}"` : "";
			const gitStr = m.gitHead ? ` [git: ${m.gitHead.slice(0, 7)}]` : "";
			return `  • ${m.id} (${m.ts.replace("T", " ").slice(0, 19)})${noteStr}${gitStr}`;
		});
		ctx.ui.notify(`📍 Checkpoints (${markers.length}):\n${lines.join("\n")}`, "info");
		return;
	}

	if (cmd === "capture") {
		const agentId = rest[0];
		if (!agentId) {
			ctx.ui.notify("Usage: /swarm capture <agent-id>", "warning");
			return;
		}
		const st = await readState(p, ctx.cwd);
		const agent = st.agents[safeId(agentId)];
		if (!agent) {
			ctx.ui.notify(`Unknown agent ${agentId}`, "warning");
			return;
		}
		const file = await capturePane(pi, p, agent.id, agent.tmuxTarget, `command-${Date.now()}`);
		ctx.ui.notify(`Captured to ${relative(ctx.cwd, file)}`, "info");
		return;
	}
}
