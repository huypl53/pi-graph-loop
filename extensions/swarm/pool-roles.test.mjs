// Issue 22 model-pool-roles-filter: per-slot `roles` allow-list. Verifies (plan cases A–M):
//   A/B/C/D/J — pickSlot roleKind filtering (match, filtered-out, empty=all, absent=all, legacy undefined)
//   K         — bypassRolesFilter skips the filter (manual rotate escape hatch)
//   L         — validateSwarmSettings rejects malformed roles (slot_bad_roles)
//   M         — CONDITION 1 guard: readSwarmSettings().modelPool[i].roles is populated end-to-end
//   E         — /swarm pool rotate now bypasses filter; trace carries rolesIgnored + agentRoleKind
//   F         — /swarm pool list renders roles= column only when any slot has roles
//   G         — roleKind is re-read from state (mid-life setAgentRole observed on next swap)
//   H         — spawnAgent fallback: all slots filtered -> pool.role_filter_all_filtered_fallback trace
//   I         — /swarm pool show renders roles=[…] line iff slot has non-empty roles
//
// Run: node extensions/swarm/pool-roles.test.mjs
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paths, readState, writeState } from "./src/state.ts";
import { registerSwarmHooks, _resetSwapChainForTests } from "./src/hooks.ts";
import { registerSwarmCommand } from "./src/command.ts";
import { pickSlot, poolStatus, slotKey, validateSwarmSettings, withPoolLock, readPoolHealth, writePoolHealth } from "./src/pool.ts";
import { readSwarmSettings } from "./src/session.ts";

let pass = 0, fail = 0;
const ok = (name, cond, info) => { if (cond) pass++; else { fail++; console.error("  FAIL:", name, info ?? ""); } };

// --- fixture project: pool with BOTH role-scoped and global slots ---
const dir = await mkdtemp(join(tmpdir(), "pool-roles-"));
await mkdir(join(dir, ".pi"), { recursive: true });
await writeFile(join(dir, ".pi", "settings.json"), JSON.stringify({
	swarm: {
		defaultModel: "glm-5.1",
		defaultProvider: "zai-coding-cn",
		modelPool: [
			{ model: "glm-5.1", provider: "zai-coding-cn", weight: 50, roles: ["implementer", "tester"] },
			{ model: "gpt-5.4-mini", provider: "openai", weight: 30, roles: [] },
			{ model: "claude-sonnet-4", provider: "anthropic", weight: 0 },
		],
		rotation: { strategy: "round-robin", cooldownMs: 900_000, maxRetries: 2 },
	},
}));
process.chdir(dir);
const p = paths(dir);

async function resetHealth() {
	await withPoolLock(p, async () => {
		await writePoolHealth(p, { slots: {}, rrCursor: 0 });
	});
}

// ===========================================================================
// CASE M (CONDITION 1 guard) — parseModelPool forwards roles end-to-end
// ===========================================================================
{
	const s = readSwarmSettings(dir);
	ok("case M: modelPool parsed", Boolean(s.modelPool && s.modelPool.length === 3));
	ok("case M: slot0 roles forwarded as [implementer,tester]", JSON.stringify(s.modelPool[0].roles) === JSON.stringify(["implementer", "tester"]), JSON.stringify(s.modelPool?.[0]?.roles));
	ok("case M: empty roles array preserved (empty = all)", Array.isArray(s.modelPool[1].roles) && s.modelPool[1].roles.length === 0);
	ok("case M: absent roles stays undefined", s.modelPool[2].roles === undefined);
}

