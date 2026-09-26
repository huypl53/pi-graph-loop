// Helper: build a throwaway swarm state dir + cwd for caller-level tests (focus.ts reads
// `.pi/swarm/swarm-state.json` relative to cwd). Returns cleanup().
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

export async function mkTempState(state) {
	const cwd = await mkdtemp(join(tmpdir(), "h6-real-fix-"));
	const dir = join(cwd, ".pi", "swarm");
	spawnSync("mkdir", ["-p", dir]);
	await writeFile(join(dir, "swarm-state.json"), JSON.stringify(state, null, 2), "utf8");
	return {
		cwd,
		cleanup: async () => {
			await rm(cwd, { recursive: true, force: true });
		},
	};
}
