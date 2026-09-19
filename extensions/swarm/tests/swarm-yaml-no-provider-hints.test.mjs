#!/usr/bin/env node
/**
 * Test: Swarm tools must not hint at provider/model; swarm.yaml is preferred and warned when missing; swarm.json warned against.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const { readSwarmRawConfig, swarmYmlPath } = await import(join(here, "../src/config.ts"));
const { validateSwarmSettings } = await import(join(here, "../src/pool.ts"));
const { registerAgentsTools } = await import(join(here, "../src/tools/agents.ts"));
const { paths, ensureDirs, readState, writeState } = await import(join(here, "../src/state.ts"));
const { ensureRoot, claimRootLeader } = await import(join(here, "../src/identity.ts"));

let pass = 0,
	fail = 0;
const ok = (name, cond, info = "") => {
	if (cond) {
		pass++;
		console.log("  ok  ", name);
	} else {
		fail++;
		console.error("  FAIL", name, info);
	}
};

const scratch = mkdtempSync(join(tmpdir(), "swarm-yaml-test-"));
const piDir = join(scratch, ".pi");
mkdirSync(piDir, { recursive: true });

try {
	// --- Check 1: Tool definitions do not hint at zai-coding-cn / openai ---
	const registeredTools = [];
	const dummyPi = {
		registerTool: (tool) => {
			registeredTools.push(tool);
		},
		registerCommand: () => {},
		on: () => {},
	};
	registerAgentsTools(dummyPi);
	const spawnTool = registeredTools.find((t) => t.name === "swarm_spawn_agent");
	ok("swarm_spawn_agent tool registered", Boolean(spawnTool));

	const providerDesc = spawnTool?.parameters?.properties?.provider?.description || "";
	const modelDesc = spawnTool?.parameters?.properties?.model?.description || "";
	const guidelines = (spawnTool?.promptGuidelines || []).join("\n");

	ok(
		"provider description does NOT contain 'zai-coding-cn' or 'openai'",
		!providerDesc.includes("zai-coding-cn") && !providerDesc.includes("openai"),
		`actual providerDesc: ${providerDesc}`,
	);
	ok("model description does NOT contain 'glm-5.1'", !modelDesc.includes("glm-5.1"), `actual modelDesc: ${modelDesc}`);
	ok(
		"promptGuidelines advises against passing model/provider and steers to swarm.yaml",
		guidelines.includes("swarm.yaml") || guidelines.includes("swarm.yml"),
		`actual guidelines: ${guidelines}`,
	);

	// --- Check 2: .pi/swarm.yaml is recognized and parsed ---
	const yamlFile = join(piDir, "swarm.yaml");
	writeFileSync(yamlFile, "defaultModel: custom-model\ndefaultProvider: custom-provider\n");
	const rawYaml = readSwarmRawConfig(scratch);
	ok("raw config resolves swarm.yaml", rawYaml.source === "swarm.yaml" || rawYaml.source === "swarm.yml", `source=${rawYaml.source}`);
	ok("parsed defaultModel from swarm.yaml", rawYaml.cfg?.defaultModel === "custom-model", `cfg=${JSON.stringify(rawYaml.cfg)}`);
	rmSync(yamlFile, { force: true });

	// --- Check 3: warn user when no swarm.yaml / swarm.yml is configured ---
	const emptyValidation = validateSwarmSettings(scratch);
	ok(
		"validateSwarmSettings warns when no swarm.yaml/swarm.yml exists",
		emptyValidation.warnings.some((w) => w.kind === "swarm_yaml_missing"),
		`warnings=${JSON.stringify(emptyValidation.warnings)}`,
	);

	// --- Check 4: swarm_spawn_agent warns when no swarm.yaml is configured ---
	const p = paths(scratch);
	await ensureDirs(p);
	const st = await readState(p, scratch);
	ensureRoot(st, scratch, p);
	await writeState(p, st);
	await claimRootLeader(st, Date.now(), process.pid);
	await writeState(p, st);

	const notified = [];
	const execCtx = {
		cwd: scratch,
		hasUI: true,
		ui: {
			notify: (msg, type) => {
				notified.push({ msg, type });
			},
		},
	};

	// Execute spawn tool without model or provider in an unconfigured dir
	// (we catch errors because tmux might not actually spawn, but pre-execution warning check runs)
	let resText = "";
	try {
		const res = await spawnTool.execute("test-id", { role: "worker", id: "w-test" }, undefined, undefined, execCtx);
		resText = res.content?.[0]?.text || "";
	} catch (err) {
		resText = String(err.message || err);
	}

	ok(
		"spawn execution warns on unconfigured swarm.yaml via UI or tool text",
		notified.some((n) => n.msg.includes("swarm.yaml") || n.msg.includes("swarm.yml")) ||
			resText.includes("swarm.yaml") ||
			resText.includes("swarm.yml"),
		`notified=${JSON.stringify(notified)}, resText=${resText}`,
	);

	// --- Check 5: .pi/swarm.json is flagged as unsupported / warned against ---
	const jsonFile = join(piDir, "swarm.json");
	writeFileSync(jsonFile, JSON.stringify({ defaultModel: "bad" }));
	const jsonValidation = validateSwarmSettings(scratch);
	ok(
		"validateSwarmSettings warns against .pi/swarm.json",
		jsonValidation.warnings.some((w) => w.kind === "swarm_json_unsupported" || w.kind === "swarm_json_deprecated"),
		`warnings=${JSON.stringify(jsonValidation.warnings)}`,
	);
	rmSync(jsonFile, { force: true });
} finally {
	rmSync(scratch, { recursive: true, force: true });
}

console.log(`\n${fail === 0 ? "PASS" : "FAIL"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
