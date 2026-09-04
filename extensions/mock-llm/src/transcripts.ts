import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { MockLLMTranscript } from "./types.ts";

function resolveTranscriptRoot(): string {
	return process.env.PI_MOCK_LLM_TRANSCRIPTS_DIR ?? join(process.cwd(), ".pi", "mock-llm", "transcripts");
}

export function sanitizeTranscriptSegment(segment: string): string {
	return segment.replace(/[^a-zA-Z0-9._-]/g, "-");
}

export async function writeTranscript(transcript: MockLLMTranscript): Promise<string> {
	const root = resolveTranscriptRoot();
	const dir = join(root, sanitizeTranscriptSegment(transcript.modelId));
	await mkdir(dir, { recursive: true });
	const filename = `${transcript.startedAt.replace(/[:.]/g, "-")}-${sanitizeTranscriptSegment(transcript.requestId)}.json`;
	const path = join(dir, filename);
	await writeFile(path, `${JSON.stringify(transcript, null, 2)}\n`, "utf8");
	return path;
}

export function transcriptRoot(): string {
	return resolveTranscriptRoot();
}
