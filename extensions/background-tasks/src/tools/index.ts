// background-tasks/tools/index.ts — the five agent tools (design §5).
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool, truncateTail, truncateHead, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { paths, readState } from "../state.ts";
import { assertCwdContained, killTask, reconcile, scheduleKillEscalation, spawnTask } from "../lifecycle.ts";
import { sleep, textResult, trace } from "../utils.ts";
import type { BackgroundSettings, BackgroundTask, BgStatus } from "../types.ts";

const ICON: Record<BgStatus, string> = { pending: "…", running: "⏳", done: "✓", failed: "✗", killed: "◔", unknown: "?" };

function sessionId(): string | undefined {
	return process.env.PI_SESSION_ID;
}

function rowOf(t: BackgroundTask) {
	return {
		taskId: t.taskId,
		label: t.label,
		status: t.status,
		icon: ICON[t.status],
		pid: t.pid,
		startedAt: t.startedAt,
		endedAt: t.endedAt,
		exitCode: t.exitCode,
		ageSec: t.startedAt ? Math.round((Date.now() - new Date(t.startedAt).getTime()) / 1000) : undefined,
		logOut: t.logOut,
		logErr: t.logErr,
	};
}

export function registerTools(pi: ExtensionAPI, settings: BackgroundSettings) {
	// ---------- background_start ----------
	pi.registerTool(
		defineTool({
			name: "background_start",
			label: "Background Start",
			description:
				"Start a long-running shell command in the background. Returns immediately; the command keeps running (detached) while you continue working. Check it later with background_status / background_output.",
			promptGuidelines: [
				"Use `background_start` to launch a long-running command that keeps running while you continue working; check it later with `background_status`/`background_output`.",
			],
			parameters: Type.Object({
				command: Type.String({ description: "Shell command to run (used when shell:true, default true)." }),
				args: Type.Optional(Type.Array(Type.String(), { description: "Optional explicit argv when shell:false." })),
				cwd: Type.Optional(Type.String({ description: "Working directory; default project cwd. Must be inside the project." })),
				label: Type.Optional(Type.String({ description: "Human label for the task (derives the id)." })),
				env: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Extra env vars merged onto process.env." })),
				shell: Type.Optional(Type.Boolean({ description: "Run via sh -c (default true)." })),
				timeoutMs: Type.Optional(Type.Number({ description: "Optional auto-kill after N ms (enforced in a child watchdog)." })),
			}),
			async execute(_id, params, _signal, _onUpdate, ctx) {
				const cwd = ctx.cwd;
				const target = params.cwd ? await assertCwdContained(cwd, params.cwd) : cwd;
				const task = await spawnTask(
					cwd,
					settings,
					{
						command: params.command,
						args: params.args,
						cwd: target,
						label: params.label,
						env: params.env as Record<string, string> | undefined,
						shell: params.shell,
						timeoutMs: params.timeoutMs,
						spawnedBySession: sessionId(),
					},
					() => {},
				);
				return textResult(
					`Started background task ${task.taskId} (pid ${task.pid}, status ${task.status}). ` +
						`stdout: ${task.logOut} | stderr: ${task.logErr}. Check with background_status/background_output.`,
					{ task: rowOf(task) },
				);
			},
		}),
	);

	// ---------- background_status ----------
	pi.registerTool(
		defineTool({
			name: "background_status",
			label: "Background Status",
			description:
				"Status of one background task (by taskId) or all tasks when taskId is omitted. Optional status filter (running/done/failed/killed/pending/unknown) when listing. Lazily reconciles (reads exit markers, checks liveness) before returning.",
			promptGuidelines: [
				"Use `background_status` to check background tasks: one task by taskId, or all tasks when taskId is omitted (optional status filter).",
			],
			parameters: Type.Object({
				taskId: Type.Optional(Type.String({ description: "A specific task id. If omitted, lists all tasks." })),
				status: Type.Optional(
					StringEnum(["running", "done", "failed", "killed", "pending", "unknown"] as const, {
						description: "Filter; only valid when taskId is omitted.",
					}),
				),
			}),
			async execute(_id, params, _signal, _onUpdate, ctx) {
				const cwd = ctx.cwd;
				await reconcile(cwd, settings);
				const p = paths(cwd);
				const st = await readState(p, cwd);
				if (params.taskId) {
					const t = st.tasks[params.taskId];
					if (!t) throw new Error(`background task not found: ${params.taskId}`);
					return textResult(JSON.stringify({ task: rowOf(t) }, null, 2), { tasks: [rowOf(t)] });
				}
				let tasks = Object.values(st.tasks).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
				if (params.status) tasks = tasks.filter((t) => t.status === params.status);
				const rows = tasks.map(rowOf);
				return textResult(JSON.stringify({ count: rows.length, tasks: rows }, null, 2), { tasks: rows });
			},
		}),
	);

	// ---------- background_output ----------
	pi.registerTool(
		defineTool({
			name: "background_output",
			label: "Background Output",
			description:
				"Read captured stdout/stderr of a background task (bounded tail or head). For full logs, read the returned log path directly.",
			promptGuidelines: [
				"Use `background_output` to read the captured stdout/stderr of a background task (bounded tail/head); for full logs, `read` the returned log path.",
			],
			parameters: Type.Object({
				taskId: Type.String({ description: "Task id." }),
				stream: Type.Optional(
					StringEnum(["stdout", "stderr", "combined"] as const, { description: 'Which stream. Default "combined".' }),
				),
				tail: Type.Optional(Type.Number({ description: "Return the last N lines (default 50). Mutually exclusive with head." })),
				head: Type.Optional(Type.Number({ description: "Return the first N lines." })),
			}),
			async execute(_id, params, _signal, _onUpdate, ctx) {
				const cwd = ctx.cwd;
				const p = paths(cwd);
				const st = await readState(p, cwd);
				const t = st.tasks[params.taskId];
				if (!t) throw new Error(`background task not found: ${params.taskId}`);
				const wantHead = params.head !== undefined && params.head >= 0;
				const n = wantHead ? params.head! : params.tail ?? 50;
				const stream = params.stream ?? "combined";
				const readLog = async (rel: string) => {
					const file = join(cwd, rel);
					if (!existsSync(file)) return "";
					return readFile(file, "utf8").catch(() => "");
				};
				let text: string;
				if (stream === "combined") {
					text = (await readLog(t.logOut)) + (await readLog(t.logErr));
				} else {
					text = await readLog(stream === "stdout" ? t.logOut : t.logErr);
				}
				const lines = text.split("\n").filter((l) => !l.startsWith("[bg-task exited"));
				const slice = wantHead ? lines.slice(0, n) : lines.slice(-n);
				const bounded = (wantHead ? truncateHead : truncateTail)(slice.join("\n"), { maxLines: n, maxBytes: 50_000 });
				const out = bounded.truncated ? `${bounded.content}\n\n[truncated: ${bounded.outputLines}/${bounded.totalLines} lines]` : slice.join("\n");
				return textResult(
					JSON.stringify(
						{ taskId: t.taskId, status: t.status, stream, truncated: Boolean(bounded.truncated), logOut: t.logOut, logErr: t.logErr, text: out },
						null,
						2,
					),
					{ taskId: t.taskId, text: out, truncated: Boolean(bounded.truncated) },
				);
			},
		}),
	);

	// ---------- background_wait ----------
	pi.registerTool(
		defineTool({
			name: "background_wait",
			label: "Background Wait",
			description:
				"Block until a background task finishes or timeoutMs elapses (bounded, abortable). Polls liveness/marker. Honors cancellation. Returns final status + a tail of combined output.",
			promptGuidelines: [
				"Use `background_wait` only when you explicitly need to block for a background task to finish (bounded, abortable, returns final status + output tail).",
			],
			parameters: Type.Object({
				taskId: Type.String({ description: "Task id." }),
				timeoutMs: Type.Optional(Type.Number({ description: "Max time to wait in ms (default 30000; capped by config)." })),
			}),
			async execute(_id, params, signal, _onUpdate, ctx) {
				const cwd = ctx.cwd;
				const p = paths(cwd);
				const cap = Math.min(settings.waitMaxMs, Math.max(1000, params.timeoutMs ?? 30_000));
				const deadline = Date.now() + cap;
				const isTerm = (s: BgStatus) => s === "done" || s === "failed" || s === "killed" || s === "unknown";

				let last: BackgroundTask | undefined;
				const refresh = async () => {
					await reconcile(cwd, settings);
					const st = await readState(p, cwd);
					last = st.tasks[params.taskId];
				};
				await refresh();
				if (!last) throw new Error(`background task not found: ${params.taskId}`);

				while (last && !isTerm(last.status)) {
					if (signal?.aborted) break;
					if (Date.now() >= deadline) break;
					await sleep(settings.waitPollMs);
					await refresh();
				}
				const aborted = Boolean(signal?.aborted);
				const timedOut = !aborted && Date.now() >= deadline && !!last && !isTerm(last.status);

				// tail of combined output
				let tailText = "";
				if (last) {
					const readLog = async (rel: string) => {
						const file = join(cwd, rel);
						if (!existsSync(file)) return "";
						return readFile(file, "utf8").catch(() => "");
					};
					const text = (await readLog(last.logOut)) + (await readLog(last.logErr));
					tailText = text
						.split("\n")
						.filter((l) => !l.startsWith("[bg-task exited"))
						.slice(-20)
						.join("\n");
				}
				await trace(p.events, "task.wait", { taskId: params.taskId, status: last?.status, timedOut, aborted });
				return textResult(
					JSON.stringify(
						{
							taskId: params.taskId,
							status: last?.status,
							exitCode: last?.exitCode,
							signal: last?.signal,
							endedAt: last?.endedAt,
							timedOut,
							aborted,
							tail: tailText,
						},
						null,
						2,
					),
					{ taskId: params.taskId, status: last?.status, timedOut, aborted },
				);
			},
		}),
	);

	// ---------- background_stop ----------
	pi.registerTool(
		defineTool({
			name: "background_stop",
			label: "Background Stop",
			description:
				"Stop a running background task by signaling its whole process group (SIGTERM, escalate to SIGKILL after grace). Only meaningful while the spawning pi is alive (relies on the live exit listener).",
			promptGuidelines: [
				"Use `background_stop` to terminate a running background task (SIGTERM its process group, escalate to SIGKILL after grace).",
			],
			parameters: Type.Object({
				taskId: Type.String({ description: "Task id." }),
				signal: Type.Optional(StringEnum(["SIGTERM", "SIGKILL"] as const, { description: 'Signal to send. Default "SIGTERM".' })),
				graceMs: Type.Optional(Type.Number({ description: "Grace before SIGKILL escalation (default from config)." })),
			}),
			async execute(_id, params, _signal, _onUpdate, ctx) {
				const cwd = ctx.cwd;
				const sig = (params.signal ?? "SIGTERM") as "SIGTERM" | "SIGKILL";
				const grace = params.graceMs ?? settings.stopGraceMs;
				const t = await killTask(cwd, params.taskId, sig, grace);
				if (sig === "SIGTERM") scheduleKillEscalation(t.pgid ?? t.pid, grace);
				return textResult(
					`Stopped background task ${t.taskId} (status ${t.status}, signal ${sig}).`,
					{ task: rowOf(t) },
				);
			},
		}),
	);
}
