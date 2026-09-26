import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { relative } from "node:path";
import { attachTarget, reloadIdentity, restartAgent, sendKeys, setAgentPaused, setAgentRole, spawnAgent, stopAgent } from "../agents.ts";
import { TRACE_AGENT_LEASE_CLEARED, TRACE_AGENT_LEASE_SET } from "../constants.ts";
import { expected, logSwarmError } from "../errorlog.ts";
import { overridePath } from "../identity.ts";
import { buildSwarmStatusSummary } from "../reconcile.ts";
import { currentAgentId } from "../session.ts";
import { identityPath, readState, readTaskState, taskPaths, trace, withLock, writeState } from "../state.ts";
import { listAllPanes } from "../tmux.ts";
import type { Paths } from "../types.ts";
import { now, safeId } from "../utils.ts";
import { parseFlags } from "./parser.ts";
import { handleDeregisterCommand, handleRegisterCommand } from "./registration.ts";

export async function handleAgentsCommand(cmd: string, rest: string[], ctx: any, p: Paths, pi: ExtensionAPI): Promise<void> {
	if (!cmd || cmd === "init") {
		const st = await withLock(p, async () => {
			const s = await readState(p, ctx.cwd);
			await trace(p, "swarm.init", { by: currentAgentId() });
			return s;
		});
		ctx.ui.notify(`Swarm ${st.swarmId} ready: ${relative(ctx.cwd, p.state)}`, "info");
		return;
	}

	if (cmd === "list") {
		const st = await readState(p, ctx.cwd);
		ctx.ui.notify(`Swarm ${st.swarmId}: ${Object.keys(st.agents).length} agents, tmux ${st.tmuxSession}`, "info");
		return;
	}

	if (cmd === "status") {
		const st = await readState(p, ctx.cwd);
		const { text, details } = await buildSwarmStatusSummary(p, st);
		await trace(p, "swarm.status", { by: currentAgentId(), details });
		ctx.ui.notify(text, "info");
		return;
	}

	if (cmd === "panes") {
		const panes = await listAllPanes(pi);
		if (!panes.length) {
			ctx.ui.notify("No tmux panes found", "info");
			return;
		}
		const lines = panes.map(
			(pn) =>
				`  ${pn.target.padEnd(20)} pid=${String(pn.pid).padEnd(7)} ${pn.currentCommand.padEnd(10)} ${pn.title} (${pn.width}x${pn.height})${pn.paneDead ? " [DEAD]" : ""}`,
		);
		ctx.ui.notify(`Tmux panes (${panes.length}):\n${lines.join("\n")}`, "info");
		return;
	}

	if (cmd === "spawn") {
		const id = rest.shift();
		const role = rest.join(" ") || undefined;
		if (!id) {
			ctx.ui.notify("Usage: /swarm spawn <id> [role]", "warning");
			return;
		}
		const agent = await withLock(p, async () => {
			const st = await readState(p, ctx.cwd);
			const a = await spawnAgent(pi, ctx.cwd, p, st, { id: safeId(id), role });
			await writeState(p, st);
			return a;
		});
		ctx.ui.notify(`Spawned ${agent.id} in window ${agent.tmuxTarget}`, "info");
		return;
	}

	if (cmd === "register") {
		await handleRegisterCommand(rest, ctx, p, pi);
		return;
	}

	if (cmd === "deregister") {
		await handleDeregisterCommand(rest, ctx, p, pi);
		return;
	}

	if (cmd === "stop") {
		const id = rest.shift();
		if (!id) {
			ctx.ui.notify("Usage: /swarm stop <id> [--force] [--no-kill]", "warning");
			return;
		}
		if (currentAgentId() !== "root") {
			ctx.ui.notify("stop is root-only: run it in the PM session (PI_SWARM_IS_ROOT=1 or /swarm register here root)", "warning");
			return;
		}
		const flags = parseFlags(rest);
		try {
			const result = await withLock(p, async () => {
				const st = await readState(p, ctx.cwd);
				const r = await stopAgent(pi, ctx.cwd, p, st, safeId(id), { force: flags.force, killPane: flags.kill });
				await writeState(p, st);
				return r;
			});
			ctx.ui.notify(`Stopped ${result.agent.id}: killed=${result.killed} method=${result.method}`, "info");
		} catch (err: any) {
			ctx.ui.notify(`Stop failed: ${err?.message || err}`, "warning");
		}
		return;
	}

	if (cmd === "restart") {
		const id = rest.shift();
		if (!id) {
			ctx.ui.notify("Usage: /swarm restart <id>", "warning");
			return;
		}
		try {
			const result = await withLock(p, async () => {
				const st = await readState(p, ctx.cwd);
				const r = await restartAgent(pi, ctx.cwd, p, st, safeId(id));
				await writeState(p, st);
				return r;
			});
			ctx.ui.notify(`Restarted ${result.agent.id} at ${result.agent.tmuxTarget} (kill=${result.kill.method})`, "info");
		} catch (err: any) {
			ctx.ui.notify(`Restart failed: ${err?.message || err}`, "warning");
		}
		return;
	}

	if (cmd === "role") {
		const id = rest.shift();
		if (!id) {
			ctx.ui.notify("Usage: /swarm role <id> <role...> [--kind K] [--caps a,b]", "warning");
			return;
		}
		const flags = parseFlags(rest);
		const caps = flags.caps
			? String(flags.caps)
					.split(",")
					.map((s) => s.trim())
					.filter(Boolean)
			: undefined;
		try {
			const result = await withLock(p, async () => {
				const st = await readState(p, ctx.cwd);
				const r = await setAgentRole(pi, ctx.cwd, p, st, safeId(id), {
					role: flags.rest.join(" ") || undefined,
					roleKind: flags.kind,
					capabilities: caps,
				});
				await writeState(p, st);
				return r;
			});
			ctx.ui.notify(
				`Set role for ${result.agent.id}: roleKind=${result.agent.roleKind} v${result.provenance.version} injected=${result.injected}`,
				"info",
			);
		} catch (err: any) {
			ctx.ui.notify(`Role change failed: ${err?.message || err}`, "warning");
		}
		return;
	}

	if (cmd === "pause" || cmd === "resume") {
		const id = rest.shift();
		if (!id) {
			ctx.ui.notify(`Usage: /swarm ${cmd} <id>`, "warning");
			return;
		}
		const paused = cmd === "pause";
		const agent = await withLock(p, async () => {
			const st = await readState(p, ctx.cwd);
			const a = setAgentPaused(st, safeId(id), paused);
			await writeState(p, st);
			return a;
		});
		ctx.ui.notify(`${agent.id} ${paused ? "paused" : "resumed"}`, "info");
		return;
	}

	if (cmd === "lease") {
		if (currentAgentId() !== "root") {
			ctx.ui.notify("lease is root-only: run it in the PM session (PI_SWARM_IS_ROOT=1 or /swarm register here root)", "warning");
			return;
		}
		const id = rest.shift();
		if (!id) {
			ctx.ui.notify("Usage: /swarm lease <id> [--reuse|--park] [--until <iso>] [--reason <text...>] [--clear]", "warning");
			return;
		}
		const clear = rest.includes("--clear");
		const out = await withLock(p, async () => {
			const st = await readState(p, ctx.cwd);
			const agent = st.agents[safeId(id)];
			if (!agent) throw new Error(`Unknown agent ${id}`);
			if (clear) {
				delete agent.leaseKind;
				delete agent.leaseUntil;
				delete agent.leaseReason;
				agent.updatedAt = now();
				await writeState(p, st);
				await trace(p, TRACE_AGENT_LEASE_CLEARED, { agentId: agent.id, by: "command" }).catch((err: any) => {
					expected("trace_failed", err);
				});
				return { cleared: true, agentId: agent.id };
			}
			const leaseKind: "reuse" | "park" = rest.includes("--park") ? "park" : "reuse";
			const untilFlagIdx = rest.indexOf("--until");
			const reasonFlagIdx = rest.indexOf("--reason");
			let leaseUntil = new Date(Date.now() + 3600_000).toISOString();
			if (untilFlagIdx >= 0 && rest[untilFlagIdx + 1]) {
				const parsed = new Date(rest[untilFlagIdx + 1]);
				if (isNaN(parsed.getTime())) throw new Error(`Invalid --until timestamp: ${rest[untilFlagIdx + 1]}`);
				leaseUntil = parsed.toISOString();
			}
			let leaseReason = "operator lease";
			if (reasonFlagIdx >= 0) {
				const afterReason = rest.slice(reasonFlagIdx + 1);
				const reasonEnd = afterReason.findIndex((a) => a.startsWith("--"));
				const tokens = reasonEnd >= 0 ? afterReason.slice(0, reasonEnd) : afterReason;
				if (tokens.length > 0) leaseReason = tokens.join(" ");
			}
			agent.leaseKind = leaseKind;
			agent.leaseUntil = leaseUntil;
			agent.leaseReason = leaseReason;
			agent.updatedAt = now();
			await writeState(p, st);
			await trace(p, TRACE_AGENT_LEASE_SET, { agentId: agent.id, leaseKind, leaseUntil, leaseReason, by: "command" }).catch(
				(err: any) => {
					expected("trace_failed", err);
				},
			);
			return { cleared: false, agentId: agent.id, leaseKind, leaseUntil, leaseReason };
		}).catch((err: any) => {
			return { failed: String((err as Error)?.message || err) };
		});
		if ("failed" in out) ctx.ui.notify(`Lease failed: ${out.failed}`, "warning");
		else if (out.cleared) ctx.ui.notify(`Cleared lease on ${out.agentId}`, "info");
		else ctx.ui.notify(`Set ${out.leaseKind} lease on ${out.agentId} until ${out.leaseUntil} (reason: ${out.leaseReason})`, "info");
		return;
	}

	if (cmd === "sendkey") {
		const id = rest.shift();
		if (!id) {
			ctx.ui.notify("Usage: /swarm sendkey <id> <keys...> [--literal] [--enter]", "warning");
			return;
		}
		const flags = parseFlags(rest);
		const keys = flags.rest.join(" ");
		if (!keys) {
			ctx.ui.notify("No keys given", "warning");
			return;
		}
		const st = await readState(p, ctx.cwd);
		const agent = st.agents[safeId(id)];
		if (!agent) {
			ctx.ui.notify(`Unknown agent ${id}`, "warning");
			return;
		}
		try {
			await sendKeys(pi, p, agent.tmuxTarget, keys, { literal: flags.literal, enter: flags.enter });
			ctx.ui.notify(`Sent keys to ${agent.id}`, "info");
		} catch (err: any) {
			ctx.ui.notify(`sendkey failed: ${err?.message || err}`, "warning");
		}
		return;
	}

	if (cmd === "attach") {
		const id = rest.shift();
		if (!id) {
			ctx.ui.notify("Usage: /swarm attach <id>", "warning");
			return;
		}
		const st = await readState(p, ctx.cwd);
		const agent = st.agents[safeId(id)];
		if (!agent) {
			ctx.ui.notify(`Unknown agent ${id}`, "warning");
			return;
		}
		const cmds = attachTarget(agent);
		ctx.ui.notify(`${cmds.attach}\n${cmds.selectWindow}\n${cmds.selectPane}`, "info");
		return;
	}

	if (cmd === "release") {
		const id = rest.shift();
		if (!id) {
			ctx.ui.notify("Usage: /swarm release <id> [<task-id>] [--force]", "warning");
			return;
		}
		if (currentAgentId() !== "root") {
			ctx.ui.notify("release is root-only: run it in the PM session (PI_SWARM_IS_ROOT=1 or /swarm register here root)", "warning");
			return;
		}
		const flags = parseFlags(rest);
		const taskId = flags.rest[0];
		let failed: string | null = null;
		const result = await withLock(p, async () => {
			const st = await readState(p, ctx.cwd);
			const agent = st.agents[safeId(id)];
			if (!agent) throw new Error(`Unknown agent ${id}`);
			const candidate = (agent.activeTaskIds || []).slice().filter((tid) => !taskId || tid === safeId(taskId));
			const removed: string[] = [];
			const refused: { taskId: string; status: string }[] = [];
			for (const tid of candidate) {
				let status = "unknown";
				const tp = taskPaths(p, tid);
				if (existsSync(tp.taskJson)) {
					try {
						status = (await readTaskState(tp.taskJson)).status;
					} catch (err: any) {
						await logSwarmError(ctx.cwd, "command", "task.status_read_failed", err, { taskId: tid });
					}
				}
				const terminal = status === "done" || status === "failed" || status === "cancelled" || status === "unknown";
				if (terminal || flags.force) {
					agent.activeTaskIds = agent.activeTaskIds.filter((t) => t !== tid);
					removed.push(tid);
				} else refused.push({ taskId: tid, status });
			}
			agent.updatedAt = now();
			await trace(p, "agent.release_task", { agentId: agent.id, via: "command", removed, refused, force: flags.force });
			await writeState(p, st);
			return { removed, refused };
		}).catch((err: any) => {
			failed = err?.message || String(err);
			return null;
		});
		if (failed) ctx.ui.notify(`Release failed: ${failed}`, "warning");
		else if (result) {
			ctx.ui.notify(
				`Released [${result.removed.join(",")}] from ${safeId(id)}; refused [${result.refused.map((r) => `${r.taskId}:${r.status}`).join(",")}]`,
				"info",
			);
		}
		return;
	}

	if (cmd === "identity") {
		const sub = rest.shift();
		const agentId = rest.shift();
		if (sub === "show") {
			if (!agentId) {
				ctx.ui.notify("Usage: /swarm identity show <agent-id>", "warning");
				return;
			}
			const st = await readState(p, ctx.cwd);
			const agent = st.agents[safeId(agentId)];
			if (!agent) {
				ctx.ui.notify(`Unknown agent ${agentId}`, "warning");
				return;
			}
			const file = identityPath(p, agent.id);
			const ov = overridePath(p, agent.id);
			const markdown = existsSync(file)
				? await readFile(file, "utf8")
				: "(no identity file yet; run /swarm identity reload <id> to generate it)";
			const head = `Identity ${agent.id} v${agent.identityVersion ?? "?"} hash=${(agent.identityHash || "").slice(0, 12) || "?"} loadedAt=${agent.identityLoadedAt || "?"} override=${existsSync(ov)}`;
			ctx.ui.notify(`${head}\n\n${markdown}`.slice(0, 4000), "info");
			return;
		}
		if (sub === "reload") {
			if (!agentId) {
				ctx.ui.notify("Usage: /swarm identity reload <agent-id> [note]", "warning");
				return;
			}
			const note = rest.join(" ") || undefined;
			const r = await reloadIdentity(pi, ctx.cwd, p, safeId(agentId), { note, source: "command" });
			ctx.ui.notify(
				`Reloaded ${r.agent.id}: v${r.provenance.version} hash=${r.provenance.shortHash} override=${r.provenance.overridePresent} tmuxAlive=${r.tmuxAlive} injected=${r.injected}`,
				"info",
			);
			return;
		}
		ctx.ui.notify("Usage: /swarm identity reload <agent-id> [note] | identity show <agent-id>", "warning");
		return;
	}
}
