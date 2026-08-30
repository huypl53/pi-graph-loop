import { readFile, readdir } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { ProviderModelConfig } from "@earendil-works/pi-ai";
import type { MockLLMDiscovery, MockLLMFixtureEvent, MockLLMFixtureFile, MockLLMStopReason, MockLLLMTurn } from "./types.ts";

const EXT_DIR = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(EXT_DIR, "..", "fixtures");

const FIXTURE_CACHE = new Map<string, MockLLMFixtureFile>();

function assertValidModelId(modelId: string): void {
	if (!modelId || modelId === "." || modelId === "..") {
		throw new Error(`mock-llm invalid model id: ${JSON.stringify(modelId)}`);
	}
	if (modelId.includes("/") || modelId.includes("\\") || modelId.includes("..")) {
		throw new Error(`mock-llm invalid model id path traversal: ${JSON.stringify(modelId)}`);
	}
}

function fixturePathFor(modelId: string): string {
	assertValidModelId(modelId);
	const resolved = resolve(FIXTURE_DIR, `${modelId}.jsonl`);
	const root = resolve(FIXTURE_DIR) + sep;
	if (relative(FIXTURE_DIR, resolved).startsWith("..") || !resolved.startsWith(root)) {
		throw new Error(`mock-llm invalid fixture path escape for model ${JSON.stringify(modelId)}`);
	}
	return resolved;
}

function stripComments(line: string): string {
	const trimmed = line.trim();
	if (!trimmed || trimmed.startsWith("#")) return "";
	return trimmed;
}

function assertPlainObject(value: unknown, label: string): asserts value is Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`mock-llm invalid ${label}: expected object`);
	}
}

function normalizeStopReason(value: unknown): MockLLMStopReason | undefined {
	if (value === undefined) return undefined;
	if (value === "stop" || value === "toolUse" || value === "length" || value === "error" || value === "aborted") {
		return value;
	}
	throw new Error(`mock-llm invalid stopReason: ${String(value)}`);
}

function validateDelayMs(value: unknown, lineNo: number, label: string): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		throw new Error(`mock-llm invalid ${label}.delayMs at line ${lineNo}: expected finite number >= 0`);
	}
	return value;
}

function parseJsonLine(line: string, modelId: string, lineNo: number): unknown {
	try {
		return JSON.parse(line);
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		throw new Error(`mock-llm invalid JSON in ${modelId}.jsonl line ${lineNo}: ${msg}`);
	}
}

function validateEvent(event: unknown, modelId: string, lineNo: number): MockLLMFixtureEvent {
		assertPlainObject(event, `event at line ${lineNo}`);
	if (typeof event.type !== "string") {
		throw new Error(`mock-llm invalid event.type at line ${lineNo}`);
	}

	switch (event.type) {
		case "text":
		case "thinking": {
			if (typeof event.text !== "string") throw new Error(`mock-llm ${event.type} missing text at line ${lineNo}`);
			if (event.chunks !== undefined && (!Array.isArray(event.chunks) || !event.chunks.every((chunk) => typeof chunk === "string"))) {
				throw new Error(`mock-llm ${event.type} chunks must be string[] at line ${lineNo}`);
			}
			return { type: event.type, text: event.text, delayMs: validateDelayMs(event.delayMs, lineNo, `${modelId}.${event.type}`), chunks: event.chunks as string[] | undefined };
		}
		case "toolcall": {
			if (typeof event.name !== "string") throw new Error(`mock-llm toolcall missing name at line ${lineNo}`);
			if (event.arguments === undefined) throw new Error(`mock-llm toolcall missing arguments at line ${lineNo}`);
			if (event.chunks !== undefined && (!Array.isArray(event.chunks) || !event.chunks.every((chunk) => typeof chunk === "string"))) {
				throw new Error(`mock-llm toolcall chunks must be string[] at line ${lineNo}`);
			}
			if (typeof event.arguments !== "string") assertPlainObject(event.arguments, `toolcall.arguments at line ${lineNo}`);
			return {
				type: "toolcall",
				name: event.name,
				id: typeof event.id === "string" ? event.id : undefined,
				arguments: event.arguments as Record<string, unknown> | string,
				delayMs: validateDelayMs(event.delayMs, lineNo, `${modelId}.toolcall`),
				chunks: event.chunks as string[] | undefined,
			};
		}
		case "hang":
			if (event.until !== undefined && event.until !== "abort") {
				throw new Error(`mock-llm hang.until must be abort at line ${lineNo}`);
			}
			return { type: "hang", delayMs: validateDelayMs(event.delayMs, lineNo, `${modelId}.hang`), until: event.until as "abort" | undefined };
		case "error":
			if (event.kind !== "429" && event.kind !== "torn_json" && event.kind !== "abort") {
				throw new Error(`mock-llm error.kind must be 429 | torn_json | abort at line ${lineNo}`);
			}
			return {
				type: "error",
				kind: event.kind,
				delayMs: validateDelayMs(event.delayMs, lineNo, `${modelId}.error`),
				status: typeof event.status === "number" ? event.status : undefined,
				message: typeof event.message === "string" ? event.message : undefined,
				body: event.body,
			};
		case "stop":
			return {
				type: "stop",
				reason: normalizeStopReason(event.reason) as Extract<MockLLMStopReason, "stop" | "toolUse" | "length"> | undefined,
				delayMs: validateDelayMs(event.delayMs, lineNo, `${modelId}.stop`),
			};
		default:
			throw new Error(`mock-llm unsupported event type ${String(event.type)} at line ${lineNo}`);
	}
}

