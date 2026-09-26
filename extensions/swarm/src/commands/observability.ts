import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { openFlowDialog, pickFlowTask } from "../flow-dialog.ts";
import { focusAgentWindow, formatFocusStatus, getFocusStatus, isAutoFocusEnabled, pickNextBusyAgent } from "../focus.ts";
import { buildFlowSnapshot } from "../observability.ts";
import { listTasksIndexed, renderTasksIndexedList, resolveTaskArg } from "../reconcile.ts";
import { currentAgentId } from "../session.ts";
import { readState, trace, traceTask, withLock, writeState } from "../state.ts";
import type { Paths } from "../types.ts";
import { now, safeId } from "../utils.ts";

export async function handleObservabilityCommand(
	cmd: "flow" | "trace" | "metrics" | "focus" | "auto-focus" | "focus-busy",
	rest: string[],
	ctx: any,
	p: Paths,
	pi: ExtensionAPI,
): Promise<void> {
	if (cmd === "flow") {
		const arg = rest.shift();
		let events = 20;
		let badFlag: string | null = null;
		for (let i = 0; i < rest.length; i++) {
			const t = rest[i];
			if (t === "--events") {
				const raw = rest[++i];
				const n = Number(raw);
				if (!raw || !Number.isInteger(n) || n <= 0) {
					badFlag = `Invalid --events value: ${raw ?? "(missing)"}`;
					break;
				}
				events = Math.min(100, n);
				continue;
			}
			badFlag = `Unknown flow flag: ${t}`;
			break;
		}
		if (badFlag) {
			ctx.ui.notify(`${badFlag}\n\nUsage: /swarm flow <#|task-id> [--events N]`, "warning");
			return;
		}
		if (ctx.mode === "tui" && ctx.hasUI) {
			if (!arg) {
				const picked = await pickFlowTask(ctx, ctx.cwd, p);
				if (!picked) return;
				await openFlowDialog(ctx, ctx.cwd, p, picked.task, picked.tp, { eventLimit: events });
				return;
			}
			const { hit, list, missReason, ambiguous } = await resolveTaskArg(p, arg);
			if (!hit) {
				const hint = ambiguous ? `Ambiguous "${arg}" matches: ${ambiguous.join(", ")}` : missReason || "task not found";
				ctx.ui.notify(`${hint}\n\n${renderTasksIndexedList(list)}`, "warning");
				return;
			}
			await openFlowDialog(ctx, ctx.cwd, p, hit.task, hit.tp, { eventLimit: events });
			return;
		}
		if (!arg) {
			const list = await listTasksIndexed(p);
			ctx.ui.notify(`${renderTasksIndexedList(list)}\n\nUsage: /swarm flow <#|task-id> [--events N]`, "info");
			return;
		}
		const { hit, list, missReason, ambiguous } = await resolveTaskArg(p, arg);
		if (!hit) {
			const hint = ambiguous ? `Ambiguous "${arg}" matches: ${ambiguous.join(", ")}` : missReason || "task not found";
			ctx.ui.notify(`${hint}\n\n${renderTasksIndexedList(list)}`, "warning");
			return;
		}
		const task = hit.task;
		const tp = hit.tp;
		const st = await readState(p, ctx.cwd);
		const out = await buildFlowSnapshot(p, ctx.cwd, task, tp, st, events, hit.index);
		const graphsDir = join(p.traces, "graphs");
		await mkdir(graphsDir, { recursive: true });
		const outFile = join(graphsDir, `${safeId(task.taskId)}.flow.txt`);
		await writeFile(outFile, `${out}\n`, "utf8");
		await traceTask(tp, "task.flow.read", { taskId: task.taskId, via: "command", events, index: hit.index });
		ctx.ui.notify(`${out}\n\n#${hit.index} ${task.taskId} (written to ${relative(ctx.cwd, outFile)})`.slice(0, 4000), "info");
		return;
	}

	if (cmd === "trace") {
		ctx.ui.notify(`Trace: ${relative(ctx.cwd, p.events)}`, "info");
		return;
	}

	if (cmd === "metrics") {
		if (currentAgentId() !== "root") {
			ctx.ui.notify("/swarm metrics is root-only", "warning");
			return;
		}
		const st = await readState(p, ctx.cwd);
		const proxy = st.proxyMetrics || { hungButAlive: 0, staleOpen: 0, supersessionChurn: 0 };
		ctx.ui.notify(
			`proxy metrics: hungButAlive=${proxy.hungButAlive} staleOpen=${proxy.staleOpen} supersessionChurn=${proxy.supersessionChurn}${proxy.lastEmitAt ? ` lastEmitAt=${proxy.lastEmitAt}` : ""}`,
			"info",
		);
		return;
	}

	if (cmd === "focus" || cmd === "auto-focus" || cmd === "focus-busy") {
		const sub = rest.shift()?.toLowerCase();
		if (sub === "status" || (!sub && cmd === "auto-focus")) {
			const info = await getFocusStatus(pi, ctx.cwd);
			ctx.ui.notify(formatFocusStatus(info), "info");
			return;
		}

		if (cmd === "focus" && (!sub || sub === "busy")) {
			const st = await readState(p, ctx.cwd);
			const target =
				pickNextBusyAgent(st) ||
				Object.values(st.agents || {}).find(
					(a) => a.id !== "root" && a.status === "running" && (a.runtimeStatus === "busy" || a.runtimeStatus === "tool_running"),
				) ||
				Object.values(st.agents || {}).find((a) => a.id !== "root" && a.status === "running");

			if (!target) {
				const info = await getFocusStatus(pi, ctx.cwd);
				ctx.ui.notify(formatFocusStatus(info), "info");
				return;
			}
			const res = await focusAgentWindow(pi, target, ctx.cwd);
			if (res.ok) {
				await withLock(p, async () => {
					const latestSt = await readState(p, ctx.cwd);
					latestSt.lastFocusAt = now();
					latestSt.lastFocusedAgentId = target.id;
					latestSt.updatedAt = now();
					await writeState(p, latestSt);
				});
				ctx.ui.notify(`Focused tmux to agent: ${target.id} (${res.target})`, "info");
			} else {
				ctx.ui.notify(`Failed to focus to ${target.id}: ${res.error}`, "warning");
			}
			return;
		}

		if (cmd === "focus" && sub && !["on", "off", "toggle", "enable", "disable"].includes(sub)) {
			const st = await readState(p, ctx.cwd);
			const target = st.agents[sub] || Object.values(st.agents || {}).find((a) => a.id.toLowerCase() === sub);
			if (!target) {
				ctx.ui.notify(`Unknown agent: ${sub}. Available agents: ${Object.keys(st.agents || {}).join(", ")}`, "warning");
				return;
			}
			const res = await focusAgentWindow(pi, target, ctx.cwd);
			if (res.ok) {
				await withLock(p, async () => {
					const latestSt = await readState(p, ctx.cwd);
					latestSt.lastFocusAt = now();
					latestSt.lastFocusedAgentId = target.id;
					latestSt.updatedAt = now();
					await writeState(p, latestSt);
				});
				ctx.ui.notify(`Focused tmux to agent: ${target.id} (${res.target})`, "info");
			} else {
				ctx.ui.notify(`Failed to focus to ${target.id}: ${res.error}`, "warning");
			}
			return;
		}

		let enabled: boolean;
		if (sub === "toggle") {
			const st = await readState(p, ctx.cwd);
			enabled = !isAutoFocusEnabled(st);
		} else if (["on", "enable", "true", "1"].includes(sub)) {
			enabled = true;
		} else if (["off", "disable", "false", "0"].includes(sub)) {
			enabled = false;
		} else {
			ctx.ui.notify("Usage: /swarm focus [agentId|busy|status] | /swarm auto-focus [on|off|toggle|status]", "warning");
			return;
		}

		await withLock(p, async () => {
			const st = await readState(p, ctx.cwd);
			st.autoFocusBusy = enabled;
			st.updatedAt = now();
			await writeState(p, st);
			await trace(p, "swarm.auto_focus.set", { enabled, by: currentAgentId() });
		});

		ctx.ui.notify(`Auto-focus busy pi: ${enabled ? "ENABLED" : "DISABLED"}`, "info");
		return;
	}
}