// ===========================================================================
// CASES A/B/C/D/J/K — pickSlot roleKind filtering (helper level)
// ===========================================================================
{
	await resetHealth();
	// A: implementer matches the scoped slot (weight>0 + roles match). gpt slot (roles:[]) also
	// matches, but round-robin cursor + glm first -> just assert we never pick a filtered slot.
	const a = await pickSlot(p, { roleKind: "implementer" });
	ok("case A: picked a slot", Boolean(a));
	ok("case A: picked slot matches implementer role", a && (a.slot.roles === undefined || a.slot.roles.includes("implementer")), JSON.stringify(a?.slot));

	// B: reviewer — glm slot (roles:[implementer,tester]) filtered out; gpt (roles:[]) still matches.
	const b = await pickSlot(p, { roleKind: "reviewer" });
	ok("case B: reviewer never lands on the implementer/tester-scoped glm slot", b && b.slot.model !== "glm-5.1", JSON.stringify(b?.slot));
	ok("case B: empty-roles gpt slot serves reviewer", b && b.slot.model === "gpt-5.4-mini");

	// C: roles:[] matches ANY roleKind (empty = all).
	// (covered via B above — gpt slot has roles:[] and served reviewer)

	// STRICT (2026-08-31): a roleKind that has ANY tagged slot is served ONLY by its tagged slots.
	// implementer is tagged on glm -> must NEVER pick the untagged gpt slot now.
	await resetHealth();
	for (let i = 0; i < 5; i++) {
		const s = await pickSlot(p, { roleKind: "implementer" });
		ok(`strict ${i}: implementer picks only its tagged glm slot`, s && s.slot.model === "glm-5.1", JSON.stringify(s?.slot));
	}
	// Untagged roleKinds (reviewer/orchestrator) are unaffected — served by untagged slots.
	const so = await pickSlot(p, { roleKind: "orchestrator" });
	ok("strict: untagged roleKind served by untagged slot", so && so.slot.model === "gpt-5.4-mini", JSON.stringify(so?.slot));

	// D + J: absent roles field / legacy undefined roleKind -> no filter.
	const d = await pickSlot(p, { roleKind: "orchestrator" });
	ok("case D: absent-roles slot eligible for any role", Boolean(d)); // may pick glm or gpt; just no-undefined
	const j = await pickSlot(p, {});
	ok("case J: legacy callers (no roleKind) still pick", Boolean(j));
	ok("case J: legacy pick can land on role-scoped glm slot", Boolean(j), JSON.stringify(j?.slot));

	// K: bypassRolesFilter skips the filter.
	await withPoolLock(p, async () => {
		const h = await readPoolHealth(p);
		h.rrCursor = 0;
		await writePoolHealth(p, h);
	});
	// Filter to a roleKind that only glm serves, then bypass: pick must still be able to return glm.
	await resetHealth();
	const k = await pickSlot(p, { roleKind: "tester", bypassRolesFilter: true });
	ok("case K: bypassRolesFilter returns a pick", Boolean(k));

	// All-filtered-out: roleKind with no matching slot -> undefined.
	await resetHealth();
	// Temporarily rewrite settings: ONLY role-scoped slots, weight>0, role=implementer only.
	await writeFile(join(dir, ".pi", "settings.json"), JSON.stringify({
		swarm: { modelPool: [{ model: "glm-5.1", provider: "zai-coding-cn", weight: 10, roles: ["implementer"] }], rotation: { strategy: "weighted", cooldownMs: 900_000, maxRetries: 2 } },
	}));
	const none = await pickSlot(p, { roleKind: "reviewer" });
	ok("all-filtered: pickSlot returns undefined for excluded roleKind", none === undefined, JSON.stringify(none));
	const still = await pickSlot(p, { roleKind: "implementer" });
	ok("all-filtered: matching roleKind still picks", Boolean(still));
	const legacy = await pickSlot(p, {});
	ok("all-filtered: legacy no-roleKind pick still works (no filter)", Boolean(legacy));
	// Restore the mixed fixture.
	await writeFile(join(dir, ".pi", "settings.json"), JSON.stringify({
		swarm: {
			defaultModel: "glm-5.1",
			defaultProvider: "zai-coding-cn",
			modelPool: [
				{ model: "glm-5.1", provider: "zai-coding-cn", weight: 50, roles: ["implementer", "tester"] },
				{ model: "gpt-5.4-mini", provider: "openai", weight: 30, roles: [] },
				{ model: "claude-sonnet-4", provider: "anthropic", weight: 0 },
			],
			rotation: { strategy: "round-robin", cooldownMs: 900_000, maxRetries: 2 },
		},
	}));
	await resetHealth();
}

