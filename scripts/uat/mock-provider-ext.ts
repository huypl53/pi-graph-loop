// UAT-only pi extension: registers two mock providers (mock-a, mock-b) backed by the local
// mock provider server (scripts/uat/mock-provider-server.mjs). Each provider exposes one model
// (mock-model) so a pool like [mock-a/mock-model, mock-b/mock-model] can rotate between them.
// Load with: pi -ne -e scripts/uat/mock-provider-ext.ts -e extensions/swarm/index.ts
export default function (pi: any) {
	const port = process.env.UAT_MOCK_PORT || "8787";
	const baseUrl = `http://127.0.0.1:${port}/v1`;
	const mkModel = () => ({
		id: "mock-model",
		name: "Mock model",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100000,
		maxTokens: 4096,
	});
	pi.registerProvider("mock-a", {
		baseUrl,
		apiKey: "sk-mock-a",
		api: "openai-completions",
		models: [mkModel()],
	});
	pi.registerProvider("mock-b", {
		baseUrl: `http://127.0.0.1:${process.env.UAT_MOCK_PORT_B || "8788"}/v1`,
		apiKey: "sk-mock-b",
		api: "openai-completions",
		models: [mkModel()],
	});
}
