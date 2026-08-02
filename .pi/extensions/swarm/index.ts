import { Type } from "typebox";
import { defineTool, CONFIG_DIR_NAME, truncateHead, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, writeFile, appendFile, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { randomUUID } from "node:crypto";

const EXT = "swarm";
const STATE_VERSION = 1;
const LOCK_STALE_MS = 60_000;
const SEND_SETTLE_MS = 700;
const SPAWN_SETTLE_MS = 2_500;
const SYSTEM_START = "[PI-SWARM SYSTEM MESSAGE]";
const SYSTEM_END = "[/PI-SWARM SYSTEM MESSAGE]";

type AgentStatus = "running" | "stopped" | "unknown";
type MessageStatus = "queued" | "injected" | "intercepted" | "acked" | "failed" | "dead_letter";

type MessageRecord = {
	id: string;
	from: string;
	to: string;
	status: MessageStatus;
	createdAt: string;
	updatedAt: string;
	queuedAt?: string;
	injectedAt?: string;
	interceptedAt?: string;
	ackedAt?: string;
	failedAt?: string;
	attempts: number;
	requiresAck: boolean;
	conversationId?: string;
	replyTo?: string;
	lastError?: string;
	lastAck?: { by: string; status: string; note?: string; resultMessageId?: string; at: string };
	ttlMs?: number;
	idempotencyKey?: string;
};

type SwarmAgent = {
	id: string;
	role: string;
	status: AgentStatus;
	tmuxSession: string;
	tmuxWindow: string;
	tmuxTarget: string;
	model: string;
	provider: string;
	cwd: string;
	mailbox: string;
	createdAt: string;
	updatedAt: string;
};

type SwarmState = {
	version: number;
	swarmId: string;
	cwd: string;
	tmuxSession: string;
	agents: Record<string, SwarmAgent>;
	delivered: Record<string, string[]>;
	messages: Record<string, MessageRecord>;
	createdAt: string;
	updatedAt: string;
};

type SwarmMessage = {
	id: string;
	swarmId: string;
	from: string;
	to: string;
	subject?: string;
	priority: string;
	type: "swarm.message";
	schemaVersion: number;
	createdAt: string;
	body: string;
	conversationId?: string;
	replyTo?: string;
	requiresAck: boolean;
	ttlMs?: number;
	idempotencyKey?: string;
	headers: Record<string, string>;
};

type Paths = {
	root: string;
	state: string;
	lock: string;
	mailboxes: string;
	agentsDir: string;
	traces: string;
	tmuxTraces: string;
	events: string;
};

function now() {
	return new Date().toISOString();
}

function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeId(input: string) {
	const out = input.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
	return out || `agent-${randomUUID().slice(0, 8)}`;
}

function projectSlug(cwd: string) {
	return safeId(cwd.split("/").filter(Boolean).pop() || "project").slice(0, 30);
}

function paths(cwd: string): Paths {
	const root = join(cwd, CONFIG_DIR_NAME, EXT);
	return {
		root,
		state: join(root, "swarm-state.json"),
		lock: join(root, "swarm-state.lock"),
		mailboxes: join(root, "mailboxes"),
		agentsDir: join(root, "agents"),
		traces: join(root, "traces"),
		tmuxTraces: join(root, "traces", "tmux"),
		events: join(root, "traces", "events.jsonl"),
	};
}

async function ensureDirs(p: Paths) {
	await mkdir(p.mailboxes, { recursive: true });
	await mkdir(p.agentsDir, { recursive: true });
	await mkdir(p.tmuxTraces, { recursive: true });
}

async function withLock<T>(p: Paths, fn: () => Promise<T>): Promise<T> {
	await mkdir(dirname(p.lock), { recursive: true });
	const started = Date.now();
	while (true) {
		try {
			await mkdir(p.lock);
			break;
		} catch (err: any) {
			if (err?.code !== "EEXIST") throw err;
			try {
				const s = await stat(p.lock);
				if (Date.now() - s.mtimeMs > LOCK_STALE_MS) await rm(p.lock, { recursive: true, force: true });
			} catch {}
			if (Date.now() - started > LOCK_STALE_MS * 2) throw new Error(`Timed out acquiring swarm lock: ${p.lock}`);
			await sleep(80);
		}
	}
	try {
		return await fn();
	} finally {
		await rm(p.lock, { recursive: true, force: true });
	}
}

function defaultState(cwd: string): SwarmState {
	const swarmId = `swarm-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${randomUUID().slice(0, 6)}`;
	const ts = now();
	return {
		version: STATE_VERSION,
		swarmId,
		cwd,
		tmuxSession: `pi-swarm-${projectSlug(cwd)}-${swarmId.slice(-6)}`,
		agents: {},
		delivered: {},
		messages: {},
		createdAt: ts,
		updatedAt: ts,
	};
}

async function readState(p: Paths, cwd: string): Promise<SwarmState> {
	await ensureDirs(p);
	if (!existsSync(p.state)) {
		const st = defaultState(cwd);
		await writeFile(p.state, `${JSON.stringify(st, null, 2)}\n`, "utf8");
		return st;
	}
	const st = JSON.parse(await readFile(p.state, "utf8")) as SwarmState;
	st.messages ||= {};
	st.delivered ||= {};
	st.agents ||= {};
	return st;
}

async function writeState(p: Paths, state: SwarmState) {
	state.updatedAt = now();
	await writeFile(p.state, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function appendJsonl(file: string, value: unknown) {
	await mkdir(dirname(file), { recursive: true });
	await appendFile(file, `${JSON.stringify(value)}\n`, "utf8");
}

async function trace(p: Paths, event: string, data: Record<string, unknown> = {}) {
	await appendJsonl(p.events, { ts: now(), event, ...data });
}

function upsertMessageRecord(state: SwarmState, msg: SwarmMessage, status: MessageStatus, patch: Partial<MessageRecord> = {}) {
	const ts = now();
	const prev = state.messages[msg.id];
	state.messages[msg.id] = {
		id: msg.id,
		from: msg.from,
		to: msg.to,
		createdAt: prev?.createdAt || msg.createdAt,
		queuedAt: prev?.queuedAt,
		attempts: prev?.attempts ?? 0,
		requiresAck: msg.requiresAck,
		conversationId: msg.conversationId,
		replyTo: msg.replyTo,
		lastError: prev?.lastError,
		lastAck: prev?.lastAck,
		ttlMs: msg.ttlMs,
		idempotencyKey: msg.idempotencyKey,
		...prev,
		...patch,
		status,
		updatedAt: ts,
	};
}

function currentAgentId() {
	return process.env.PI_SWARM_AGENT_ID || "orchestrator";
}

function currentModel() {
	return process.env.PI_SWARM_DEFAULT_MODEL || "glm-4.5";
}

function currentProvider() {
	return process.env.PI_SWARM_DEFAULT_PROVIDER || "zai-coding-cn";
}

function childPiArgs() {
	// Default keeps spawned agents in the same trusted project so they discover project extensions/skills.
	// Tests or unusual projects can override, e.g. PI_SWARM_CHILD_ARGS="--approve --no-extensions -e .pi/extensions/swarm/index.ts".
	return process.env.PI_SWARM_CHILD_ARGS || "--approve";
}

function mailboxPath(p: Paths, agentId: string) {
	return join(p.mailboxes, `${safeId(agentId)}.jsonl`);
}

function identityPath(p: Paths, agentId: string) {
	return join(p.agentsDir, `${safeId(agentId)}.md`);
}

function buildIdentityMarkdown(state: SwarmState, agent: SwarmAgent) {
	return `# Swarm Agent Identity: ${agent.id}\n\n` +
		`> This file is generated by the pi swarm extension. It is the durable role/identity card for this agent.\n\n` +
		`## Identity\n\n` +
		`- Agent ID: \`${agent.id}\`\n` +
		`- Role: ${agent.role}\n` +
		`- Swarm ID: \`${state.swarmId}\`\n` +
		`- Model: \`${agent.provider}/${agent.model}\`\n` +
		`- CWD: \`${agent.cwd}\`\n` +
		`- Tmux target: \`${agent.tmuxTarget}\`\n` +
		`- Mailbox: \`${agent.mailbox}\`\n\n` +
		`## Operating Protocol\n\n` +
		`1. Treat this identity file as your role-specific AGENT.md.\n` +
		`2. Coordinate with peers using \`swarm_send_message\`; do not ask the human to relay swarm traffic.\n` +
		`3. Check your mailbox with \`swarm_check_mailbox\` when idle or after receiving swarm traffic. Here, idle means you have no active tool calls or immediate task steps; if you are waiting more than ~10 seconds, poll pending mailbox messages.\n` +
		`4. Use \`swarm_list_agents\` before messaging a peer whose existence you have not verified.\n` +
		`5. Use \`swarm_trace\` and \`swarm_capture_agent_pane\` when debugging coordination issues.\n` +
		`6. Stay within your role unless the orchestrator explicitly changes your assignment.\n\n` +
		`## Lifecycle\n\n` +
		`- Start by reading this identity when role details are unclear.\n` +
		`- If an initial task is present, begin it after reading identity; do not wait indefinitely for another instruction.\n` +
		`- If no task is present, poll your mailbox periodically and remain available until the orchestrator stops or reassigns you.\n` +
		`- Report completion, blockers, and role conflicts to the coordinating agent named in your task or to the orchestrator.\n\n` +
		`## Peer Discovery\n\n` +
		`- Use \`swarm_list_agents\` to verify peer IDs and tmux targets.\n` +
		`- Use \`swarm_agent_identity\` to inspect your own or a peer's durable role card.\n` +
		`- If a target peer does not exist, report the missing peer instead of repeatedly sending messages.\n\n` +
		`## Review Expectations\n\n` +
		`- Be explicit about findings, risks, assumptions, and evidence paths.\n` +
		`- Prefer small, verifiable messages over large unstructured dumps.\n` +
		`- If a requested action conflicts with this identity, explain the conflict and ask for reassignment.\n`;
}

function identityPrompt(cwd: string, identityRelPath: string) {
	return `\n\n[PI-SWARM IDENTITY]\nYour durable swarm identity is stored at ${identityRelPath}. Read it before acting when you need role details. Treat it as your agent-specific AGENT.md.\n[/PI-SWARM IDENTITY]`;
}

async function readMailbox(p: Paths, agentId: string): Promise<SwarmMessage[]> {
	const file = mailboxPath(p, agentId);
	if (!existsSync(file)) return [];
	const raw = await readFile(file, "utf8");
	return raw.split(/\n+/).filter(Boolean).map((line) => JSON.parse(line));
}

function truncate(text: string) {
	const t = truncateHead(text, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
	if (!t.truncated) return text;
	return `${t.content}\n\n[truncated: ${t.outputLines}/${t.totalLines} lines (${formatSize(t.outputBytes)}/${formatSize(t.totalBytes)})]`;
}

function buildSystemDelivery(msg: SwarmMessage) {
	// Keep this as a single physical line: `tmux send-keys -l` does not reliably
	// preserve embedded newlines across terminal editors. Base64 prevents marker
	// collisions and keeps user-controlled message content out of the tmux input
	// stream as raw control characters.
	const payload = Buffer.from(JSON.stringify(msg), "utf8").toString("base64");
	return `${SYSTEM_START} b64:${payload} ${SYSTEM_END}`;
}

function parseSystemDelivery(text: string): SwarmMessage | null {
	if (!text.includes(SYSTEM_START) || !text.includes(SYSTEM_END)) return null;
	const body = text.slice(text.indexOf(SYSTEM_START) + SYSTEM_START.length, text.indexOf(SYSTEM_END)).trim();
	if (body.startsWith("b64:")) {
		try {
			const msg = JSON.parse(Buffer.from(body.slice(4).trim(), "base64").toString("utf8")) as SwarmMessage;
			return { ...msg, type: "swarm.message", schemaVersion: msg.schemaVersion || 1, requiresAck: msg.requiresAck ?? true, headers: msg.headers || {} };
		} catch {}
	}
	if (body.startsWith("{")) {
		try {
			const msg = JSON.parse(body) as SwarmMessage;
			return { ...msg, type: "swarm.message", schemaVersion: msg.schemaVersion || 1, requiresAck: msg.requiresAck ?? true, headers: msg.headers || {} };
		} catch {}
	}
	const [headerPart, ...rest] = body.split(/\n\n/);
	const headers: Record<string, string> = {};
	for (const line of headerPart.split("\n")) {
		const i = line.indexOf(":");
		if (i > 0) headers[line.slice(0, i).trim()] = line.slice(i + 1).trim();
	}
	const fullBody = rest.join("\n\n");
	const m = fullBody.match(/Body:\n([\s\S]*)$/);
	return {
		id: headers.message_id || `msg-${randomUUID()}`,
		swarmId: headers.swarm_id || process.env.PI_SWARM_ID || "unknown",
		from: headers.from || "unknown",
		to: headers.to || currentAgentId(),
		priority: headers.priority || "normal",
		subject: headers.subject || undefined,
		type: "swarm.message",
		schemaVersion: 1,
		createdAt: headers.created_at || now(),
		body: (m ? m[1] : fullBody).trim(),
		requiresAck: true,
		headers,
	};
}

async function tmux(pi: ExtensionAPI, args: string[], timeout = 10_000) {
	const result = await pi.exec("tmux", args, { timeout });
	if (result.code !== 0) throw new Error(`tmux ${args.join(" ")} failed (${result.code}): ${result.stderr || result.stdout}`);
	return result.stdout;
}

async function capturePane(pi: ExtensionAPI, p: Paths, agentId: string, target: string, label: string) {
	const file = join(p.tmuxTraces, `${safeId(agentId)}-${safeId(label)}.txt`);
	try {
		const out = await tmux(pi, ["capture-pane", "-t", target, "-p", "-S", "-300"], 10_000);
		await writeFile(file, out, "utf8");
		return file;
	} catch (err: any) {
		await writeFile(file, `[capture failed] ${err?.message || err}\n`, "utf8");
		return file;
	}
}

async function sendToPane(pi: ExtensionAPI, target: string, text: string) {
	await tmux(pi, ["send-keys", "-t", target, "-l", text], 10_000);
	await sleep(150);
	await tmux(pi, ["send-keys", "-t", target, "Enter"], 10_000);
}

async function deliver(pi: ExtensionAPI, p: Paths, state: SwarmState, msg: SwarmMessage) {
	const agent = state.agents[msg.to];
	if (!agent?.tmuxTarget || agent.status !== "running") return { delivered: false, reason: "target agent not running" };
	const before = await capturePane(pi, p, msg.to, agent.tmuxTarget, `deliver-${msg.id}-before`);
	await sendToPane(pi, agent.tmuxTarget, buildSystemDelivery(msg));
	await sleep(SEND_SETTLE_MS);
	const after = await capturePane(pi, p, msg.to, agent.tmuxTarget, `deliver-${msg.id}-after`);
	return { delivered: true, before, after };
}

async function enqueueAndDeliver(pi: ExtensionAPI, cwd: string, p: Paths, params: { to: string; body: string; subject?: string; priority?: string; conversationId?: string; replyTo?: string; requiresAck?: boolean; ttlMs?: number; idempotencyKey?: string }) {
	let delivery: any = null;
	const msg = await withLock(p, async () => {
		const st = await readState(p, cwd);
		const to = safeId(params.to);
		const from = currentAgentId();
		if (!st.agents[to]) throw new Error(`Unknown swarm agent: ${to}`);

		// Idempotency check: if from+to+idempotencyKey already exists, return existing message
		if (params.idempotencyKey) {
			const existing = Object.values(st.messages).find(
				(r) => r.from === from && r.to === to && r.idempotencyKey === params.idempotencyKey
			);
			if (existing) {
				const original = (await readMailbox(p, to)).find((m) => m.id === existing.id);
				if (!original) throw new Error(`Idempotency record ${existing.id} exists but mailbox entry is missing for ${to}`);
				delivery = { reused: true, delivered: existing.status === "injected" || existing.status === "intercepted" || existing.status === "acked", status: existing.status };
				await trace(p, "message.idempotent_reuse", { id: existing.id, from, to, idempotencyKey: params.idempotencyKey, status: existing.status });
				return original;
			}
		}

		const createdAt = now();
		const m: SwarmMessage = {
			id: `msg-${Date.now()}-${randomUUID().slice(0, 8)}`,
			swarmId: st.swarmId,
			from,
			to,
			subject: params.subject,
			priority: params.priority || "normal",
			type: "swarm.message",
			schemaVersion: 1,
			createdAt,
			body: params.body,
			conversationId: params.conversationId,
			replyTo: params.replyTo,
			requiresAck: params.requiresAck ?? true,
			ttlMs: params.ttlMs,
			idempotencyKey: params.idempotencyKey,
			headers: { cwd, senderModel: currentModel(), senderProvider: currentProvider() },
		};
		upsertMessageRecord(st, m, "queued", { queuedAt: createdAt });
		await appendJsonl(mailboxPath(p, to), m);
		await trace(p, "message.enqueue", { id: m.id, from: m.from, to: m.to, subject: m.subject, priority: m.priority, conversationId: m.conversationId, replyTo: m.replyTo, requiresAck: m.requiresAck, idempotencyKey: m.idempotencyKey });
		delivery = await deliver(pi, p, st, m);
		if (delivery?.delivered) {
			// Injection into the recipient pane is already delivery. Mark it in state
			// atomically with enqueue+inject so pending mailbox polling does not
			// reprocess the same message after a restart or delayed poll.
			st.delivered[to] = Array.from(new Set([...(st.delivered[to] || []), m.id]));
			upsertMessageRecord(st, m, "injected", { injectedAt: now(), attempts: (st.messages[m.id]?.attempts || 0) + 1 });
			await writeState(p, st);
		} else {
			upsertMessageRecord(st, m, "failed", { failedAt: now(), attempts: (st.messages[m.id]?.attempts || 0) + 1, lastError: delivery?.reason || "delivery skipped" });
			await writeState(p, st);
		}
		await trace(p, delivery?.delivered ? "message.inject.ok" : "message.inject.skip", { id: m.id, to: m.to, delivery, markedDelivered: Boolean(delivery?.delivered), status: st.messages[m.id]?.status });
		return m;
	});
	return { msg, delivery };
}

async function spawnAgent(pi: ExtensionAPI, cwd: string, p: Paths, state: SwarmState, input: { id?: string; role: string; model?: string; provider?: string; initialPrompt?: string }) {
	const id = safeId(input.id || input.role || `agent-${randomUUID().slice(0, 6)}`);
	if (state.agents[id]?.status === "running") throw new Error(`Agent already exists and is running: ${id}`);
	const model = input.model || currentModel();
	const provider = input.provider || currentProvider();
	const window = id;
	const target = `${state.tmuxSession}:${window}.0`;
	const envPrefix = [
		`PI_SWARM_AGENT_ID=${shellQuote(id)}`,
		`PI_SWARM_ID=${shellQuote(state.swarmId)}`,
		`PI_SWARM_DEFAULT_MODEL=${shellQuote(model)}`,
		`PI_SWARM_DEFAULT_PROVIDER=${shellQuote(provider)}`,
	].join(" ");
	const cmd = `${envPrefix} pi --model ${shellQuote(model)} --provider ${shellQuote(provider)} ${childPiArgs()}`;

	try {
		await tmux(pi, ["has-session", "-t", state.tmuxSession], 5_000);
		await tmux(pi, ["new-window", "-t", state.tmuxSession, "-c", cwd, "-n", window, cmd], 10_000);
	} catch (err: any) {
		if (String(err?.message || err).includes("can't find session")) {
			await tmux(pi, ["new-session", "-d", "-s", state.tmuxSession, "-c", cwd, "-n", window, cmd], 10_000);
		} else {
			throw err;
		}
	}

	const ts = now();
	const agent: SwarmAgent = {
		id,
		role: input.role,
		status: "running",
		tmuxSession: state.tmuxSession,
		tmuxWindow: window,
		tmuxTarget: target,
		model,
		provider,
		cwd,
		mailbox: relative(cwd, mailboxPath(p, id)),
		createdAt: ts,
		updatedAt: ts,
	};
	state.agents[id] = agent;
	state.delivered[id] ||= [];
	await appendFile(mailboxPath(p, id), "", "utf8");
	const identityFile = identityPath(p, id);
	await writeFile(identityFile, buildIdentityMarkdown(state, agent), "utf8");
	const identityRelPath = relative(cwd, identityFile);
	await trace(p, "agent.spawn.ok", { agentId: id, tmuxTarget: target, model, provider, role: input.role, identity: identityRelPath });
	await sleep(SPAWN_SETTLE_MS);
	const snapshot = await capturePane(pi, p, id, target, "spawn-after");
	const kickoff = `${input.initialPrompt?.trim() || `You are ${id}. Follow your swarm identity and await tasks.`}${identityPrompt(cwd, identityRelPath)}`;
	await sendToPane(pi, target, kickoff);
	return { agent, snapshot, identity: identityFile };
}

function textResult(text: string, details: Record<string, unknown> = {}) {
	return { content: [{ type: "text" as const, text }], details };
}

function shellQuote(value: string) {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function isTmuxRunning(pi: ExtensionAPI, target: string): Promise<boolean> {
	return tmux(pi, ["display-message", "-p", "-t", target, "#{pane_alive}"], 3_000)
		.then((out) => out.trim() === "1")
		.catch(() => false);
}

const MAX_ATTEMPTS = 5;

async function reconcile(pi: ExtensionAPI, cwd: string, p: Paths, options: { agentId?: string; dryRun?: boolean }) {
	const result = await withLock(p, async () => {
		const st = await readState(p, cwd);
		const nowMs = Date.now();
		const actions: Array<{ messageId: string; action: string; reason: string }> = [];
		const targetAgentId = options.agentId ? safeId(options.agentId) : undefined;

		for (const [msgId, rec] of Object.entries(st.messages)) {
			if (rec.status === "dead_letter") continue;
			if (rec.status === "acked") continue;
			if (targetAgentId && rec.to !== targetAgentId) continue;
			if (rec.status !== "queued" && rec.status !== "failed" && rec.status !== "injected" && rec.status !== "intercepted") continue;

			const ageMs = nowMs - new Date(rec.createdAt).getTime();
			const expired = rec.ttlMs !== undefined ? ageMs > rec.ttlMs : false;
			const maxAttempts = rec.attempts >= MAX_ATTEMPTS;
			const agent = st.agents[rec.to];
			const agentRunning = agent?.status === "running" && agent?.tmuxTarget ? await isTmuxRunning(pi, agent.tmuxTarget) : false;

			if (expired || maxAttempts) {
				if (!options.dryRun) {
					upsertMessageRecord(st, { id: msgId, swarmId: st.swarmId, from: rec.from, to: rec.to, priority: "normal", type: "swarm.message" as const, schemaVersion: 1, createdAt: rec.createdAt, body: "", headers: {}, requiresAck: rec.requiresAck, ttlMs: rec.ttlMs }, "dead_letter", { failedAt: now(), lastError: expired ? "TTL expired" : "Max attempts exceeded" });
					await trace(p, "reconcile.dead_letter", { id: msgId, to: rec.to, reason: expired ? "ttl_expired" : "max_attempts", attempts: rec.attempts, ageMs });
				}
				actions.push({ messageId: msgId, action: "dead_letter", reason: expired ? "TTL expired" : "Max attempts exceeded" });
				continue;
			}

			if ((rec.status === "queued" || rec.status === "failed") && agentRunning) {
				if (!options.dryRun) {
					const msg = await readMailbox(p, rec.to).then((msgs) => msgs.find((m) => m.id === msgId));
					if (msg) {
						const delivery = await deliver(pi, p, st, msg);
						if (delivery?.delivered) {
							st.delivered[rec.to] = Array.from(new Set([...(st.delivered[rec.to] || []), msgId]));
							upsertMessageRecord(st, msg, "injected", { injectedAt: now(), attempts: rec.attempts + 1 });
							await trace(p, "reconcile.retry.ok", { id: msgId, to: rec.to, attempts: rec.attempts + 1 });
							actions.push({ messageId: msgId, action: "retried", reason: "Agent running, injection successful" });
						} else {
							upsertMessageRecord(st, msg, "failed", { failedAt: now(), attempts: rec.attempts + 1, lastError: delivery?.reason || "Injection failed" });
							await trace(p, "reconcile.retry.failed", { id: msgId, to: rec.to, attempts: rec.attempts + 1, error: delivery?.reason });
							actions.push({ messageId: msgId, action: "retry_failed", reason: delivery?.reason || "Injection failed" });
						}
					} else {
						await trace(p, "reconcile.skip", { id: msgId, to: rec.to, reason: "Message not found in mailbox" });
						actions.push({ messageId: msgId, action: "skipped", reason: "Message not found in mailbox" });
					}
				} else {
					actions.push({ messageId: msgId, action: "would_retry", reason: "Agent running (dry run)" });
				}
				continue;
			}

			if ((rec.status === "queued" || rec.status === "failed") && !agentRunning) {
				actions.push({ messageId: msgId, action: "pending", reason: "Recipient agent not running" });
				continue;
			}

			if ((rec.status === "injected" || rec.status === "intercepted") && !rec.ackedAt) {
				const injectedAge = rec.injectedAt ? (nowMs - new Date(rec.injectedAt).getTime()) : 0;
				const staleThreshold = 300_000; // 5 minutes
				if (injectedAge > staleThreshold) {
					if (!options.dryRun) {
						upsertMessageRecord(st, { id: msgId, swarmId: st.swarmId, from: rec.from, to: rec.to, priority: "normal", type: "swarm.message" as const, schemaVersion: 1, createdAt: rec.createdAt, body: "", headers: {}, requiresAck: rec.requiresAck, ttlMs: rec.ttlMs }, "failed", { failedAt: now(), attempts: rec.attempts + 1, lastError: "Injected but not acked (stale)" });
						await trace(p, "reconcile.stale_injected", { id: msgId, to: rec.to, injectedAge, attempts: rec.attempts + 1 });
					}
					actions.push({ messageId: msgId, action: "stale", reason: "Injected but not acked (stale)" });
				} else {
					actions.push({ messageId: msgId, action: "awaiting_ack", reason: "Recently injected, awaiting ack" });
				}
				continue;
			}
		}

		if (!options.dryRun) {
			await writeState(p, st);
		}
		return { actions, count: actions.length, dryRun: Boolean(options.dryRun) };
	});
	await trace(p, "reconcile.complete", { agentId: options.agentId, dryRun: options.dryRun, result });
	return result;
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		const p = paths(ctx.cwd);
		await ensureDirs(p);
		await withLock(p, async () => {
			const st = await readState(p, ctx.cwd);
			await trace(p, "session.start", { agentId: currentAgentId(), mode: ctx.mode, state: relative(ctx.cwd, p.state) });
			if (currentAgentId() !== "orchestrator" && !st.agents[currentAgentId()]) {
				st.agents[currentAgentId()] = {
					id: currentAgentId(), role: "Externally started swarm agent", status: "running",
					tmuxSession: st.tmuxSession, tmuxWindow: currentAgentId(), tmuxTarget: "unknown",
					model: currentModel(), provider: currentProvider(), cwd: ctx.cwd,
					mailbox: relative(ctx.cwd, mailboxPath(p, currentAgentId())), createdAt: now(), updatedAt: now(),
				};
				await writeState(p, st);
			}
		});
		if (ctx.hasUI) ctx.ui.setStatus("swarm", `swarm:${currentAgentId()}`);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const agentId = currentAgentId();
		if (agentId === "orchestrator") return;
		const p = paths(ctx.cwd);
		const st = await readState(p, ctx.cwd);
		const agent = st.agents[agentId];
		if (!agent) return;
		const identityRel = relative(ctx.cwd, identityPath(p, agentId));
		return {
			systemPrompt: `${event.systemPrompt}\n\nPi Swarm identity: you are agent \`${agentId}\` (${agent.role}). Your durable role card is \`${identityRel}\`. Follow it as your agent-specific AGENT.md. Use swarm tools for peer coordination.`,
		};
	});

	pi.on("input", async (event, ctx) => {
		if (event.source === "extension") return { action: "continue" };
		const msg = parseSystemDelivery(event.text);
		if (!msg) return { action: "continue" };
		const p = paths(ctx.cwd);
		await withLock(p, async () => {
			const st = await readState(p, ctx.cwd);
			upsertMessageRecord(st, msg, "intercepted", { interceptedAt: now() });
			await writeState(p, st);
		});
		await trace(p, "message.input_intercept", { id: msg.id, from: msg.from, to: msg.to, agentId: currentAgentId(), status: "intercepted" });
		pi.sendMessage({
			customType: "swarm-message",
			content: `Inter-agent swarm message from ${msg.from} to ${msg.to}${msg.subject ? ` (${msg.subject})` : ""}:\n\n${msg.body}`,
			display: true,
			details: msg,
		}, { triggerTurn: true, deliverAs: ctx.isIdle() ? "steer" : "followUp" });
		return { action: "handled" };
	});

	pi.registerTool(defineTool({
		name: "swarm_list_agents",
		label: "Swarm List",
		description: "List pi swarm agents for this project, including tmux targets and mailbox paths.",
		promptGuidelines: ["Use `swarm_list_agents` before sending swarm messages when you are unsure which agents exist."],
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			const p = paths(ctx.cwd);
			const st = await readState(p, ctx.cwd);
			return textResult(JSON.stringify({ swarmId: st.swarmId, tmuxSession: st.tmuxSession, agents: Object.values(st.agents) }, null, 2), { state: st });
		},
	}));

	pi.registerTool(defineTool({
		name: "swarm_spawn_agent",
		label: "Swarm Spawn",
		description: "Spawn a new pi agent in a tmux window in the same working directory. The new agent shares project extensions and skills. Requires tmux.",
		promptGuidelines: ["Use `swarm_spawn_agent` when the user asks to create a pi agent/swarm worker for parallel planning, review, or coding."],
		parameters: Type.Object({
			id: Type.Optional(Type.String({ description: "Stable agent id, e.g. planner or reviewer. Lowercase letters, digits, dash and underscore are safest." })),
			role: Type.String({ description: "Role/instructions for the agent." }),
			model: Type.Optional(Type.String({ description: "pi model id. Defaults to PI_SWARM_DEFAULT_MODEL/current session model, fallback glm-4.5." })),
			provider: Type.Optional(Type.String({ description: "pi provider id. Defaults to PI_SWARM_DEFAULT_PROVIDER/current session provider, fallback zai-coding-cn." })),
			initialPrompt: Type.Optional(Type.String({ description: "Optional first prompt to send into the spawned agent after pi starts." })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const p = paths(ctx.cwd);
			await ensureDirs(p);
			const result = await withLock(p, async () => {
				const st = await readState(p, ctx.cwd);
				await trace(p, "agent.spawn.request", { requestedBy: currentAgentId(), ...params });
				const r = await spawnAgent(pi, ctx.cwd, p, st, { ...params, model: params.model || currentModel(), provider: params.provider || currentProvider() });
				await writeState(p, st);
				return { swarmId: st.swarmId, tmuxSession: st.tmuxSession, ...r };
			});
			return textResult(`Spawned ${result.agent.id} at ${result.agent.tmuxTarget}\nIdentity: ${relative(ctx.cwd, result.identity)}\nSnapshot: ${relative(ctx.cwd, result.snapshot)}`, result);
		},
	}));

	pi.registerTool(defineTool({
		name: "swarm_agent_identity",
		label: "Swarm Identity",
		description: "Read or refresh a swarm agent's durable Markdown identity card under .pi/swarm/agents/<agent-id>.md.",
		promptGuidelines: ["Use `swarm_agent_identity` when you need a swarm agent's role, protocol, mailbox, or identity file path."],
		parameters: Type.Object({
			agentId: Type.Optional(Type.String({ description: "Agent id. Defaults to current PI_SWARM_AGENT_ID or orchestrator." })),
			refresh: Type.Optional(Type.Boolean({ description: "Regenerate the identity markdown from current swarm state before reading. Defaults to false." })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const p = paths(ctx.cwd);
			const agentId = safeId(params.agentId || currentAgentId());
			const st = await readState(p, ctx.cwd);
			const agent = st.agents[agentId];
			if (!agent) throw new Error(`Unknown swarm agent: ${agentId}`);
			const file = identityPath(p, agentId);
			if (params.refresh || !existsSync(file)) await writeFile(file, buildIdentityMarkdown(st, agent), "utf8");
			const markdown = await readFile(file, "utf8");
			await trace(p, "agent.identity.read", { agentId, file: relative(ctx.cwd, file), refresh: Boolean(params.refresh) });
			return textResult(markdown, { agent, identity: relative(ctx.cwd, file) });
		},
	}));

	pi.registerTool(defineTool({
		name: "swarm_send_message",
		label: "Swarm Send",
		description: "Send an inter-agent swarm message. The message is appended to the recipient mailbox JSONL and injected into the recipient tmux pane with PI-SWARM system headers when possible.",
		promptGuidelines: ["Use `swarm_send_message` for agent-to-agent coordination instead of asking the human to relay messages."],
		parameters: Type.Object({
			to: Type.String({ description: "Recipient agent id." }),
			body: Type.String({ description: "Message body." }),
			subject: Type.Optional(Type.String({ description: "Short subject." })),
			priority: Type.Optional(Type.String({ description: "low, normal, or high. Defaults to normal." })),
			conversationId: Type.Optional(Type.String({ description: "Optional conversation/thread id for related messages." })),
			replyTo: Type.Optional(Type.String({ description: "Optional message id this message replies to." })),
			requiresAck: Type.Optional(Type.Boolean({ description: "Whether recipient should explicitly ack done/failed. Defaults to true." })),
			ttlMs: Type.Optional(Type.Number({ description: "Optional time-to-live in milliseconds for future reconcile/dead-letter handling." })),
			idempotencyKey: Type.Optional(Type.String({ description: "Optional idempotency key to prevent duplicate messages. If a message with the same from+to+idempotencyKey exists, it is returned instead." })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const p = paths(ctx.cwd);
			const { msg, delivery } = await enqueueAndDeliver(pi, ctx.cwd, p, params);
			return textResult(`Sent ${msg.id} to ${msg.to}. Injected: ${Boolean(delivery?.delivered)}`, { message: msg, delivery });
		},
	}));

	pi.registerTool(defineTool({
		name: "swarm_ack_message",
		label: "Swarm Ack",
		description: "Acknowledge swarm message processing status. Use this after you have seen, completed, or failed a message-triggered task.",
		promptGuidelines: ["Use `swarm_ack_message` after processing a swarm message, especially when the message requires acknowledgement."],
		parameters: Type.Object({
			messageId: Type.String({ description: "Message id to acknowledge." }),
			status: Type.String({ description: "Ack status: seen, processing, done, failed." }),
			note: Type.Optional(Type.String({ description: "Short note about what happened." })),
			resultMessageId: Type.Optional(Type.String({ description: "Optional reply/result message id produced from this message." })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const p = paths(ctx.cwd);
			const agentId = currentAgentId();
			const result = await withLock(p, async () => {
				const st = await readState(p, ctx.cwd);
				const rec = st.messages[params.messageId];
				if (!rec) throw new Error(`Unknown message id: ${params.messageId}`);
				if (rec.to !== agentId && agentId !== "orchestrator") throw new Error(`Message ${params.messageId} belongs to ${rec.to}, not ${agentId}`);
				const ackAt = now();
				const failed = params.status === "failed";
				st.messages[params.messageId] = {
					...rec,
					status: failed ? "failed" : "acked",
					updatedAt: ackAt,
					ackedAt: failed ? rec.ackedAt : ackAt,
					failedAt: failed ? ackAt : rec.failedAt,
					lastError: failed ? params.note || rec.lastError : rec.lastError,
					lastAck: { by: agentId, status: params.status, note: params.note, resultMessageId: params.resultMessageId, at: ackAt },
				};
				st.delivered[rec.to] = Array.from(new Set([...(st.delivered[rec.to] || []), params.messageId]));
				await writeState(p, st);
				await trace(p, "message.ack", { id: params.messageId, agentId, status: params.status, note: params.note, resultMessageId: params.resultMessageId });
				return st.messages[params.messageId];
			});
			return textResult(`Acked ${params.messageId} as ${params.status}`, { message: result });
		},
	}));

	pi.registerTool(defineTool({
		name: "swarm_message_status",
		label: "Swarm Message Status",
		description: "Inspect lifecycle status records for swarm messages, optionally filtered by agent or status.",
		promptGuidelines: ["Use `swarm_message_status` to debug whether swarm messages are queued, injected, intercepted, acked, or failed."],
		parameters: Type.Object({
			messageId: Type.Optional(Type.String({ description: "Specific message id to inspect." })),
			agentId: Type.Optional(Type.String({ description: "Filter messages by recipient agent id." })),
			status: Type.Optional(Type.String({ description: "Filter by lifecycle status." })),
			limit: Type.Optional(Type.Number({ description: "Maximum records to return. Defaults to 50." })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const p = paths(ctx.cwd);
			const st = await readState(p, ctx.cwd);
			let records = Object.values(st.messages || {});
			if (params.messageId) records = records.filter((r) => r.id === params.messageId);
			if (params.agentId) records = records.filter((r) => r.to === safeId(params.agentId!));
			if (params.status) records = records.filter((r) => r.status === params.status);
			records = records.sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(-Math.max(1, Math.min(200, params.limit || 50)));
			return textResult(JSON.stringify({ count: records.length, records }, null, 2), { records });
		},
	}));

	pi.registerTool(defineTool({
		name: "swarm_check_mailbox",
		label: "Swarm Mailbox",
		description: "Read pending or recent messages from a swarm agent mailbox JSONL. Defaults to the current PI_SWARM_AGENT_ID.",
		promptGuidelines: ["Use `swarm_check_mailbox` when you are a swarm agent and need to read messages sent by other agents."],
		parameters: Type.Object({
			agentId: Type.Optional(Type.String({ description: "Agent id. Defaults to current PI_SWARM_AGENT_ID or orchestrator." })),
			limit: Type.Optional(Type.Number({ description: "Maximum messages to return. Defaults to 20." })),
			pendingOnly: Type.Optional(Type.Boolean({ description: "Only return messages not marked delivered in swarm state. Defaults to false." })),
			markDelivered: Type.Optional(Type.Boolean({ description: "Mark returned messages as delivered/read. Defaults to false." })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const p = paths(ctx.cwd);
			const agentId = safeId(params.agentId || currentAgentId());
			const limit = Math.max(1, Math.min(100, params.limit || 20));
			const result = await withLock(p, async () => {
				const st = await readState(p, ctx.cwd);
				const deliveredIds = new Set(st.delivered[agentId] || []);
				let messages = await readMailbox(p, agentId);
				if (params.pendingOnly) messages = messages.filter((m) => !deliveredIds.has(m.id));
				const matchedCount = messages.length;
				if (params.markDelivered) {
					// Mark the whole matched set before applying the display limit so a small
					// limit does not leave older pending messages to be reprocessed forever.
					st.delivered[agentId] = Array.from(new Set([...(st.delivered[agentId] || []), ...messages.map((m) => m.id)]));
					await writeState(p, st);
				}
				messages = messages.slice(-limit);
				await trace(p, "mailbox.poll", { agentId, count: messages.length, matchedCount, pendingOnly: Boolean(params.pendingOnly), markDelivered: Boolean(params.markDelivered) });
				return { agentId, mailbox: relative(ctx.cwd, mailboxPath(p, agentId)), matchedCount, returnedCount: messages.length, messages };
			});
			return textResult(JSON.stringify(result, null, 2), result);
		},
	}));

	pi.registerTool(defineTool({
		name: "swarm_trace",
		label: "Swarm Trace",
		description: "Read recent structured pi-swarm trace events. Output is truncated to pi's default limits.",
		promptGuidelines: ["Use `swarm_trace` to debug swarm spawning, mailbox, or tmux injection behavior."],
		parameters: Type.Object({ limit: Type.Optional(Type.Number({ description: "Number of recent trace lines. Defaults to 80." })) }),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const p = paths(ctx.cwd);
			if (!existsSync(p.events)) return textResult("No swarm trace file yet.", { path: relative(ctx.cwd, p.events) });
			const lines = (await readFile(p.events, "utf8")).trim().split("\n").filter(Boolean);
			const selected = lines.slice(-Math.max(1, Math.min(500, params.limit || 80))).join("\n");
			return textResult(truncate(selected), { path: relative(ctx.cwd, p.events), totalLines: lines.length });
		},
	}));

	pi.registerTool(defineTool({
		name: "swarm_capture_agent_pane",
		label: "Swarm Capture",
		description: "Capture the tmux pane history for a swarm agent and save it under .pi/swarm/traces/tmux for debugging.",
		promptGuidelines: ["Use `swarm_capture_agent_pane` to debug what a spawned agent is currently seeing or doing in tmux."],
		parameters: Type.Object({ agentId: Type.String({ description: "Agent id to capture." }) }),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const p = paths(ctx.cwd);
			const st = await readState(p, ctx.cwd);
			const agent = st.agents[safeId(params.agentId)];
			if (!agent) throw new Error(`Unknown swarm agent: ${params.agentId}`);
			const file = await capturePane(pi, p, agent.id, agent.tmuxTarget, `manual-${Date.now()}`);
			await trace(p, "tmux.capture", { agentId: agent.id, target: agent.tmuxTarget, file: relative(ctx.cwd, file) });
			return textResult(`Captured ${agent.id} pane to ${relative(ctx.cwd, file)}`, { file, agent });
		},
	}));

	pi.registerTool(defineTool({
		name: "swarm_reconcile",
		label: "Swarm Reconcile",
		description: "Reconcile swarm mailbox state. Inspects queued/failed/injected messages requiring ack, retries failed/queued injections when recipient tmux is running, marks expired or max-attempt messages dead_letter, and traces events.",
		promptGuidelines: ["Use `swarm_reconcile` to recover stuck messages, retry failed deliveries, and move expired/unrecoverable messages to dead_letter."],
		parameters: Type.Object({
			agentId: Type.Optional(Type.String({ description: "Optional agent id to reconcile only that agent's messages." })),
			dryRun: Type.Optional(Type.Boolean({ description: "If true, inspect and report actions without modifying state. Defaults to false." })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const p = paths(ctx.cwd);
			const result = await reconcile(pi, ctx.cwd, p, { agentId: params.agentId, dryRun: params.dryRun });
			const summary = result.actions.map((a) => `  ${a.messageId}: ${a.action} (${a.reason})`).join("\n");
			return textResult(`Reconciled ${result.count} messages (${result.dryRun ? "dry run" : "applied"}):\n${summary}`, result);
		},
	}));

	pi.registerTool(defineTool({
		name: "swarm_dead_letters",
		label: "Swarm Dead Letters",
		description: "List or inspect dead-lettered swarm messages that exceeded max attempts or TTL.",
		promptGuidelines: ["Use `swarm_dead_letters` to review messages that failed permanently and may require manual intervention."],
		parameters: Type.Object({
			agentId: Type.Optional(Type.String({ description: "Filter by recipient agent id." })),
			messageId: Type.Optional(Type.String({ description: "Specific dead-letter message id to inspect." })),
			limit: Type.Optional(Type.Number({ description: "Maximum records to return. Defaults to 20." })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const p = paths(ctx.cwd);
			const st = await readState(p, ctx.cwd);
			let records = Object.values(st.messages || {}).filter((r) => r.status === "dead_letter");
			if (params.messageId) records = records.filter((r) => r.id === params.messageId);
			if (params.agentId) records = records.filter((r) => r.to === safeId(params.agentId!));
			records = records.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt)).slice(-Math.max(1, Math.min(100, params.limit || 20)));
			return textResult(JSON.stringify({ count: records.length, records }, null, 2), { records });
		},
	}));

	pi.registerCommand("swarm", {
		description: "Manage pi swarm agents: init | list | spawn <id> [role] | send <to> <message> | trace | capture <id>",
		handler: async (args, ctx) => {
			const p = paths(ctx.cwd);
			await ensureDirs(p);
			const [cmd, ...rest] = args.trim().split(/\s+/).filter(Boolean);
			try {
				if (!cmd || cmd === "init") {
					const st = await withLock(p, async () => { const s = await readState(p, ctx.cwd); await trace(p, "swarm.init", { by: currentAgentId() }); return s; });
					ctx.ui.notify(`Swarm ${st.swarmId} ready: ${relative(ctx.cwd, p.state)}`, "info");
					return;
				}
				if (cmd === "list" || cmd === "status") {
					const st = await readState(p, ctx.cwd);
					ctx.ui.notify(`Swarm ${st.swarmId}: ${Object.keys(st.agents).length} agents, tmux ${st.tmuxSession}`, "info");
					return;
				}
				if (cmd === "spawn") {
					const id = rest.shift();
					if (!id) { ctx.ui.notify("Usage: /swarm spawn <id> [role]", "warning"); return; }
					const role = rest.join(" ") || id;
					const result = await withLock(p, async () => { const st = await readState(p, ctx.cwd); const r = await spawnAgent(pi, ctx.cwd, p, st, { id, role, model: currentModel(), provider: currentProvider() }); await writeState(p, st); return r; });
					ctx.ui.notify(`Spawned ${result.agent.id} at ${result.agent.tmuxTarget}`, "info");
					return;
				}
				if (cmd === "send") {
					const to = rest.shift();
					const body = rest.join(" ");
					if (!to || !body) { ctx.ui.notify("Usage: /swarm send <to> <message>", "warning"); return; }
					const { msg, delivery } = await enqueueAndDeliver(pi, ctx.cwd, p, { to, body });
					ctx.ui.notify(`Sent ${msg.id} to ${msg.to}. Injected: ${Boolean(delivery?.delivered)}`, "info");
					return;
				}
				if (cmd === "trace") {
					ctx.ui.notify(`Trace: ${relative(ctx.cwd, p.events)}`, "info");
					return;
				}
				if (cmd === "capture") {
					const agentId = rest[0];
					if (!agentId) { ctx.ui.notify("Usage: /swarm capture <agent-id>", "warning"); return; }
					const st = await readState(p, ctx.cwd);
					const agent = st.agents[safeId(agentId)];
					if (!agent) { ctx.ui.notify(`Unknown agent ${agentId}`, "warning"); return; }
					const file = await capturePane(pi, p, agent.id, agent.tmuxTarget, `command-${Date.now()}`);
					ctx.ui.notify(`Captured to ${relative(ctx.cwd, file)}`, "info");
					return;
				}
				ctx.ui.notify(`Unknown /swarm command: ${cmd}`, "warning");
			} catch (err: any) {
				await trace(p, "error", { where: "command", command: cmd, message: err?.message || String(err), stack: err?.stack });
				ctx.ui.notify(`Swarm error: ${err?.message || err}`, "error");
			}
		},
	});
}
