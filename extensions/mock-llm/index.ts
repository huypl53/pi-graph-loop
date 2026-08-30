import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { discoverModelConfigs } from "./src/fixtures.ts";
import { streamMockLLM } from "./src/stream.ts";

export default async function (pi: ExtensionAPI) {
	const models = await discoverModelConfigs();
	if (models.length === 0) {
		throw new Error("mock-llm extension requires at least one JSONL fixture under extensions/mock-llm/fixtures/");
	}

	pi.registerProvider("mock-llm", {
		name: "Mock LLM Fixture Provider",
		baseUrl: "http://127.0.0.1/mock-llm",
		apiKey: "sk-mock-llm",
		api: "mock-llm-stream",
		models,
		streamSimple: streamMockLLM,
	});
}
