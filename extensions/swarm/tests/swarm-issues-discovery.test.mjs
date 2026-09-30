#!/usr/bin/env node
/**
 * swarm-issues Phase 4 — skill discovery suite (red-first).
 *
 * Contract (plan §8.1): the real extension factory registers a `resources_discover` handler
 * that returns `skillPaths` containing the extension's issue-skills directory; the
 * `swarm-issues` skill (SKILL.md, frontmatter name) exists on disk at that path. Verified
 * through the handler's REAL return value at the real pi event boundary — not identity prose.
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const extRoot = join(here, "..");
const src = join(extRoot, "src");
process.env.PI_SWARM_AGENT_ID = "root";
process.env.PI_SWARM_IS_ROOT = "1";

let passed = 0;
async function t(name, fn) {
	try {
		await fn();
		passed++;
		console.log(`  ok   ${name}`);
	} catch (err) {
		console.error(`  FAIL ${name}: ${err instanceof Error ? err.message : String(err)}`);
		process.exitCode = 1;
	}
}

function makePiSpy() {
	const handlers = {};
	return {
		handlers,
		on: (ev, fn) => {
			(handlers[ev] ??= []).push(fn);
		},
		off: () => {},
		registerTool: () => {},
		registerCommand: () => {},
		sendMessage: () => {},
		sendUserMessage: () => {},
		exec: async () => ({ code: 0, stdout: "", stderr: "" }),
		setModel: async () => true,
		getAllTools: () => [],
		getActiveTools: () => [],
		setActiveTools: () => {},
		ui: { notify: () => {}, setWidget: () => {}, setStatus: () => {}, setFooter: () => {} },
	};
}

await t("RED: factory registers a resources_discover handler", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "issues-disc-"));
	mkdirSync(join(cwd, ".pi", "swarm"), { recursive: true });
	const pi = makePiSpy();
	const factory = (await import(join(extRoot, "index.ts"))).default;
	factory(pi);
	const handlers = pi.handlers["resources_discover"] ?? [];
	assert.equal(handlers.length >= 1, true, `expected >=1 resources_discover handler, got ${handlers.length}`);
	rmSync(cwd, { recursive: true, force: true });
});

await t("RED: handler returns skillPaths containing the extension issue-skills dir (module-relative, absolute)", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "issues-disc-"));
	mkdirSync(join(cwd, ".pi", "swarm"), { recursive: true });
	const pi = makePiSpy();
	const factory = (await import(join(extRoot, "index.ts"))).default;
	factory(pi);
	const handler = pi.handlers["resources_discover"][0];
	const result = await handler({ cwd, reason: "startup" }, {});
	const paths = result?.skillPaths ?? [];
	const expected = join(extRoot, "issue-skills");
	assert.equal(
		paths.some((p) => p === expected),
		true,
		`skillPaths must include ${expected}; got ${JSON.stringify(paths)}`,
	);
	for (const p of paths) assert.equal(typeof p === "string" && p.startsWith("/"), true, "skillPaths entries must be absolute");
	rmSync(cwd, { recursive: true, force: true });
});

await t("RED: swarm-issues SKILL.md exists with canonical frontmatter name", async () => {
	const skillMd = join(extRoot, "issue-skills", "swarm-issues", "SKILL.md");
	assert.equal(existsSync(skillMd), true, `missing ${skillMd}`);
	const text = readFileSync(skillMd, "utf8");
	assert.equal(/^\s*---\n[\s\S]*?name:\s*swarm-issues[\s\S]*?---/.test(text), true, "frontmatter must declare name: swarm-issues");
	// bounded modes documented, read-only stance stated
	assert.equal(/validate-issues\.mjs/.test(text), true, "SKILL.md must reference the validator script");
	assert.equal(/show-active-issue\.mjs/.test(text), true, "SKILL.md must reference the viewer script");
	assert.equal(/read-only/i.test(text), true, "SKILL.md must state the read-only contract");
});

await t("RED: skill scripts exist on disk (exactly two)", async () => {
	const scriptsDir = join(extRoot, "issue-skills", "swarm-issues", "scripts");
	assert.equal(existsSync(scriptsDir), true, `missing ${scriptsDir}`);
	const files = (await import("node:fs")).readdirSync(scriptsDir).filter((f) => f.endsWith(".mjs")).sort();
	assert.deepEqual(files, ["show-active-issue.mjs", "validate-issues.mjs"], "exactly two .mjs scripts expected");
});

console.log(process.exitCode ? "\nswarm-issues-discovery: FAIL (red — implement pending)" : `\nswarm-issues-discovery: PASS (${passed})`);
