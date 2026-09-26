import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAgent, stopAgent } from "../agents.ts";
import { SWARM_GUEST_ID } from "../constants.ts";
import { expected } from "../errorlog.ts";
import { startRootPump } from "../hooks.ts";
import { claimRootLeader, ensureRoot } from "../identity.ts";
import { currentAgentId } from "../session.ts";
import { readState, trace, withLock, writeState } from "../state.ts";
import { currentPaneTarget, isHereToken, tmux } from "../tmux.ts";
import { applySwarmToolGating } from "../tools/gating.ts";
import type { Paths } from "../types.ts";
import { safeId } from "../utils.ts";
import { parseFlags } from "./parser.ts";

export async function handleRegisterCommand(
	rest: string[],
	ctx: any,
	p: Paths,
	pi: ExtensionAPI,
): Promise<void> {
	const tmuxTarget = rest.shift();
	const id = rest.shift();
	if (!tmuxTarget || !id) {
		ctx.ui.notify(
			"Adopt a tmux pane into the swarm:\n  /swarm register here <id> [role]            (this pane — no target needed)\n  /swarm register <target> <id> [role]         (another pane)\n  /swarm panes                                  (list targets)\ntarget = session:window.pane | session:window | %paneid | =session\nflags: --kind K --model M --provider P --no-inject",
			"warning",
		);
		return;
	}
	const flags = parseFlags(rest);
	const roleText = flags.rest.join(" ");
	const agentId = safeId(id);

	if (agentId === "root") {
		const isHere = isHereToken(tmuxTarget);
		let isCurrent = isHere;
		if (!isHere) {
			const cur = await currentPaneTarget(pi);
			if (cur) {
				let tpid = "";
				try {
					tpid = (await tmux(pi, ["display-message", "-p", "-t", tmuxTarget, "#{pane_id}"], 3_000)).trim();
				} catch (err: any) {
					expected("tmux_target_unresolvable", err);
				}
				isCurrent = Boolean(tpid) && tpid === cur.paneId;
			}
		}
		if (isCurrent) {
			const claim = await withLock(p, async () => {
				const st = await readState(p, ctx.cwd);
				return claimRootLeader(st, Date.now(), process.pid);
			});
			if (claim.kind === "denied") {
				ctx.ui.notify(
					`Root already active on pid ${claim.currentLeader.pid} (heartbeat ${Math.round(claim.ageMs / 1000)}s ago); this pane cannot become the PM.`,
					"warning",
				);
				await trace(p, "agent.root_optin.denied", { currentLeaderPid: claim.currentLeader.pid, ageMs: claim.ageMs });
				return;
			}
			process.env.PI_SWARM_IS_ROOT = "1";
			process.env.PI_SWARM_AGENT_ID = "root";
			applySwarmToolGating(pi);
			await withLock(p, async () => {
				const st = await readState(p, ctx.cwd);
				ensureRoot(st, ctx.cwd, p);
				await trace(p, "agent.root_optin", { via: "register-command", role: roleText || null });
				await writeState(p, st);
			});
			if (ctx.hasUI) ctx.ui.setStatus("swarm", "swarm:root");
			try {
				await startRootPump(ctx, "register-root");
			} catch (err: any) {
				await trace(p, "agent.root_optin.pump_failed", { error: String((err as Error)?.message || err) });
			}
			ctx.ui.notify(
				"This pane is now the swarm root (PM): root-scoped tools now act here, pending root mail has been surfaced, and the PM mailbox pump is active for this session.",
				"info",
			);
			return;
		}
		ctx.ui.notify(
			"The root is a human-driven coordinating role with no dedicated swarm pane — it cannot be attached to another pane. To make THIS pane the root (PM), run:\n  /swarm register here root [role]\nor relaunch pi with PI_SWARM_IS_ROOT=1.",
			"warning",
		);
		return;
	}

	const result = await withLock(p, async () => {
		const st = await readState(p, ctx.cwd);
		const r = await registerAgent(pi, ctx.cwd, p, st, {
			tmuxTarget,
			id,
			role: roleText || id,
			roleKind: flags.kind,
			model: flags.model,
			provider: flags.provider,
			inject: flags.inject,
		});
		await writeState(p, st);
		return r;
	});

	let adopted = false;
	if (result.agent.id !== "root") {
		let isCurrent = isHereToken(tmuxTarget);
		if (!isCurrent) {
			const cur = await currentPaneTarget(pi);
			if (cur) {
				let tpid = "";
				try {
					tpid = (await tmux(pi, ["display-message", "-p", "-t", result.agent.tmuxTarget, "#{pane_id}"], 3_000)).trim();
				} catch (err: any) {
					expected("tmux_target_unresolvable", err);
				}
				isCurrent = Boolean(tpid) && tpid === cur.paneId;
			}
		}
		if (isCurrent) {
			process.env.PI_SWARM_AGENT_ID = result.agent.id;
			applySwarmToolGating(pi);
			if (ctx.hasUI) ctx.ui.setStatus("swarm", `swarm:${result.agent.id}`);
			adopted = true;
			await trace(p, "agent.adopt_identity", {
				agentId: result.agent.id,
				via: isHereToken(tmuxTarget) ? "here" : "explicit",
				source: "command",
			});
		}
	}
	ctx.ui.notify(
		`Registered ${result.agent.id} at ${result.agent.tmuxTarget} (alive=${result.tmuxAlive} piRunning=${result.piRunning} injected=${result.injected})${adopted ? `; this pane is now '${result.agent.id}'` : ""}`,
		"info",
	);
}

