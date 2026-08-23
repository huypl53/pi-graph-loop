// Mock OpenAI-compatible provider server for swarm pool UAT.
// Scenarios controlled by writing JSON to <stateDir>/scenario.json:
//   { "mode": "ok" }                       — always succeed
//   { "mode": "error", "kind": "quota" }   — every request fails with that error kind
//   { "mode": "flaky", "failNext": N }     — fail N requests then succeed
//   { "mode": "raw", "status": 429, "body": {...} } — fail with an arbitrary verbatim payload (real-world captures)
// Error kinds -> realistic provider payloads (verbatim text the classifiers must handle):
//   quota:    429 "You exceeded your current quota, please check your plan and billing details"
//   rate_limit: 429 "Rate limit reached for requests"
//   auth:     401 "Incorrect API key provided"
//   transient: 500 "internal server error (overloaded)"
// Usage: node mock-provider-server.mjs <port> <stateDir>
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const port = parseInt(process.argv[2] || "8787", 10);
const stateDir = process.argv[3] || "/tmp/pool-uat";
const scenarioFile = join(stateDir, "scenario.json");

const ERRORS = {
	quota: { status: 429, body: { error: { message: "You exceeded your current quota, please check your plan and billing details", type: "insufficient_quota", code: "insufficient_quota" } } },
	rate_limit: { status: 429, body: { error: { message: "Rate limit reached for requests. Limit: 3 requests per minute.", type: "requests", code: "rate_limit_exceeded" } } },
	auth: { status: 401, body: { error: { message: "Incorrect API key provided: sk-mock. You can find your API key at https://platform.openai.com/account/api-keys.", type: "invalid_request_error", code: "invalid_api_key" } } },
	transient: { status: 500, body: { error: { message: "The server had an error while processing your request (overloaded).", type: "server_error", code: "internal_server_error" } } },
};

let failNextRemaining = 0;

async function readScenario() {
	try { return JSON.parse(await readFile(scenarioFile, "utf8")); }
	catch { return { mode: "ok" }; }
}

const server = createServer(async (req, res) => {
	if (!req.url?.includes("/chat/completions")) {
		res.writeHead(404).end();
		return;
	}
	// Drain body.
	let body = "";
	for await (const chunk of req) body += chunk;
	const scenario = await readScenario();

	let failKind = null;
	let rawError = null;
	if (scenario.mode === "raw") rawError = { status: scenario.status || 429, body: scenario.body };
	else if (scenario.mode === "error") failKind = scenario.kind || "quota";
	else if (scenario.mode === "flaky") {
		if (failNextRemaining > 0 || (scenario.failNext || 0) > 0) {
			if (failNextRemaining === 0) failNextRemaining = scenario.failNext;
			failNextRemaining--;
			failKind = scenario.kind || "transient";
		}
	}

	if (failKind || rawError) {
		const e = rawError || ERRORS[failKind];
		res.writeHead(e.status, { "content-type": "application/json" });
		res.end(JSON.stringify(e.body));
		console.log(`[${new Date().toISOString()}] ${failKind} FAIL (${e.status})`);
		return;
	}

	// Minimal SSE chat completion (one chunk then done).
	res.writeHead(200, { "content-type": "text/event-stream" });
	const chunks = [
		{ id: "chatcmpl-mock", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "mock-ok" }, finish_reason: null }] },
		{ id: "chatcmpl-mock", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
	];
	for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
	res.write("data: [DONE]\n\n");
	res.end();
	console.log(`[${new Date().toISOString()}] OK`);
});

server.listen(port, "127.0.0.1", () => console.log(`mock provider listening on 127.0.0.1:${port}, state=${scenarioFile}`));
