import { randomUUID } from "node:crypto";
import { createAssistantMessageEventStream, type AssistantMessage, type AssistantMessageEventStream, type Context, type Message, type Model, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { loadFixtureFile } from "./fixtures.ts";
import { writeTranscript } from "./transcripts.ts";
import type { MockLLMFixtureEvent, MockLLMStopReason, MockLLMTranscript, MockLLMTranscriptEvent, MockLLMToolCallBlock } from "./types.ts";

const runtimeTurnCursor = new Map<string, number>();

function nowMs(): number {
	return Date.now();
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	if (ms <= 0) return Promise.resolve();
	if (signal?.aborted) {
		return Promise.reject(new Error("Request was aborted"));
	}
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(new Error("Request was aborted"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

function waitForAbort(signal?: AbortSignal): Promise<never> {
	if (!signal) return new Promise(() => undefined as never);
	if (signal.aborted) return Promise.reject(new Error("Request was aborted"));
	return new Promise((_, reject) => {
		const onAbort = () => {
			signal.removeEventListener("abort", onAbort);
			reject(new Error("Request was aborted"));
		};
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

function sanitizeMessagePreview(message: Message): string | undefined {
	if (message.role === "user" && typeof message.content === "string") return message.content.slice(0, 200);
	if (message.role === "user" && Array.isArray(message.content)) {
		return message.content
			.map((block) => (block.type === "text" ? block.text : block.type === "image" ? "[image]" : "[other]"))
			.join("\n")
			.slice(0, 200);
	}
	if (message.role === "assistant") {
		return message.content
			.map((block) => {
				if (block.type === "text") return block.text;
				if (block.type === "thinking") return block.thinking;
				if (block.type === "toolCall") return `[toolcall:${block.name}]`;
				return "";
			})
			.join("\n")
			.slice(0, 200);
	}
	if (message.role === "toolResult") return `[toolResult:${message.toolCallId}]`;
	return undefined;
}

function summarizeContext(context: Context): MockLLMTranscript["request"] {
	return {
		systemPrompt: context.systemPrompt,
		messageCount: context.messages.length,
		toolNames: context.tools?.map((tool) => tool.name) ?? [],
		messages: context.messages.map((message) => ({
			role: message.role,
			preview: sanitizeMessagePreview(message),
			contentBlocks: message.role === "assistant" ? message.content.length : undefined,
		})),
	};
}

function createOutput(model: Model<any>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "pending",
		timestamp: nowMs(),
	};
}

function pushTextChunks(
	stream: AssistantMessageEventStream,
	output: AssistantMessage,
	text: string,
	chunks: string[] | undefined,
	transcript: MockLLMTranscript,
	start: number,
	label: "text" | "thinking",
): void {
	const contentIndex = output.content.length;
	if (label === "text") {
		(output.content as any).push({ type: "text", text: "" });
		stream.push({ type: "text_start", contentIndex, partial: output });
		transcript.events.push({ atMs: nowMs() - start, type: "text_start", payload: { contentIndex } });
	} else {
		(output.content as any).push({ type: "thinking", thinking: "", thinkingSignature: "" });
		stream.push({ type: "thinking_start", contentIndex, partial: output });
		transcript.events.push({ atMs: nowMs() - start, type: "thinking_start", payload: { contentIndex } });
	}

	const parts = chunks && chunks.length > 0 ? chunks : [text];
	const block = output.content[contentIndex] as { type: string; text?: string; thinking?: string };
	for (const part of parts) {
		if (label === "text") {
			block.text = `${block.text ?? ""}${part}`;
			stream.push({ type: "text_delta", contentIndex, delta: part, partial: output });
			transcript.events.push({ atMs: nowMs() - start, type: "text_delta", payload: { contentIndex, delta: part } });
		} else {
			block.thinking = `${block.thinking ?? ""}${part}`;
			stream.push({ type: "thinking_delta", contentIndex, delta: part, partial: output });
			transcript.events.push({ atMs: nowMs() - start, type: "thinking_delta", payload: { contentIndex, delta: part } });
		}
	}

	if (label === "text") {
		stream.push({ type: "text_end", contentIndex, content: block.text ?? "", partial: output });
		transcript.events.push({ atMs: nowMs() - start, type: "text_end", payload: { contentIndex, content: block.text ?? "" } });
	} else {
		stream.push({ type: "thinking_end", contentIndex, content: block.thinking ?? "", partial: output });
		transcript.events.push({ atMs: nowMs() - start, type: "thinking_end", payload: { contentIndex, content: block.thinking ?? "" } });
	}
}

function parseToolCallJson(partialJson: string): Record<string, unknown> {
	return JSON.parse(partialJson) as Record<string, unknown>;
}

function pushToolCall(
	stream: AssistantMessageEventStream,
	output: AssistantMessage,
	event: Extract<MockLLMFixtureEvent, { type: "toolcall" }>,
	transcript: MockLLMTranscript,
	start: number,
): void {
	const contentIndex = output.content.length;
	const block: MockLLMToolCallBlock = {
		type: "toolCall",
		id: event.id ?? `mock-${randomUUID()}`,
		name: event.name,
		arguments: {},
		partialJson: "",
	};
	(output.content as any).push(block);
	stream.push({ type: "toolcall_start", contentIndex, partial: output });
	transcript.events.push({ atMs: nowMs() - start, type: "toolcall_start", payload: { contentIndex, name: event.name, id: block.id } });

	const raw = typeof event.arguments === "string" ? event.arguments : JSON.stringify(event.arguments);
	const parts = event.chunks && event.chunks.length > 0 ? event.chunks : [raw];
	for (const part of parts) {
		block.partialJson = `${block.partialJson ?? ""}${part}`;
		try {
			block.arguments = parseToolCallJson(block.partialJson);
		} catch {
			// keep accumulating until end
		}
		stream.push({ type: "toolcall_delta", contentIndex, delta: part, partial: output });
		transcript.events.push({ atMs: nowMs() - start, type: "toolcall_delta", payload: { contentIndex, delta: part } });
	}

	try {
		block.arguments = parseToolCallJson(block.partialJson ?? raw);
	} catch (error) {
		throw new Error(`torn_json: ${(error as Error)?.message || String(error)}`);
	}
	delete block.partialJson;
	stream.push({ type: "toolcall_end", contentIndex, toolCall: block as unknown as any, partial: output });
	transcript.events.push({ atMs: nowMs() - start, type: "toolcall_end", payload: { contentIndex, name: block.name, id: block.id } });
}

function stopReasonFromTurn(turnReason: MockLLMStopReason | undefined): Extract<MockLLMStopReason, "stop" | "toolUse" | "length"> {
	return (turnReason === "toolUse" || turnReason === "length" ? turnReason : "stop") as Extract<MockLLMStopReason, "stop" | "toolUse" | "length">;
}

function errorMessageForEvent(event: Extract<MockLLMFixtureEvent, { type: "error" }>): string {
	if (event.message) return event.message;
	if (event.kind === "429") {
		const body = event.body ?? {
			error: {
				message: "You exceeded your current quota, please check your plan and billing details",
				type: "insufficient_quota",
				code: "insufficient_quota",
			},
		};
		return `429: ${JSON.stringify(body)}`;
	}
	if (event.kind === "torn_json") return "Unexpected end of JSON input";
	return "Request was aborted";
}

async function replayTurn(
	stream: AssistantMessageEventStream,
	output: AssistantMessage,
	fixturePath: string,
	turn: { name?: string; stopReason?: MockLLMStopReason; events: MockLLMFixtureEvent[] },
	context: Context,
	options: SimpleStreamOptions | undefined,
	model: Model<any>,
): Promise<void> {
	const startedAtIso = new Date().toISOString();
	const requestId = `mockllm-${randomUUID()}`;
	const start = nowMs();
	const transcript: MockLLMTranscript = {
		requestId,
		modelId: model.id,
		fixturePath,
		startedAt: startedAtIso,
		request: summarizeContext(context),
		events: [],
	};

	const record = (type: string, payload?: Record<string, unknown>) => {
		transcript.events.push({ atMs: nowMs() - start, type, payload });
	};

	try {
		stream.push({ type: "start", partial: output });
		record("start", { turn: turn.name, stopReason: turn.stopReason, messageCount: context.messages.length });

		for (const event of turn.events) {
			if (event.delayMs) await sleep(event.delayMs, options?.signal);
			if (options?.signal?.aborted) throw new Error("Request was aborted");

			switch (event.type) {
				case "text":
					pushTextChunks(stream, output, event.text, event.chunks, transcript, start, "text");
					break;
				case "thinking":
					pushTextChunks(stream, output, event.text, event.chunks, transcript, start, "thinking");
					break;
				case "toolcall":
					pushToolCall(stream, output, event, transcript, start);
					break;
				case "hang":
					record("hang", { until: event.until ?? "abort" });
					await waitForAbort(options?.signal);
					break;
				case "error": {
					const message = errorMessageForEvent(event);
					record("error", { kind: event.kind, status: event.status ?? (event.kind === "429" ? 429 : undefined), message });
					throw new Error(message);
				}
				case "stop":
					output.stopReason = event.reason ?? stopReasonFromTurn(turn.stopReason);
					record("stop", { reason: output.stopReason });
					break;
			}
		}

		if (output.stopReason === "pending") {
			output.stopReason = stopReasonFromTurn(turn.stopReason);
			record("stop", { reason: output.stopReason });
		}

		if (options?.signal?.aborted) {
			throw new Error("Request was aborted");
		}
		if (output.stopReason === "error" || output.stopReason === "aborted") {
			throw new Error(output.errorMessage || "An unknown error occurred");
		}

		stream.push({ type: "done", reason: output.stopReason as Extract<MockLLMStopReason, "stop" | "length" | "toolUse">, message: output });
		transcript.events.push({ atMs: nowMs() - start, type: "done", payload: { reason: output.stopReason } });
		transcript.finishedAt = new Date().toISOString();
		transcript.durationMs = nowMs() - start;
		transcript.final = { status: "done", stopReason: output.stopReason };
		await writeTranscript(transcript);
		stream.end(output);
	} catch (error) {
		output.stopReason = options?.signal?.aborted ? "aborted" : "error";
		output.errorMessage = error instanceof Error ? error.message : String(error);
		stream.push({ type: "error", reason: output.stopReason as Extract<MockLLMStopReason, "aborted" | "error">, error: output });
		transcript.events.push({ atMs: nowMs() - start, type: "error", payload: { reason: output.stopReason, errorMessage: output.errorMessage } });
		transcript.finishedAt = new Date().toISOString();
		transcript.durationMs = nowMs() - start;
		transcript.final = { status: "error", stopReason: output.stopReason, errorMessage: output.errorMessage };
		await writeTranscript(transcript);
		stream.end(output);
	}
}

export function streamMockLLM(
	model: Model<any>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	void (async () => {
		const output = createOutput(model);
		const fixture = await loadFixtureFile(model.id);
		const nextIndex = runtimeTurnCursor.get(model.id) ?? 0;
		const turn = fixture.turns[nextIndex];
		runtimeTurnCursor.set(model.id, nextIndex + 1);
		if (!turn) {
			stream.push({ type: "start", partial: output });
			output.stopReason = "error";
			output.errorMessage = `script_exhausted: model ${model.id} has no scripted turn left`;
			stream.push({ type: "error", reason: "error", error: output });
			const exhaustedTranscript = {
				requestId: `mockllm-${randomUUID()}`,
				modelId: model.id,
				fixturePath: fixture.path,
				startedAt: new Date().toISOString(),
				finishedAt: new Date().toISOString(),
				durationMs: 0,
				request: summarizeContext(context),
				events: [
					{ atMs: 0, type: "start", payload: { exhausted: true, turnIndex: nextIndex } },
					{ atMs: 0, type: "error", payload: { message: output.errorMessage } },
				],
				final: { status: "error", stopReason: "error", errorMessage: output.errorMessage },
			};
			await writeTranscript(exhaustedTranscript);
			stream.end(output);
			return;
		}
		await replayTurn(stream, output, fixture.path, turn, context, options, model);
	})();
	return stream;
}

export function resetMockLLMCursor(modelId?: string): void {
	if (modelId) runtimeTurnCursor.delete(modelId);
	else runtimeTurnCursor.clear();
}