export async function handleDeregisterCommand(
	rest: string[],
	ctx: any,
	p: Paths,
	pi: ExtensionAPI,
): Promise<void> {
	const flags = parseFlags(rest);
	const target = flags.rest.shift();
	if (!target) {
		ctx.ui.notify(
			"De-register a pi session from its swarm role (inverse of register; the pane stays alive):\n  /swarm deregister here            (this pane — self-service)\n  /swarm deregister <id>            (another agent — root-only)\nflags: --force (release active tasks) --purge (also remove the agent record + delivered ledger; mailbox/identity files stay)",
			"warning",
		);
		return;
	}
	const me = currentAgentId();
	let agentId: string | undefined = isHereToken(target) ? me : undefined;
	if (isHereToken(target) && (!agentId || agentId === SWARM_GUEST_ID)) {
		ctx.ui.notify(
			"Cannot resolve 'here' to a swarm agent in this pane. Register this pane first (for an agent: /swarm register here <id> [role]; for PM: /swarm register here root), or pass an explicit agent id.",
			"warning",
		);
		return;
	}
	if (!agentId) agentId = safeId(target);
	if (agentId === "root") {
		ctx.ui.notify(
			"The root (PM) role cannot be de-registered from inside a session — it is bound to the PM pane (env opt-in + root-leader claim + PM pump), not an adoptable agent record. Exit or stop the PM pane to end the role.",
			"warning",
		);
		return;
	}
	const self = me !== SWARM_GUEST_ID && me === agentId;
	if (!self && me !== "root") {
		ctx.ui.notify(
			"deregister is self-service for your own pane; deregistering another agent is root-only: run it in the PM session (PI_SWARM_IS_ROOT=1 or /swarm register here root)",
			"warning",
		);
		return;
	}
	let purged = false;
	const result = await withLock(p, async () => {
		const st = await readState(p, ctx.cwd);
		if (flags.purge) {
			if (!st.agents[agentId!]) throw new Error(`Unknown swarm agent: ${agentId}`);
		}
		const r = await stopAgent(pi, ctx.cwd, p, st, agentId!, { force: flags.force, killPane: false });
		if (flags.purge) {
			delete st.agents[agentId!];
			delete st.delivered[agentId!];
			purged = true;
		}
		await trace(p, "agent.deregister", {
			agentId,
			self,
			by: me,
			force: flags.force,
			purge: flags.purge,
			paneKilled: false,
		});
		await writeState(p, st);
		return r;
	});
	if (self) {
		delete process.env.PI_SWARM_AGENT_ID;
		applySwarmToolGating(pi);
		if (ctx.hasUI) ctx.ui.setStatus("swarm", `swarm:${SWARM_GUEST_ID}`);
	}
	ctx.ui.notify(
		`Deregistered ${result.agent.id}${purged ? " (record purged)" : " (record kept, marked stopped)"}; pane kept alive — this session is now an inert swarm guest. Re-register anytime with /swarm register here <id> [role].`,
		"info",
	);
}
