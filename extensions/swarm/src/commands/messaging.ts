import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { enqueueAndDeliver } from "../mailbox.ts";
import { currentAgentId } from "../session.ts";
import { mailboxPath, readState, trace, withLock, writeState } from "../state.ts";
import { isHereToken } from "../tmux.ts";
import type { Paths } from "../types.ts";
import { safeId } from "../utils.ts";
import { parseFlags } from "./parser.ts";

export async function handleMessagingCommand(
	cmd: "send" | "mailbox",
	rest: string[],
	ctx: any,
	p: Paths,
	pi: ExtensionAPI,
): Promise<void> {
	if (cmd === "send") {
		const to = rest.shift();
		const body = rest.join(" ");
		if (!to || !body) {
			ctx.ui.notify("Usage: /swarm send <to> <message>", "warning");
			return;
		}
		const { msg, delivery } = await enqueueAndDeliver(pi, ctx.cwd, p, { to, body });
		ctx.ui.notify(`Sent ${msg.id} to ${msg.to}. Injected: ${Boolean(delivery?.delivered)}`, "info");
		return;
	}

	if (cmd === "mailbox") {
		const sub = rest.shift();
		if (sub !== "reset") {
			ctx.ui.notify("Usage: /swarm mailbox reset <agent-id> --yes", "warning");
			return;
		}
		const flags = parseFlags(rest);
		const id = flags.rest[0];
		if (!id) {
			ctx.ui.notify("Usage: /swarm mailbox reset <agent-id|here> --yes", "warning");
			return;
		}
		const requestedId = id;
		const resolvedHere = isHereToken(requestedId) ? currentAgentId() : undefined;
		if (isHereToken(requestedId) && (!resolvedHere || resolvedHere === "swarm-guest")) {
			ctx.ui.notify(
				"Cannot resolve 'here' to a swarm agent mailbox in this pane. Register this pane first (for an agent: /swarm register here <id> [role]; for PM: /swarm register here root), or pass an explicit agent id.",
				"warning",
			);
			return;
		}
		const targetId = resolvedHere || requestedId;
		if (!flags.yes) {
			ctx.ui.notify(
				`Refusing mailbox reset for ${safeId(targetId)} without --yes. This command is intentionally human-initiated because it archives + clears the live mailbox and delivered ledger.`,
				"warning",
			);
			return;
		}
		const result = await withLock(p, async () => {
			const st = await readState(p, ctx.cwd);
			const agentId = safeId(targetId);
			const file = mailboxPath(p, agentId);
			if (!st.agents[agentId] && !existsSync(file)) throw new Error(`Unknown agent/mailbox ${agentId}`);
			const archiveDir = join(p.traces, "mailbox-resets");
			await mkdir(archiveDir, { recursive: true });
			const ts = Date.now();
			const archive = join(archiveDir, `${agentId}-${ts}.jsonl.bak`);
			let existed = false;
			let bytes = 0;
			let lines = 0;
			if (existsSync(file)) {
				existed = true;
				const raw = await readFile(file, "utf8");
				bytes = Buffer.byteLength(raw, "utf8");
				lines = raw ? raw.split(/\n/).filter((l) => l.length > 0).length : 0;
				await writeFile(archive, raw, "utf8");
			} else {
				await writeFile(archive, "", "utf8");
			}
			await writeFile(file, "", "utf8");
			const deliveredCleared = (st.delivered[agentId] || []).length;
			st.delivered[agentId] = [];
			await trace(p, "mailbox.reset", {
				agentId,
				via: "command",
				existed,
				bytes,
				lines,
				archive,
				deliveredCleared,
				by: currentAgentId(),
			});
			await writeState(p, st);
			return { agentId, file, archive, existed, bytes, lines, deliveredCleared };
		});
		ctx.ui.notify(
			`Mailbox reset for ${result.agentId}${isHereToken(requestedId) ? " (resolved from 'here')" : ""}. Archived ${result.lines} line(s) to ${relative(ctx.cwd, result.archive)}; cleared live mailbox ${relative(ctx.cwd, result.file)} and delivered ledger entries=${result.deliveredCleared}. If a session was stuck on parse errors, /reload or restart that pi session next.`,
			"warning",
		);
		return;
	}
}
