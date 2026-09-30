#!/usr/bin/env node
// === swarm-issues Phase 4 — read-only issue source validator CLI ===
//
// Thin CLI shell over the CANONICAL shared implementation (extensions/swarm/src/issues/source.ts).
// No validation logic is duplicated here; doc existence/containment checks mirror
// captureIssueSnapshot semantics WITHOUT writing anything. Zero writes, ever.
//
// Usage: node validate-issues.mjs [--source <path>] [--json] [--strict]
//   Exit 0 — valid (doc-problem warnings allowed in non-strict mode)
//   Exit 1 — invalid source / hard doc errors
//   Exit 2 — source file unreadable
import { statSync, realpathSync, readFileSync } from "node:fs";
import { isAbsolute, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const scriptDir = dirname(fileURLToPath(import.meta.url));
// Resolve the canonical implementation relative to this script:
// <ext>/issue-skills/swarm-issues/scripts -> <ext>/src/issues/source.ts
const canonicalPath = resolve(scriptDir, "../../../src/issues/source.ts");

const args = process.argv.slice(2);
let sourcePath = "issues.yml";
let asJson = false;
let strict = false;
for (let i = 0; i < args.length; i++) {
	if (args[i] === "--source") sourcePath = args[++i] ?? "";
	else if (args[i] === "--json") asJson = true;
	else if (args[i] === "--strict") strict = true;
	else if (args[i] === "--help" || args[i] === "-h") {
		console.log("Usage: node validate-issues.mjs [--source <path>] [--json] [--strict]");
		process.exit(0);
	}
}

if (isAbsolute(sourcePath) === false) sourcePath = resolve(process.cwd(), sourcePath);

function emit(json) {
	console.log(asJson ? JSON.stringify(json, null, 2) : json);
}

let yamlText;
try {
	yamlText = readFileSync(sourcePath, "utf8");
} catch (err) {
	const code = err?.code === "ENOENT" || err?.code === "EACCES" ? 2 : 2;
	if (asJson) emit({ ok: false, source: sourcePath, errors: [{ index: null, field: "source", code: err?.code ?? "read_error", message: String(err?.message || err) }] });
	else console.error(`validate-issues: cannot read ${sourcePath}: ${err?.message || err}`);
	process.exit(code);
}

const { validateIssuesSource, classifyDocPath, MAX_DOC_BYTES } = await import(canonicalPath);
const result = validateIssuesSource(yamlText);

// Doc checks: pure classification first (free), then fs existence/containment mirrors of
// captureIssueSnapshot's rules — still read-only.
const docProblems = [];
if (result.ok) {
	for (const issue of result.issues) {
		for (const doc of issue.docs) {
			const cls = classifyDocPath(dirname(sourcePath), doc);
			if (!cls.ok) {
				docProblems.push({ issue: issue.id, doc, code: cls.code, message: cls.message });
				continue;
			}
			const abs = resolve(dirname(sourcePath), cls.normalized);
			try {
				const real = realpathSync(abs);
				const rootReal = realpathSync(dirname(sourcePath));
				if (!real.startsWith(rootReal + "/") && real !== rootReal) {
					docProblems.push({ issue: issue.id, doc, code: "doc_escape", message: `resolves outside project root: ${real}` });
					continue;
				}
				const st = statSync(real);
				if (st.isDirectory()) docProblems.push({ issue: issue.id, doc, code: "doc_directory", message: "is a directory" });
				else if (st.size > MAX_DOC_BYTES) docProblems.push({ issue: issue.id, doc, code: "doc_oversize", message: `${st.size} bytes > ${MAX_DOC_BYTES}` });
			} catch (err) {
				docProblems.push({ issue: issue.id, doc, code: err?.code === "ENOENT" ? "doc_missing" : "doc_unreadable", message: String(err?.message || err) });
			}
		}
	}
}

const schemaErrors = result.ok ? [] : result.errors;
const hard = strict ? [...schemaErrors, ...docProblems] : schemaErrors;
const ok = hard.length === 0;

if (asJson) {
	emit({
		ok,
		source: sourcePath,
		strict,
		issues: result.ok ? result.issues.map((i) => ({ id: i.id, title: i.title, docs: i.docs })) : [],
		errors: hard,
		warnings: strict ? [] : docProblems,
	});
} else {
	if (!result.ok) {
		console.error(`issues.yml invalid (${schemaErrors.length} error(s)):`);
		for (const e of schemaErrors) console.error(`  - [${e.index ?? "-"}] ${e.field}: ${e.code} — ${e.message}`);
	}
	if (docProblems.length) {
		console[strict ? "error" : "log"](`${docProblems.length} doc problem(s)${strict ? "" : " (warnings; use --strict to fail)"}:`);
		for (const d of docProblems) console[strict ? "error" : "log"](`  - ${d.issue}: ${d.doc} → ${d.code} (${d.message})`);
	}
	if (ok) console.log(`issues.yml valid: ${result.ok ? result.issues.length : 0} issue(s).`);
}

process.exit(ok ? 0 : 1);
