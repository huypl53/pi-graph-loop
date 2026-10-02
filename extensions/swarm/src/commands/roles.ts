// === /swarm roles (task-role-playbooks) =======================================
// Read-only command surface for the role playbook config: lists each role's
// playbook path (bundled/custom), the config layer that contributed it, the
// charter source, and whether the file currently exists on disk.
import { existsSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readRolesConfig, validateRolesConfig } from "../config.ts";
import { trace } from "../state.ts";
import type { Paths } from "../types.ts";

export async function handleRolesCommand(rest: string[], ctx: any, p: Paths, pi: ExtensionAPI): Promise<void> {
	void rest; // reserved for future subcommands
	const rc = readRolesConfig(ctx.cwd, { freshGlobal: true });
	const validation = validateRolesConfig(ctx.cwd, { freshGlobal: true });
	const lines: string[] = [];

	if (rc.charter.path) {
		const exists = existsSync(rc.charter.path);
		lines.push(`Charter: ${rc.charter.path}${exists ? "" : " (MISSING — falls back to embedded default)"}`);
	} else {
		lines.push(`Charter: (embedded ROLE_CHARTER_DEFAULT — cấu hình "không sai > đẹp")`);
	}
	lines.push("");

	for (const kind of Object.keys(rc.roles)) {
		const conf = rc.roles[kind];
		const filePath = conf?.path || "(none)";
		const sourceLabel = conf?.source === "project.swarm.yml" ? "project yml" : conf?.source === "global" ? "global yml" : "default";
		const exists = existsSync(filePath);
		const bullet = validation.length === 0 || !validation.some((e) => e.field === `roles.${kind}`) ? "✓" : "✗";
		lines.push(`${bullet} ${kind.padEnd(13)} ${filePath} [${sourceLabel}]${exists ? "" : " (MISSING)"}`);
	}

	if (validation.length > 0) {
		lines.push("");
		lines.push(`Validation errors (${validation.length}):`);
		for (const e of validation) {
			lines.push(`  ✗ ${e.field || "config"}: ${e.message}`);
		}
	} else {
		lines.push("");
		lines.push("All role playbooks resolved. Configure via `roles:` in .pi/swarm.yml (see docs/swarm/tools.md#configuration).");
	}

	await trace(p, "roles.show", { by: "command", errors: validation.length, charterPath: rc.charter.path }).catch(async (err) => {
		await logSwarmErrorErr(p, err);
	});
	ctx.ui.notify(lines.join("\n"), validation.length ? "warning" : "info");
	return;
}

async function logSwarmErrorErr(p: Paths, err: unknown) {
	const { logSwarmError } = await import("../errorlog.ts");
	await logSwarmError(p, "commands", "roles.trace_failed", err);
}