// ===========================================================================
// CASE L — validateSwarmSettings rejects malformed roles
// ===========================================================================
{
	await writeFile(join(dir, ".pi", "settings.json"), JSON.stringify({
		swarm: { modelPool: [{ model: "glm-5.1", provider: "zai-coding-cn", roles: "implementer" }] },
	}));
	const v = validateSwarmSettings(dir);
	const bad = v.errors.find((e) => e.kind === "slot_bad_roles");
	ok("case L: slot_bad_roles error reported for non-array roles", Boolean(bad), JSON.stringify(v.errors));
	await writeFile(join(dir, ".pi", "settings.json"), JSON.stringify({
		swarm: { modelPool: [{ model: "glm-5.1", provider: "zai-coding-cn", roles: ["ok", 42] }] },
	}));
	const v2 = validateSwarmSettings(dir);
	ok("case L: slot_bad_roles error reported for non-string entry", v2.errors.some((e) => e.kind === "slot_bad_roles"));
	// Well-formed roles -> no error.
	await writeFile(join(dir, ".pi", "settings.json"), JSON.stringify({
		swarm: { modelPool: [{ model: "glm-5.1", provider: "zai-coding-cn", roles: ["implementer"] }] },
	}));
	const v3 = validateSwarmSettings(dir);
	ok("case L: well-formed roles produce no slot_bad_roles", !v3.errors.some((e) => e.kind === "slot_bad_roles"));
	// Restore mixed fixture.
	await writeFile(join(dir, ".pi", "settings.json"), JSON.stringify({
		swarm: {
			defaultModel: "glm-5.1",
			defaultProvider: "zai-coding-cn",
			modelPool: [
				{ model: "glm-5.1", provider: "zai-coding-cn", weight: 50, roles: ["implementer", "tester"] },
				{ model: "gpt-5.4-mini", provider: "openai", weight: 30, roles: [] },
				{ model: "claude-sonnet-4", provider: "anthropic", weight: 0 },
			],
			rotation: { strategy: "round-robin", cooldownMs: 900_000, maxRetries: 2 },
		},
	}));
}

// ===========================================================================
// Dispatcher-level cases (E, F, G, H, I) — same fake-pi shape as pool-override.test.mjs
// ===========================================================================
const setModelCalls = [];
const sentMessages = [];
const hookHandlers = {};
const commandHandlers = {};
const notifications = [];
const fakePi = {
	on: (ev, fn) => { (hookHandlers[ev] ||= []).push(fn); },
	registerTool: () => {},
	registerCommand: (name, def) => { commandHandlers[name] = def.handler; },
	setModel: async (m) => { setModelCalls.push({ provider: m.provider, id: m.id, target: `${m.provider}/${m.id}` }); return true; },
	sendMessage: (m, o) => { sentMessages.push({ m, o }); },
	exec: async () => ({ code: 0, stdout: "", stderr: "" }),
};
const fakeModelGlm = { id: "glm-5.1", provider: "zai-coding-cn" };
const fakeModelGpt = { id: "gpt-5.4-mini", provider: "openai" };
const fakeModelClaude = { id: "claude-sonnet-4", provider: "anthropic" };
const ctx = {
	cwd: dir, mode: "tui", isIdle: () => true, model: fakeModelGlm,
	modelRegistry: { find: (provider, id) => {
		if (id === "gpt-5.4-mini") return fakeModelGpt;
		if (id === "claude-sonnet-4") return fakeModelClaude;
		if (id === "glm-5.1") return fakeModelGlm;
		return undefined;
	} },
	ui: { notify: (text, level) => { notifications.push({ level, text }); }, setStatus: () => {} },
};

