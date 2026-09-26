import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { expected, logSwarmError } from "../errorlog.ts";
import { bumpSwapChain } from "../hooks.ts";
import {
	classifySwarmSettings,
	effectiveConfig,
	formatPreflightError,
	implicitSingletonPool,
	pickSlot,
	poolStatus,
	setSlotCooldown,
	slotKey,
	validateSwarmSettings,
} from "../pool.ts";
import { currentAgentId, currentModel, currentProvider } from "../session.ts";
import { readState, trace, withLock } from "../state.ts";
import type { ModelSlot, Paths, PreflightError } from "../types.ts";

export type RawShape = ReturnType<typeof classifySwarmSettings>;

export function classificationShape(validation: { ok: boolean; shape: RawShape }, classified: RawShape): RawShape {
	return validation.shape || classified;
}

export const POOL_HELP_TEXT = `Model pool configuration (canonical format: .pi/swarm.yaml)

# .pi/swarm.yaml
modelPool:
  - model: <your-model>
    provider: <your-provider>
    weight: 50
  - model: <fallback-model>
    provider: <fallback-provider>
    weight: 0                  # 0 = fallback-only (used when all weighted slots are benched)
rotation:
  strategy: weighted           # weighted | round-robin | sticky
  cooldownMs: 900000           # bench duration after maxRetries failures (15min)
  maxRetries: 2                # consecutive failures before bench

Slot fields
  model     required, non-empty string
  provider  optional; defaults to provider registry
  weight    non-negative number; default 1; 0 = fallback-only (used when all weighted slots are benched)

Rotation fields
  strategy     weighted | round-robin | sticky (default: weighted)
  cooldownMs   bench duration after maxRetries failures (default: 900000 = 15min)
  maxRetries   consecutive failures before bench (default: 2)

Singleton default (optional — used when no modelPool is declared):

# .pi/swarm.yaml
defaultModel: <your-model>
defaultProvider: <your-provider>

Configuration files:
  .pi/swarm.yaml (or .pi/swarm.yml) is the primary swarm configuration file.
  Legacy settings.json (under \`swarm\` or \`extensions.swarm\`) is also supported.
  Precedence: extensions.swarm > swarm (settings.json) > .pi/swarm.yaml / .pi/swarm.yml.
  Note: .pi/swarm.json is NOT supported.

Discover: /swarm pool show    Validate: /swarm pool validate    Preflight probe: /swarm pool preview-preflight
See: docs/swarm/operations.md (Model pool configuration)`;

