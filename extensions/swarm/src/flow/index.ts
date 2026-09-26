import type { TUI } from "@earendil-works/pi-tui";
import { expected } from "../errorlog.ts";
import { readState } from "../state.ts";
import type { Paths, TaskPaths, TaskState } from "../types.ts";
import { FlowDialog } from "./flow-dialog.ts";
import { buildPickerEntries, PickerDialog, resolveTaskRefLocal } from "./picker-dialog.ts";
import type { FlowDialogOpts } from "./types.ts";
import { DEFAULT_EVENT_LIMIT, FLOW_OVERLAY_OPTIONS, PICKER_OVERLAY_OPTIONS } from "./types.ts";

export * from "./types.ts";
export * from "./tree.ts";
export * from "./formatting.ts";
export * from "./collectors.ts";
export * from "./rows.ts";
export * from "./flow-render.ts";
export * from "./picker-dialog.ts";
export { FlowDialog } from "./flow-dialog.ts";
export { PickerDialog } from "./picker-dialog.ts";

export async function pickFlowTask(ctx: any, cwd: string, p: Paths): Promise<{ task: TaskState; tp: TaskPaths } | undefined> {
	if (ctx.mode !== "tui" || !ctx.hasUI) {
		try {
			ctx.ui.notify("/swarm flow requires interactive (TUI) mode for the picker; falling back to text task listing.", "info");
		} catch (err: any) {
			expected("ui_unavailable", err);
		}
		return undefined;
	}
	try {
		const entries = await buildPickerEntries(p, cwd);
		if (!entries.length) {
			try {
				ctx.ui.notify("No tasks found — create one with swarm_create_task or /swarm graph.", "info");
			} catch (err: any) {
				expected("ui_unavailable", err);
			}
			return undefined;
		}
		const picked = await new Promise<string | undefined>((resolve) => {
			void ctx.ui
				.custom(
					(tui: TUI, theme: any, _kb: any, done: (v: unknown) => void) =>
						new PickerDialog(tui, theme, entries, (v) => {
							done(v);
							resolve(typeof v === "string" ? v : undefined);
						}),
					{ overlay: true, overlayOptions: PICKER_OVERLAY_OPTIONS as any },
				)
				.catch((err: any) => {
					try {
						ctx.ui.notify(`/swarm flow picker failed: ${String((err && err.message) || err)}`, "warning");
					} catch (notifyErr: any) {
						expected("ui_unavailable", notifyErr);
					}
					resolve(undefined);
				});
		});
		if (!picked) return undefined;
		const resolved = await resolveTaskRefLocal(p, picked);
		return resolved.hit ? { task: resolved.hit.task, tp: resolved.hit.tp } : undefined;
	} catch (err: any) {
		try {
			ctx.ui.notify(`/swarm flow picker failed: ${String((err && err.message) || err)}`, "warning");
		} catch (notifyErr: any) {
			expected("ui_unavailable", notifyErr);
		}
		return undefined;
	}
}

export async function openFlowPicker(ctx: any, cwd: string, p: Paths): Promise<void> {
	if (ctx.mode !== "tui" || !ctx.hasUI) {
		try {
			ctx.ui.notify("/swarm flow requires interactive (TUI) mode for the picker; falling back to text task listing.", "info");
		} catch (err: any) {
			expected("ui_unavailable", err);
		}
		return;
	}
	try {
		const entries = await buildPickerEntries(p, cwd);
		const picked = await new Promise<string | undefined>((resolve) => {
			void ctx.ui
				.custom(
					(tui: TUI, theme: any, _kb: any, done: (v: unknown) => void) =>
						new PickerDialog(tui, theme, entries, (v) => {
							done(v);
							resolve(typeof v === "string" ? v : undefined);
						}),
					{ overlay: true, overlayOptions: PICKER_OVERLAY_OPTIONS as any },
				)
				.catch((err: any) => {
					try {
						ctx.ui.notify(`/swarm flow picker failed: ${String((err && err.message) || err)}`, "warning");
					} catch (notifyErr: any) {
						expected("ui_unavailable", notifyErr);
					}
					resolve(undefined);
				});
		});
		if (picked) {
			const resolved = await resolveTaskRefLocal(p, picked);
			if (resolved.hit) await openFlowDialog(ctx, cwd, p, resolved.hit.task, resolved.hit.tp, {});
		}
	} catch (err: any) {
		try {
			ctx.ui.notify(`/swarm flow picker failed: ${String((err && err.message) || err)}`, "warning");
		} catch (notifyErr: any) {
			expected("ui_unavailable", notifyErr);
		}
	}
}

export async function openFlowDialog(
	ctx: any,
	cwd: string,
	p: Paths,
	task: TaskState,
	tp: TaskPaths,
	opts: FlowDialogOpts = {},
): Promise<void> {
	if (ctx.mode !== "tui" || !ctx.hasUI) {
		try {
			ctx.ui.notify("/swarm flow: dialog requires interactive (TUI) mode", "info");
		} catch (err: any) {
			expected("ui_unavailable", err);
		}
		return;
	}
	try {
		const st = await readState(p, cwd);
		await ctx.ui.custom(
			(tui: TUI, theme: any, _kb: any, done: (v: unknown) => void) =>
				new FlowDialog(tui, theme, { p, cwd, task, tp, st, eventLimit: opts.eventLimit || DEFAULT_EVENT_LIMIT }, done),
			{ overlay: true, overlayOptions: FLOW_OVERLAY_OPTIONS as any },
		);
	} catch (err: any) {
		try {
			ctx.ui.notify(`/swarm flow dialog failed: ${String((err && err.message) || err)}`, "warning");
		} catch (notifyErr: any) {
			expected("ui_unavailable", notifyErr);
		}
	}
}
