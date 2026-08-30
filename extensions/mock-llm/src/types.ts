import type { AssistantMessage, Message, ToolCall } from "@earendil-works/pi-ai";

export type MockLLMStopReason = "stop" | "toolUse" | "length" | "error" | "aborted";

export type MockLLMFixtureEvent =
	| {
		  type: "text";
		  text: string;
		  delayMs?: number;
		  chunks?: string[];
	  }
	| {
		  type: "thinking";
		  text: string;
		  delayMs?: number;
		  chunks?: string[];
	  }
	| {
		  type: "toolcall";
		  name: string;
		  id?: string;
		  arguments: Record<string, unknown> | string;
		  delayMs?: number;
		  chunks?: string[];
	  }
	| {
		  type: "hang";
		  delayMs?: number;
		  until?: "abort";
	  }
	| {
		  type: "error";
		  kind: "429" | "torn_json" | "abort";
		  delayMs?: number;
		  status?: number;
		  message?: string;
		  body?: unknown;
	  }
	| {
		  type: "stop";
		  reason?: Extract<MockLLMStopReason, "stop" | "toolUse" | "length">;
		  delayMs?: number;
	  };

export interface MockLLLMTurn {
	name?: string;
	stopReason?: MockLLMStopReason;
	events: MockLLMFixtureEvent[];
}

export interface MockLLMFixtureFile {
	modelId: string;
	path: string;
	turns: MockLLLMTurn[];
}

export interface MockLLMDiscovery {
	modelId: string;
	file: string;
	turnCount: number;
}

export interface MockLLMTranscriptEvent {
	atMs: number;
	type: string;
	payload?: Record<string, unknown>;
}

export interface MockLLMTranscript {
	requestId: string;
	modelId: string;
	fixturePath: string;
	startedAt: string;
	finishedAt?: string;
	durationMs?: number;
	request: {
		systemPrompt?: string;
		messageCount: number;
		toolNames: string[];
		messages: Array<{
			role: Message["role"];
			preview?: string;
			contentBlocks?: number;
		}>;
	};
	events: MockLLLMTranscriptEvent[];
	final?: {
		status: "done" | "error";
		stopReason: AssistantMessage["stopReason"];
		errorMessage?: string;
	};
}

export interface MockLLLMRuntimeFixture {
	file: MockLLMFixtureFile;
	cursor: number;
}

export interface MockLLMFixtureLoadResult {
	fixtures: MockLLMFixtureFile[];
	models: MockLLLMTurn[];
}

export interface MockLLMToolCallBlock extends ToolCall {
	partialJson?: string;
}