export async function handlePoolCommand(cmd: "pool", rest: string[], ctx: any, p: Paths, pi: ExtensionAPI): Promise<void> {
	const sub = rest.shift();
	if (!sub || sub === "list") {
		const status = await poolStatus(p);
		if (!status.slots.length) {
			ctx.ui.notify("No model pool configured. Configure `modelPool` in .pi/swarm.yaml (or .pi/swarm.yml).", "warning");
			return;
		}
		const lines = [
			`Model pool (${status.rotation.strategy}, cooldown ${Math.round(status.rotation.cooldownMs / 60000)}min, maxRetries ${status.rotation.maxRetries}):`,
		];
		const anyRoles = status.slots.some((s) => Array.isArray(s.roles) && s.roles.length > 0);
		for (const s of status.slots) {
			const state = s.inCooldown ? `BENCHED ${Math.ceil(s.cooldownRemainingMs / 60000)}m` : "ok";
			const err = s.health?.lastError ? ` lastError=${s.health.lastError.slice(0, 60)}` : "";
			const rolesCol = anyRoles ? ` roles=[${(s.roles || []).join(",") || "(all)"}]` : "";
			lines.push(
				`  ${s.key.padEnd(34)} w=${String(s.weight ?? 1).padEnd(3)} ${state} failures=${s.health?.failures ?? 0}${rolesCol}${err}`,
			);
		}
		ctx.ui.notify(lines.join("\n"), "info");
		return;
	}
	if (sub === "cooldown" || sub === "clear") {
		const key = rest.shift();
		if (!key) {
			ctx.ui.notify("Usage: /swarm pool cooldown <provider/model> <ms> | /swarm pool clear <provider/model>", "warning");
			return;
		}
		if (sub === "cooldown") {
			const msRaw = rest.shift();
			if (!msRaw || !/^\d+$/.test(msRaw)) {
				ctx.ui.notify("Cooldown requires a duration in ms", "warning");
				return;
			}
			const ok = await setSlotCooldown(p, key, parseInt(msRaw, 10));
			ctx.ui.notify(
				ok ? `Slot ${key} cooldown set to ${msRaw}ms` : `Unknown slot key: ${key} (see /swarm pool list)`,
				ok ? "info" : "warning",
			);
		} else {
			const ok = await setSlotCooldown(p, key, null);
			ctx.ui.notify(ok ? `Slot ${key} cooldown cleared` : `Unknown slot key: ${key} (see /swarm pool list)`, ok ? "info" : "warning");
		}
		return;
	}
	if (sub === "show") {
		const validation = validateSwarmSettings();
		const shape = classificationShape(validation, classifySwarmSettings());
		const shapeSource = shape.kind === "empty" ? "defaults" : (shape as any).source || "defaults";
		const lines: string[] = [];
		const singleton = implicitSingletonPool();
		const status = await poolStatus(p);
		if (status.slots.length) {
			lines.push(
				`Model pool: configured (${status.slots.length} slot${status.slots.length === 1 ? "" : "s"}, source=${shapeSource})`,
			);
			for (const s of status.slots) {
				const state = s.inCooldown
					? `BENCHED ${Math.ceil(s.cooldownRemainingMs / 60000)}m`
					: s.weight === 0
						? "ok (fallback-only)"
						: "ok";
				const err = s.health?.lastError ? ` lastError=${s.health.lastError.slice(0, 60)}` : "";
				lines.push(`  ${s.key.padEnd(34)} w=${String(s.weight ?? 1).padEnd(3)} ${state} failures=${s.health?.failures ?? 0}${err}`);
				if (s.roles && s.roles.length) {
					lines.push(`    roles=[${s.roles.join(", ")}]`);
				}
			}
			lines.push(
				`Rotation: strategy=${status.rotation.strategy}, cooldown=${Math.round(status.rotation.cooldownMs / 60000)}min, maxRetries=${status.rotation.maxRetries}`,
			);
		} else {
			lines.push(`Model pool: not configured — using implicit singleton (source=${singleton.source})`);
			lines.push(
				`  ${singleton.slots[0].provider || "(default)"}/${singleton.slots[0].model}  weight=1  (fallback-only when pool is empty)`,
			);
			lines.push(`Rotation: not configured (strategy defaults to weighted)`);
		}
		lines.push("");
		lines.push("Discover config: /swarm pool help  |  Validate: /swarm pool validate");
		await trace(p, "pool.show", { by: currentAgentId(), shape: shape.kind, slots: status.slots.length, ok: validation.ok });
		ctx.ui.notify(lines.join("\n"), validation.ok ? "info" : "warning");
		return;
	}
	if (sub === "validate") {
		const v = validateSwarmSettings(ctx.cwd, { registryProbe: ctx.modelRegistry as any });
		const lines: string[] = [];
		if (v.ok) {
			lines.push("Config validation: PASSED");
			if (v.shape.kind === "empty") lines.push("  - No swarm config (using defaults).");
			else if (v.shape.kind === "singleton") {
				lines.push(
					`  - Singleton config: model=${(v.shape as any).defaultModel || "(unset)"}, provider=${(v.shape as any).defaultProvider || "(unset)"}`,
				);
			} else if (v.shape.kind === "explicit-pool") lines.push(`  - Explicit pool with ${(v.shape as any).slots} slot(s).`);
			else if (v.shape.kind === "both") lines.push(`  - Both: ${(v.shape as any).slots} pool slot(s) + singleton fallback.`);
			lines.push("  - No duplicates, all weights/cooldownMs/maxRetries are well-formed.");
			for (const w of v.warnings || []) lines.push(`  ! ${w.field || "config"}: ${w.message}`);
			await trace(p, "pool.validate", {
				by: currentAgentId(),
				ok: true,
				shape: v.shape.kind,
				warnings: (v.warnings || []).length,
			});
			ctx.ui.notify(lines.join("\n"), (v.warnings || []).length ? "warning" : "info");
		} else {
			lines.push(`Config validation: FAILED (${v.errors.length} issue${v.errors.length === 1 ? "" : "s"})`);
			for (const e of v.errors) lines.push(`  \u2717 ${e.field || "config"}: ${e.message}`);
			lines.push("");
			lines.push("Fix in .pi/swarm.yaml (or .pi/swarm.yml), then run /swarm pool validate again.");
			await trace(p, "pool.validate", { by: currentAgentId(), ok: false, shape: v.shape.kind, errors: v.errors.length });
			ctx.ui.notify(lines.join("\n"), "warning");
		}
		return;
	}
	if (sub === "help") {
		ctx.ui.notify(POOL_HELP_TEXT, "info");
		return;
	}
	if (sub === "preview-preflight" || sub === "preflight") {
		const { preflightSpawn } = await import("../pool.ts");
		const preflight = await preflightSpawn(p, {
			model: rest[0],
			provider: rest[1],
			tmuxSession: (await readState(p, ctx.cwd)).tmuxSession,
		});
		const lines: string[] = [];
		if (preflight.ok === true) {
			lines.push(`Preflight: PASSED`);
			lines.push(`  model=${preflight.resolved.model}`);
			lines.push(`  provider=${preflight.resolved.provider}`);
			lines.push(`  fromPool=${preflight.resolved.fromPool}`);
			ctx.ui.notify(lines.join("\n"), "info");
		} else {
			lines.push(`Preflight: FAILED`);
			lines.push(formatPreflightError((preflight as { ok: false; error: PreflightError }).error));
			ctx.ui.notify(lines.join("\n"), "warning");
		}
		return;
	}
	if (sub === "rotate") {
		if (currentAgentId() !== "root") {
			ctx.ui.notify("rotate is root-only: run it in the PM session (PI_SWARM_IS_ROOT=1 or /swarm register here root)", "warning");
			return;
		}
		const action = rest.shift();
		if (action !== "now" && action !== "next") {
			ctx.ui.notify(
				"Usage: /swarm pool rotate now | /swarm pool rotate next\n  rotate: now (force-swap current agent) | next (bench current slot, let next pick skip)",
				"warning",
			);
			return;
		}
		const { slots, rotation } = effectiveConfig();
		if (!slots.length) {
			ctx.ui.notify("No model pool configured. Configure `modelPool` in .pi/swarm.yaml (or .pi/swarm.yml).", "warning");
			return;
		}
		const agentId = currentAgentId();
		const currentModelId = ctx.model?.id || currentModel();
		const currentProviderId = ctx.model?.provider && ctx.model.provider.trim() ? ctx.model.provider : currentProvider(currentModelId);
		if (!currentModelId) {
			await trace(p, "pool.manual_rotate_no_current_slot", { agentId, action, reason: "ctx.model.id is empty" }).catch((err: any) => {
				expected("trace_failed", err);
			});
			ctx.ui.notify(
				"Cannot determine the current slot from ctx.model. This pane is not running on a model pool slot — nothing to rotate.",
				"warning",
			);
			return;
		}
		const currentSlot: ModelSlot = { model: currentModelId, provider: currentProviderId };
		if (action === "now") {
			const picked = await pickSlot(p, {
				stickyKey: agentId,
				avoidKey: slotKey(currentSlot),
				bypassRolesFilter: true,
			}).catch((err: any) => {
				expected("pick_slot_failed", err);
				return undefined;
			});
			if (!picked) {
				await trace(p, "pool.manual_rotate_no_alternative", {
					agentId,
					from: slotKey(currentSlot),
					action: "now",
				}).catch((err: any) => {
					expected("trace_failed", err);
				});
				ctx.ui.notify(
					"No healthy alternative slot. All eligible slots are benched — /swarm pool list to see, or /swarm pool clear <provider/model> to unbench.",
					"warning",
				);
				return;
			}
			const target = picked.slot.provider ? ctx.modelRegistry?.find?.(picked.slot.provider, picked.slot.model) : undefined;
			if (!target) {
				await trace(p, "pool.manual_rotate_model_not_found", {
					agentId,
					slot: slotKey(picked.slot),
					action: "now",
					hint: picked.slot.provider
						? "model not registered under the slot's provider"
						: "pool slot has no explicit provider; add one in .pi/swarm.yaml modelPool",
				}).catch((err: any) => {
					expected("trace_failed", err);
				});
				ctx.ui.notify(
					`Manual rotate refused: picked slot ${slotKey(picked.slot)} has no resolvable model registry entry. /swarm pool list to inspect.`,
					"warning",
				);
				return;
			}
			const okSwap = await pi.setModel(target).catch((err: any) => {
				expected("set_model_failed", err);
				return false;
			});
			if (!okSwap) {
				await trace(p, "pool.swap_failed", {
					agentId,
					from: slotKey(currentSlot),
					to: slotKey(picked.slot),
					kind: "manual_override",
					reason: picked.reason,
					target: `${target.provider}/${target.id}`,
				}).catch((err: any) => {
					expected("trace_failed", err);
				});
				ctx.ui.notify(`Manual rotate failed: setModel refused for ${target.provider}/${target.id}.`, "warning");
				return;
			}
			await trace(p, "pool.swap_forced_by_manual_override", {
				agentId,
				from: slotKey(currentSlot),
				to: slotKey(picked.slot),
				reason: picked.reason,
				target: `${target.provider}/${target.id}`,
				rolesIgnored: true,
				agentRoleKind:
					(await withLock(p, async () => {
						const st = await readState(p, ctx.cwd);
						return st.agents[agentId]?.roleKind;
					}).catch((err: any) => {
						expected("read_state_failed", err);
						return undefined;
					})) ?? null,
			}).catch((err: any) => {
				expected("trace_failed", err);
			});
			bumpSwapChain(agentId);
			pi.sendMessage(
				{
					customType: "swarm-message",
					content: `[PI-SWARM MODEL POOL] Operator forced manual rotation: previous slot ${slotKey(currentSlot)} was swapped to ${slotKey(picked.slot)} (bypassing engine-retry gate). Your context and mailbox are intact. Continue your current task on the new model.`,
					display: true,
				},
				ctx.isIdle?.() ? { triggerTurn: true } : { deliverAs: "followUp" },
			);
			ctx.ui.notify(
				`Manual rotation: ${slotKey(currentSlot)} -> ${slotKey(picked.slot)} (gate bypassed; reason: ${picked.reason}).`,
				"info",
			);
			return;
		}
		await setSlotCooldown(p, slotKey(currentSlot), rotation.cooldownMs);
		await trace(p, "pool.bench_forced_by_manual_override", {
			agentId,
			slot: slotKey(currentSlot),
			cooldownMs: rotation.cooldownMs,
		}).catch((err: any) => {
			expected("trace_failed", err);
		});
		ctx.ui.notify(
			`Bench forced: ${slotKey(currentSlot)} is now benched for ${Math.round(rotation.cooldownMs / 60000)}min. Next auto-swap/pickSlot will skip it; current model remains for this turn.`,
			"info",
		);
		return;
	}
	ctx.ui.notify(
		"Usage: /swarm pool [list|show|validate|help|preview-preflight|rotate] | /swarm pool cooldown <provider/model> <ms> | /swarm pool clear <provider/model> | /swarm pool rotate now | /swarm pool rotate next",
		"warning",
	);
}