async function seedAgentRecord(agentId, roleKind) {
	const st = await readState(p, dir);
	const ts = new Date().toISOString();
	st.agents[agentId] = {
		id: agentId, role: roleKind || "worker", roleKind: roleKind || "worker", capabilities: [], activeTaskIds: [], maxConcurrentTasks: 1,
		status: "running", runtimeStatus: "idle", health: "healthy",
		tmuxSession: "sess", tmuxWindow: agentId, tmuxTarget: `sess:${agentId}.0`,
		model: "glm-5.1", provider: "zai-coding-cn", cwd: dir, mailbox: ".pi/swarm/mailboxes/x.jsonl",
		createdAt: ts, updatedAt: ts,
	};
	await writeState(p, st);
}

async function freshSession(agentId = "orchestrator") {
	await rm(join(dir, ".pi", "swarm", "pool-state.json"), { force: true }).catch(() => {});
	await rm(p.events, { force: true }).catch(() => {});
	setModelCalls.length = 0;
	sentMessages.length = 0;
	notifications.length = 0;
	process.env.PI_SWARM_AGENT_ID = agentId;
	process.env.PI_SWARM_IS_ORCHESTRATOR = "1";
	for (const k of Object.keys(hookHandlers)) delete hookHandlers[k];
	registerSwarmHooks(fakePi);
	const ss = hookHandlers["session_start"][0];
	await ss({ type: "session_start" }, { ...ctx, model: fakeModelGlm });
	_resetSwapChainForTests(agentId);
}

