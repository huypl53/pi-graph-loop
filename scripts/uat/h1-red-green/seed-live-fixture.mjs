#!/usr/bin/env node
/** Seed/assert the disposable project used by the H1 interactive mock-LLM lane. */
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { resolve, join, dirname, relative, sep, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const mode = process.argv[2];
const targetArg = process.argv[3];
if (!targetArg?.trim() || !["seed", "assert"].includes(mode)) {
	console.error("Usage: node seed-live-fixture.mjs <seed|assert> <repo/.pi/swarm-uat/runs/<run>/project>");
	process.exit(2);
}
const project = resolve(targetArg);
const repoRoot = resolve(here, "../../..");
const safeRunsRoot = resolve(repoRoot, ".pi", "swarm-uat", "runs");

function assertDisposableProjectTarget() {
	if (project === repoRoot || project === resolve(process.cwd())) {
		throw new Error("refusing to use the repository root or current working directory as the disposable project");
	}
	const relativeTarget = relative(safeRunsRoot, project);
	if (!relativeTarget || relativeTarget === ".." || relativeTarget.startsWith(`..${sep}`) || isAbsolute(relativeTarget)) {
		throw new Error(`target must be a child of ${safeRunsRoot}`);
	}
	if (!existsSync(safeRunsRoot) || !existsSync(dirname(project))) {
		throw new Error(`create the UAT run parent under ${safeRunsRoot} before seeding`);
	}
	const canonicalRunsRoot = realpathSync(safeRunsRoot);
	const canonicalParent = realpathSync(dirname(project));
	const relativeParent = relative(canonicalRunsRoot, canonicalParent);
	if (relativeParent === ".." || relativeParent.startsWith(`..${sep}`) || isAbsolute(relativeParent)) {
		throw new Error("target parent resolves outside the disposable UAT runs directory");
	}
	if (existsSync(project)) {
		if (lstatSync(project).isSymbolicLink()) throw new Error("refusing a symlink as the disposable project target");
		const canonicalProject = realpathSync(project);
		const relativeProject = relative(canonicalRunsRoot, canonicalProject);
		if (!relativeProject || relativeProject === ".." || relativeProject.startsWith(`..${sep}`) || isAbsolute(relativeProject)) {
			throw new Error("target resolves outside the disposable UAT runs directory");
		}
	}
}

try {
	assertDisposableProjectTarget();
} catch (error) {
	console.error(`Refusing unsafe disposable-project target: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(2);
}

const stateFile = join(project, ".pi/swarm/swarm-state.json");
const assignmentId = "msg-assign-d1";
const nudgeId = "msg-nudge-d1";
const conversationId = "task:h1-task:implement";

if (mode === "seed") {
	mkdirSync(project, { recursive: true });
	process.env.PI_SWARM_AGENT_ID = "root";
	process.env.PI_SWARM_IS_ROOT = "1";
	const { paths, ensureDirs, defaultState, writeState } = await import(join(here, "../../../extensions/swarm/src/state.ts"));
	const { ensureRoot } = await import(join(here, "../../../extensions/swarm/src/identity.ts"));
	const p = paths(project);
	await ensureDirs(p);
	const state = defaultState(project);
	ensureRoot(state, project, p);
	const ts = new Date().toISOString();
	state.agents.root.tmuxTarget = "unknown";
	state.agents["worker-x"] = {
		id: "worker-x",
		role: "worker",
		roleKind: "worker",
		capabilities: [],
		activeTaskIds: [],
		maxConcurrentTasks: 1,
		status: "running",
		runtimeStatus: "idle",
		health: "healthy",
		tmuxSession: "h1-live-fixture",
		tmuxWindow: "worker",
		tmuxTarget: "unknown",
		cwd: project,
		mailbox: ".pi/swarm/mailboxes/worker-x.jsonl",
		createdAt: ts,
		updatedAt: ts,
		lastHeartbeatAt: ts,
		lastSessionStartAt: ts,
	};
	state.messages[assignmentId] = {
		id: assignmentId,
		from: "root",
		to: "worker-x",
		status: "injected",
		createdAt: ts,
		updatedAt: ts,
		injectedAt: ts,
		attempts: 1,
		requiresAck: true,
		requiresResponse: true,
		conversationId,
		subject: "Task h1-task / node implement assigned",
		response: { status: "missing", missingAt: ts },
	};
	state.messages[nudgeId] = {
		id: nudgeId,
		from: "root",
		to: "worker-x",
		status: "injected",
		createdAt: ts,
		updatedAt: ts,
		injectedAt: ts,
		attempts: 1,
		requiresAck: true,
		requiresResponse: true,
		conversationId,
		replyTo: assignmentId,
		subject: "ARTIFACT-PROGRESS: close h1-task:implement now",
		response: { status: "missing", missingAt: ts },
	};
	state.delivered["worker-x"] = [assignmentId, nudgeId];
	await writeState(p, state);
	console.log(`seeded ${stateFile}`);
	process.exit(0);
}

const state = JSON.parse(readFileSync(stateFile, "utf8"));
const assignment = state.messages?.[assignmentId];
const nudge = state.messages?.[nudgeId];
const passed = assignment?.response?.status === "verified" && nudge?.response?.status === "verified";
console.log(
	JSON.stringify(
		{
			result: passed ? "PASS" : "FAIL",
			assignment: assignment?.response?.status ?? null,
			nudge: nudge?.response?.status ?? null,
			assignmentReply: assignment?.response?.resultMessageId ?? null,
			nudgeReply: nudge?.response?.resultMessageId ?? null,
		},
		null,
		2,
	),
);
process.exit(passed ? 0 : 1);