function validateTurn(raw: unknown, modelId: string, lineNo: number): MockLLLMTurn {
	assertPlainObject(raw, `turn at line ${lineNo}`);
	if (!Array.isArray(raw.events)) {
		throw new Error(`mock-llm ${modelId}.jsonl line ${lineNo}: turn missing events array`);
	}
	const turn: MockLLLMTurn = {
		name: typeof raw.name === "string" ? raw.name : undefined,
		stopReason: normalizeStopReason(raw.stopReason),
		events: raw.events.map((event) => validateEvent(event, modelId, lineNo)),
	};
	if (turn.events.length === 0) {
		throw new Error(`mock-llm ${modelId}.jsonl line ${lineNo}: turn must include at least one event`);
	}
	return turn;
}

export async function loadFixtureFile(modelId: string): Promise<MockLLMFixtureFile> {
	const cached = FIXTURE_CACHE.get(modelId);
	if (cached) return cached;

	const path = fixturePathFor(modelId);
	const content = await readFile(path, "utf8");
	const turns: MockLLLMTurn[] = [];
	for (const [index, line] of content.split(/\r?\n/).entries()) {
		const cleaned = stripComments(line);
		if (!cleaned) continue;
		turns.push(validateTurn(parseJsonLine(cleaned, modelId, index + 1), modelId, index + 1));
	}
	if (turns.length === 0) {
		throw new Error(`mock-llm fixture ${modelId} has no scripted turns`);
	}
	const file: MockLLMFixtureFile = { modelId, path, turns };
	FIXTURE_CACHE.set(modelId, file);
	return file;
}

export async function discoverFixtures(): Promise<MockLLMFixtureFile[]> {
	const entries = (await readdir(FIXTURE_DIR, { withFileTypes: true })).filter((entry) => entry.isFile() && extname(entry.name) === ".jsonl");
	entries.sort((a, b) => a.name.localeCompare(b.name));
	const fixtures: MockLLMFixtureFile[] = [];
	for (const entry of entries) {
		const modelId = basename(entry.name, ".jsonl");
		assertValidModelId(modelId);
		fixtures.push(await loadFixtureFile(modelId));
	}
	return fixtures;
}

export async function discoverModelConfigs(): Promise<ProviderModelConfig[]> {
	const fixtures = await discoverFixtures();
	return fixtures.map((fixture) => ({
		id: fixture.modelId,
		name: `Mock LLM — ${fixture.modelId}`,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
	}));
}

export async function listFixtureDiscovery(): Promise<MockLLMDiscovery[]> {
	const fixtures = await discoverFixtures();
	return fixtures.map((fixture) => ({ modelId: fixture.modelId, file: fixture.path, turnCount: fixture.turns.length }));
}

export function fixtureFilePath(modelId: string): string {
	return fixturePathFor(modelId);
}

export function fixtureDir(): string {
	return FIXTURE_DIR;
}

export function clearFixtureCache(): void {
	FIXTURE_CACHE.clear();
}
