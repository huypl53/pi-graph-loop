// === swarm/commands/loop.ts — /swarm loop on|off|status (read-streak guard toggle) ===
// Task loop-read-streak-guard Phase 3 step 6. Pattern: commands/goal.ts (root-only gate +
// ctx.ui.notify warning). The toggle is persisted in the swarm state file and re-read fresh
// on EVERY guard event (M3 — never cached); `status` always reads the state file directly.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { currentAgentId } from "../session.ts";
import { readState, trace, withLock, writeState } from "../state.ts";
import type { Paths } from "../types.ts";
import { now } from "../utils.ts";

export async function handleLoopCommand(_cmd: "loop", rest: string[], ctx: any, p: Paths, _pi: ExtensionAPI): Promise<void> {
	const sub = (rest.shift() ?? "status").toLowerCase();
	if (sub === "status") {
		// Read-only: available to any registered swarm session, reads state file fresh.
		const st = await readState(p, ctx.cwd);
		const enabled = st.readStreakGuard?.enabled !== false;
		const streaks = st.readStreaks ?? {};
		const entries = Object.values(streaks);
		const lines = [
			`Read-streak guard: ${enabled ? "ON" : "OFF"}${st.readStreakGuard?.updatedAt ? ` (since ${st.readStreakGuard.updatedAt})` : " (default)"}`,
			`Tracked streaks: ${entries.length}`,
		];
		for (const s of entries.slice(0, 10)) {
			lines.push(
				`  ${s.agentId} @ ${s.taskId}: ${s.readCallCount} reads / ${Math.round(s.accumulatedActiveMs / 60_000)} min active, nudges ${s.nudges}/3${s.escalated ? ", escalated" : ""}`,
			);
		}
		ctx.ui.notify(lines.join("\n"), "info");
		return;
	}
	if (sub !== "on" && sub !== "off") {
		ctx.ui.notify("Usage: /swarm loop [on|off|status]", "warning");
		return;
	}
	if (currentAgentId() !== "root") {
		ctx.ui.notify("loop on|off is root-only: run it in the PM session (PI_SWARM_IS_ROOT=1 or /swarm register here root)", "warning");
		return;
	}
	const enabled = sub === "on";
	const updated = await withLock(p, async () => {
		const st = await readState(p, ctx.cwd);
		st.readStreakGuard = { enabled, updatedAt: now() };
		if (!enabled) {
			// Turning the guard OFF also clears tracked streaks (fresh start on re-enable).
			st.readStreaks = {};
		}
		await trace(p, "loop_streak.toggle", { enabled, via: "command" });
		await writeState(p, st);
		return st.readStreakGuard;
	});
	ctx.ui.notify(`Read-streak guard ${enabled ? "ON" : "OFF"} (updated ${updated.updatedAt}).`, "info");
}
