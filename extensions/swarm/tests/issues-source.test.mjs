#!/usr/bin/env node
/**
 * swarm-issues Phase 2 — canonical source validator tests (issues-source.test.mjs).
 *
 * Covers the approved plan §2 matrix:
 *   - valid minimal YAML normalizes deterministically
 *   - unknown/missing/blank fields, oversized fields, too many issues → typed errors
 *   - IDs validated BEFORE safeId coercion: exact-string duplicates, unsafe charset,
 *     untrimmed ids rejected; "Foo Bar"/"foo-bar" cannot coalesce
 *   - pure path classification: absolute, traversal, blank, NUL
 *   - ZERO MUTATION: validate + classify never write issues.yml or swarm-state.json
 *     (hash + mtime probes)
 *
 * Deterministic, offline, scratch-cwd only. Exit nonzero on any failure.
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const src = join(here, "..", "src");
const { validateIssuesSource, classifyDocPath, issueBounds, MAX_ISSUES } = await import(join(src, "issues", "source.ts"));

let passed = 0;
function t(name, fn) {
	try {
		fn();
		passed++;
		console.log(`  ok   ${name}`);
	} catch (err) {
		console.error(`  FAIL ${name}: ${err instanceof Error ? err.message : String(err)}`);
		process.exitCode = 1;
	}
}
const codes = (r) => (r.ok ? [] : r.errors.map((e) => e.code));
const yamlOf = (body) => `issues:\n${body}`;

const VALID = yamlOf(
	"  - id: fix-login\n    title: Fix login flow\n    content: Patch the session refresh.\n    docs: [docs/auth.md]\n  - id: add-tests\n    title: Add tests\n    content: Cover the auth edge cases.\n    docs: []\n",
);

// --- scratch world for the zero-mutation probe ---
const cwd = mkdtempSync(join(tmpdir(), "issues-source-"));
mkdirSync(join(cwd, ".pi", "swarm"), { recursive: true });
mkdirSync(join(cwd, "docs"), { recursive: true });
writeFileSync(join(cwd, "docs", "auth.md"), "# auth\n");
const issuesPath = join(cwd, ".pi", "swarm", "issues.yml");
writeFileSync(issuesPath, VALID);
const statePath = join(cwd, ".pi", "swarm", "swarm-state.json");
writeFileSync(statePath, "{}\n");
const digest = (p) => createHash("sha256").update(readFileSync(p)).digest("hex") + ":" + String(statSync(p).mtimeMs);
const before = { issues: digest(issuesPath), state: digest(statePath) };

t("valid minimal YAML normalizes deterministically (stable order, trimmed structure)", () => {
	const a = validateIssuesSource(VALID);
	const b = validateIssuesSource(VALID);
	assert.equal(a.ok, true);
	assert.deepEqual(a.issues, b.issues);
	assert.deepEqual(a.issues.map((i) => i.id), ["fix-login", "add-tests"]);
	assert.deepEqual(a.issues[0].docs, ["docs/auth.md"]);
});

t("unknown root field rejected", () => {
	const r = validateIssuesSource("issues: []\npriority: high\n");
	assert.ok(codes(r).includes("unknown_root_field"));
	assert.ok(codes(r).includes("issues_empty"));
});

t("unknown entry field rejected with index+field", () => {
	const r = validateIssuesSource(yamlOf("  - id: a\n    title: T\n    content: C\n    docs: []\n    status: queued\n"));
	assert.deepEqual(codes(r), ["unknown_field"]);
	assert.equal(r.errors[0].index, 0);
	assert.equal(r.errors[0].field, "status");
});

t("missing required fields produce per-field typed errors", () => {
	const r = validateIssuesSource(yamlOf("  - title: T\n    content: C\n    docs: []\n"));
	assert.ok(codes(r).includes("id_missing"));
	const r2 = validateIssuesSource(yamlOf("  - id: a\n    docs: []\n"));
	assert.deepEqual(codes(r2).filter((c) => c.endsWith("_missing")).sort(), ["content_missing", "title_missing"]);
	const r3 = validateIssuesSource(yamlOf("  - id: a\n    title: T\n    content: C\n"));
	assert.deepEqual(codes(r3), ["docs_missing"]);
});

t("blank title/content/id rejected", () => {
	const r = validateIssuesSource(yamlOf("  - id: \"\"\n    title: \"   \"\n    content: \"\"\n    docs: []\n"));
	assert.deepEqual(codes(r), ["id_blank", "title_blank", "content_blank"]);
});

t("duplicate ids detected on exact string", () => {
	const r = validateIssuesSource(yamlOf("  - id: a\n    title: T\n    content: C\n    docs: []\n  - id: a\n    title: U\n    content: D\n    docs: []\n"));
	assert.deepEqual(codes(r), ["id_duplicate"]);
	assert.equal(r.errors[0].index, 1);
});

t("IDs validated BEFORE safeId coercion: 'Foo Bar' and 'foo-bar' cannot coalesce", () => {
	// Both are rejected by the charset rule — safeId would map "Foo Bar" to "foo-bar" and
	// silently merge two distinct issues. The pre-coercion rule makes that impossible.
	const r = validateIssuesSource(yamlOf("  - id: Foo Bar\n    title: T\n    content: C\n    docs: []\n  - id: foo-bar\n    title: U\n    content: D\n    docs: []\n"));
	assert.deepEqual(codes(r), ["id_unsafe"]);
});

t("unsafe/oversized/untrimmed ids rejected", () => {
	for (const [body, code] of [
		["  - id: \"-lead\"\n    title: T\n    content: C\n    docs: []\n", "id_unsafe"],
		["  - id: \"" + "a".repeat(65) + "\"\n    title: T\n    content: C\n    docs: []\n", "id_unsafe"],
		["  - id: \"  a  \"\n    title: T\n    content: C\n    docs: []\n", "id_untrimmed"],
		["  - id: 42\n    title: T\n    content: C\n    docs: []\n", "id_not_string"],
	]) {
		assert.deepEqual(codes(validateIssuesSource(yamlOf(body))), [code]);
	}
});

t("oversized title/content rejected with deterministic bounds", () => {
	const b = issueBounds();
	const r = validateIssuesSource(yamlOf(`  - id: a\n    title: "${"x".repeat(b.maxTitle + 1)}"\n    content: C\n    docs: []\n`));
	assert.deepEqual(codes(r), ["title_oversized"]);
	const r2 = validateIssuesSource(yamlOf(`  - id: a\n    title: T\n    content: "${"y".repeat(b.maxContent + 1)}"\n    docs: []\n`));
	assert.deepEqual(codes(r2), ["content_oversized"]);
});

t("too many issues rejected", () => {
	const entries = Array.from({ length: MAX_ISSUES + 1 }, (_, i) => `  - id: i${i}\n    title: T\n    content: C\n    docs: []`).join("\n");
	const r = validateIssuesSource(yamlOf(entries));
	assert.deepEqual(codes(r), ["too_many_issues"]);
});

t("custom bound overrides are honored (test seam)", () => {
	const r = validateIssuesSource(yamlOf("  - id: a\n    title: T\n    content: C\n    docs: []\n  - id: b\n    title: U\n    content: D\n    docs: []\n"), { maxIssues: 1 });
	assert.deepEqual(codes(r), ["too_many_issues"]);
});

t("YAML syntax error is a single typed error", () => {
	const r = validateIssuesSource("issues: [unbalanced");
	assert.deepEqual(codes(r), ["yaml_parse"]);
});

t("non-mapping root / non-list issues rejected", () => {
	assert.deepEqual(codes(validateIssuesSource("- a\n- b\n")), ["root_not_mapping"]);
	assert.deepEqual(codes(validateIssuesSource("issues: 5\n")), ["issues_not_list"]);
	assert.deepEqual(codes(validateIssuesSource("issues: []\n")), ["issues_empty"]);
	assert.deepEqual(codes(validateIssuesSource(yamlOf("  - just a string\n"))), ["entry_not_mapping"]);
});

t("docs must be a list of strings; count bounded", () => {
	assert.deepEqual(codes(validateIssuesSource(yamlOf("  - id: a\n    title: T\n    content: C\n    docs: [1, 2]\n"))), ["docs_not_string_list"]);
	const docs = Array.from({ length: issueBounds().maxDocCount + 1 }, (_, i) => `"d${i}.md"`).join(", ");
	assert.deepEqual(codes(validateIssuesSource(yamlOf(`  - id: a\n    title: T\n    content: C\n    docs: [${docs}]\n`))), ["docs_too_many"]);
});

// --- pure path classification ---
t("classifyDocPath rejects absolute/traversal/blank/NUL without fs", () => {
	assert.equal(classifyDocPath(cwd, "/etc/passwd").code, "doc_absolute");
	assert.equal(classifyDocPath(cwd, "C:\\x.md").code, "doc_absolute");
	assert.equal(classifyDocPath(cwd, "../outside.md").code, "doc_traversal");
	assert.equal(classifyDocPath(cwd, "docs/../../outside.md").code, "doc_traversal");
	assert.equal(classifyDocPath(cwd, "  ").code, "doc_blank");
	assert.equal(classifyDocPath(cwd, "a\0b").code, "doc_unsafe");
	const okc = classifyDocPath(cwd, "docs/auth.md");
	assert.equal(okc.ok, true);
	assert.equal(okc.normalized, "docs/auth.md");
});

t("ZERO MUTATION: validate + classify leave issues.yml and swarm-state.json byte-identical", () => {
	// exercise the hot paths several times, including a file the classifier would reject
	for (let i = 0; i < 5; i++) {
		validateIssuesSource(VALID);
		validateIssuesSource("issues: [bad");
		classifyDocPath(cwd, "../escape.md");
	}
	assert.equal(digest(issuesPath), before.issues, "issues.yml must be untouched");
	assert.equal(digest(statePath), before.state, "swarm-state.json must be untouched");
});

try {
	rmSync(cwd, { recursive: true, force: true });
} catch (err) {
	// Scratch cleanup is best-effort; a held temp dir does not affect correctness.
	// eslint-disable-next-line no-console
	console.log(`  note scratch cleanup skipped: ${err instanceof Error ? err.message : String(err)}`);
}

console.log(process.exitCode ? "\nissues-source: FAIL" : `\nissues-source: PASS (${passed} assertions)`);
