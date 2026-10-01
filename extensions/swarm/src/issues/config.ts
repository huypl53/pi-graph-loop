// === swarm/issues/config.ts — issue-sequencer advancement resolution (advancement-mode) ===
// Single parse site for the advancement mode: env > .pi/swarm.yml > default "auto".
// Fail-fast on invalid values (never silently auto); absence preserves byte-identical behavior.
import { readSwarmYml } from "../config.ts";

export type IssueAdvancement = "auto" | "manual";

const VALID: ReadonlySet<string> = new Set(["auto", "manual"]);

function normalize(raw: unknown): IssueAdvancement | undefined {
	if (typeof raw !== "string") return undefined;
	const v = raw.toLowerCase().trim();
	return (VALID as Set<string>).has(v) ? (v as IssueAdvancement) : undefined;
}

function invalidErr(source: string, keyName: string, value: string): Error {
	return new Error(`Invalid ${keyName} "${value}" (use "auto" or "manual") — source: ${source}`);
}

/**
 * Resolve the issue advancement mode. Order (first match wins):
 *   1. env PI_SWARM_ISSUES_ADVANCEMENT ("auto" | "manual", case/space-insensitive)
 *   2. .pi/swarm.yml → issue-sequencer.advancement
 *   3. default "auto"
 * Throws on an invalid env/yml value (precise error naming the source); never falls through.
 */
export function resolveIssueAdvancement(cwd: string): IssueAdvancement {
	const envRaw = process.env.PI_SWARM_ISSUES_ADVANCEMENT;
	if (envRaw !== undefined && envRaw !== "") {
		const env = normalize(envRaw);
		if (!env) throw invalidErr("env", "PI_SWARM_ISSUES_ADVANCEMENT", envRaw);
		return env;
	}
	let cfg: Record<string, any> | null = null;
	try {
		cfg = readSwarmYml(cwd);
	} catch {
		cfg = null; // corrupt/absent yml defers to default; issues commands surface their own errors
	}
	const ymlRaw = (cfg as any)?.["issue-sequencer"]?.advancement;
	if (ymlRaw !== undefined && ymlRaw !== null && ymlRaw !== "") {
		const yml = normalize(ymlRaw);
		if (!yml) throw invalidErr("config", "issue-sequencer.advancement", String(ymlRaw));
		return yml;
	}
	return "auto";
}

/** The single advancement decision seam: advance automatically only in "auto" mode. */
export function shouldAutoAdvance(cwd: string): boolean {
	return resolveIssueAdvancement(cwd) === "auto";
}