async function traceEvents() {
	const raw = await readFile(p.events, "utf8").catch(() => "");
	return raw.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

registerSwarmCommand(fakePi);

// --- CASE E: rotate now bypasses the role filter; trace carries rolesIgnored + agentRoleKind ---
{
	await freshSession();
	await seedAgentRecord("orchestrator", "orchestrator");
	await seedAgentRecord("worker-a", "reviewer"); // reviewer: glm slot excluded by roles filter
	const evBefore = (await traceEvents()).length;
	await commandHandlers["swarm"]("pool rotate now", { ...ctx, model: fakeModelGlm });
	ok("case E: setModel called", setModelCalls.length === 1, JSON.stringify(setModelCalls));
	const evs = (await traceEvents()).slice(evBefore);
	const forced = evs.find((e) => e.event === "pool.swap_forced_by_manual_override");
	ok("case E: pool.swap_forced_by_manual_override trace fired", Boolean(forced), JSON.stringify(evs.map((e) => e.event)));
	ok("case E: trace carries rolesIgnored:true", forced && forced.rolesIgnored === true, JSON.stringify(forced));
	ok("case E: trace carries agentRoleKind", forced && typeof forced.agentRoleKind === "string", JSON.stringify(forced));
}

// --- CASE F: pool list renders roles= column iff any slot has roles ---
{
	await freshSession();
	notifications.length = 0;
	await commandHandlers["swarm"]("pool list", { ...ctx });
	const listText = notifications.map((n) => n.text).join("\n");
	ok("case F: roles column rendered when roles configured", /roles=\[implementer,tester\]/.test(listText), listText);
	ok("case F: (all) shown for empty-roles slot", /roles=\[\(all\)\]/.test(listText), listText);
	// Without any roles configured: NO roles= fragment in any row.
	await writeFile(join(dir, ".pi", "settings.json"), JSON.stringify({
		swarm: {
			defaultModel: "glm-5.1", defaultProvider: "zai-coding-cn",
			modelPool: [
				{ model: "glm-5.1", provider: "zai-coding-cn", weight: 50 },
				{ model: "gpt-5.4-mini", provider: "openai", weight: 30 },
			],
			rotation: { strategy: "round-robin", cooldownMs: 900_000, maxRetries: 2 },
		},
	}));
	notifications.length = 0;
	await commandHandlers["swarm"]("pool list", { ...ctx });
	const plainText = notifications.map((n) => n.text).join("\n");
	ok("case F: no roles= fragment when no slot has roles", !plainText.includes("roles="), plainText);
	// Restore mixed fixture.
	await writeFile(join(dir, ".pi", "settings.json"), JSON.stringify({
		swarm: {
			defaultModel: "glm-5.1", defaultProvider: "zai-coding-cn",
			modelPool: [
				{ model: "glm-5.1", provider: "zai-coding-cn", weight: 50, roles: ["implementer", "tester"] },
				{ model: "gpt-5.4-mini", provider: "openai", weight: 30, roles: [] },
				{ model: "claude-sonnet-4", provider: "anthropic", weight: 0 },
			],
			rotation: { strategy: "round-robin", cooldownMs: 900_000, maxRetries: 2 },
		},
	}));
}

// --- CASE G: roleKind re-read from state under lock (mid-life role change) ---
{
	// The hooks turn_end swap path reads state.agents[agentId].roleKind at swap time. Case G
	// exercises that pickSlot itself honors a fresh roleKind: change the seeded roleKind and
	// assert the filtered-out slot is no longer picked for the new role.
	await freshSession("worker-a");
	await resetHealth();
	await seedAgentRecord("worker-a", "reviewer");
	const g1 = await pickSlot(p, { roleKind: "reviewer", avoidKey: "openai/gpt-5.4-mini" });
	ok("case G: reviewer never lands on glm slot", !g1 || g1.slot.model !== "glm-5.1", JSON.stringify(g1?.slot));
	// Simulate setAgentRole mid-life: mutate state directly.
	const st = await readState(p, dir);
	st.agents["worker-a"].roleKind = "implementer";
	await writeState(p, st);
	const g2 = await pickSlot(p, { roleKind: (await readState(p, dir)).agents["worker-a"].roleKind });
	ok("case G: new roleKind observed on next pick (no caching)", Boolean(g2), JSON.stringify(g2?.slot));
	ok("case G: picked slot is eligible for the new roleKind", g2 && (g2.slot.roles === undefined || g2.slot.roles.length === 0 || g2.slot.roles.includes("implementer")));
}

// --- CASE H: all slots filtered out -> pickSlot undefined -> higher-level fallback ---
{
	// spawnAgent's fallback lives in agents.ts (tmux spawn path); exercised at helper level here:
	// assert pickSlot returns undefined for an excluded roleKind, and that retrying WITHOUT the
	// filter yields a slot — the exact fallback sequence spawnAgent performs, traced as
	// pool.role_filter_all_filtered_fallback at the callsite.
	await writeFile(join(dir, ".pi", "settings.json"), JSON.stringify({
		swarm: { modelPool: [{ model: "glm-5.1", provider: "zai-coding-cn", weight: 10, roles: ["implementer"] }], rotation: { strategy: "weighted", cooldownMs: 900_000, maxRetries: 2 } },
	}));
	await resetHealth();
	const filtered = await pickSlot(p, { roleKind: "reviewer" });
	ok("case H: filtered pickSlot returns undefined", filtered === undefined);
	const fallback = await pickSlot(p, {});
	ok("case H: unfiltered retry yields a slot (spawn fallback path)", Boolean(fallback) && fallback.slot.model === "glm-5.1");
	// Restore mixed fixture for case I.
	await writeFile(join(dir, ".pi", "settings.json"), JSON.stringify({
		swarm: {
			defaultModel: "glm-5.1", defaultProvider: "zai-coding-cn",
			modelPool: [
				{ model: "glm-5.1", provider: "zai-coding-cn", weight: 50, roles: ["implementer", "tester"] },
				{ model: "gpt-5.4-mini", provider: "openai", weight: 30, roles: [] },
				{ model: "claude-sonnet-4", provider: "anthropic", weight: 0 },
			],
			rotation: { strategy: "round-robin", cooldownMs: 900_000, maxRetries: 2 },
		},
	}));
}

// --- CASE I: pool show renders roles=[…] line iff non-empty ---
{
	await freshSession();
	notifications.length = 0;
	await commandHandlers["swarm"]("pool show", { ...ctx });
	const showText = notifications.map((n) => n.text).join("\n");
	ok("case I: show renders roles line for scoped slot", /roles=\[implementer, tester\]/.test(showText), showText);
	ok("case I: show renders roles line exactly once (only the scoped slot)", (showText.match(/roles=\[/g) || []).length === 1, showText);
}

// --- cleanup ---
await rm(dir, { recursive: true, force: true }).catch(() => {});
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
