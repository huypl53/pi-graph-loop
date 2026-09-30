// === swarm/src/issues/source.ts ===
//
// Canonical issue-source validation for `.pi/swarm/issues.yml` (swarm-issues Phase 2).
//
// STRICT PURITY CONTRACT: this module performs ZERO filesystem access and imports
// NOTHING from `@earendil-works` or `node:fs`. It is the single shared implementation
// that both the extension (TS import) and the future packaged `.mjs` script import, so
// validator behavior cannot diverge between `/swarm issues start` and the skill script
// (phase-04 release blocker). Filesystem realpath containment lives in the separate
// `checkDocPaths` helper here — also exported from this module but never called by
// `validateIssuesSource` — so `validateIssuesSource` remains pure (zero-mutation,
// zero-fs) by construction.
//
// Direction invariant: issues.yml is human-authored. Nothing in the runtime ever
// writes it back (no generated task/goal/status fields).

import { parse as parseYaml } from "yaml";

// --- Named bounds (overridable via validateIssuesSource opts for tests) ---

export const MAX_ISSUES = 50;
export const MAX_TITLE = 200;
export const MAX_CONTENT = 20_000;
export const MAX_DOC_COUNT = 10;
export const MAX_DOC_BYTES = 256_000;
export const MAX_SNAPSHOT_BYTES = 1_000_000;

// ID charset rule: lowercase alnum + `_`/`-`, must start alnum, 1..64 chars.
// Validated BEFORE any safeId-style coercion so distinct human ids cannot silently
// coalesce ("Foo Bar" vs "foo-bar") and duplicates are compared on the exact string.
export const ISSUE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export type IssueSource = {
	id: string;
	title: string;
	content: string;
	docs: string[];
};

export type IssueSourceError = {
	/** 0-based index of the offending entry in `issues: []`, when entry-scoped. */
	index?: number;
	/** The entry's id as authored (may be invalid), when extractable. */
	id?: string;
	/** Field name the error is about ("id" | "title" | "content" | "docs" | "issues" | "yaml"). */
	field: string;
	/** Stable machine code — assert on these in tests, never on message text. */
	code: string;
	message: string;
};

export type ValidateIssuesResult =
	| { ok: true; issues: IssueSource[] }
	| { ok: false; errors: IssueSourceError[] };

export type ValidateIssuesOpts = {
	maxIssues?: number;
	maxTitle?: number;
	maxContent?: number;
	maxDocCount?: number;
};

export type Bounds = {
	maxIssues: number;
	maxTitle: number;
	maxContent: number;
	maxDocCount: number;
	maxDocBytes: number;
	maxSnapshotBytes: number;
};

export function issueBounds(opts?: ValidateIssuesOpts): Bounds {
	return {
		maxIssues: opts?.maxIssues ?? MAX_ISSUES,
		maxTitle: opts?.maxTitle ?? MAX_TITLE,
		maxContent: opts?.maxContent ?? MAX_CONTENT,
		maxDocCount: opts?.maxDocCount ?? MAX_DOC_COUNT,
		maxDocBytes: MAX_DOC_BYTES,
		maxSnapshotBytes: MAX_SNAPSHOT_BYTES,
	};
}

const ALLOWED_KEYS = ["id", "title", "content", "docs"];

/**
 * Pure canonical validation of the issue source document.
 * NEVER reads or writes the filesystem and NEVER mutates state — safe to call from
 * read-only surfaces (`/swarm issues validate`, skill scripts) without side effects.
 */
export function validateIssuesSource(yamlText: string, opts?: ValidateIssuesOpts): ValidateIssuesResult {
	const bounds = issueBounds(opts);
	const errors: IssueSourceError[] = [];

	let doc: unknown;
	try {
		doc = parseYaml(yamlText);
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		return {
			ok: false,
			errors: [{ field: "yaml", code: "yaml_parse", message: `issues.yml is not parseable YAML: ${message}` }],
		};
	}

	if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
		return { ok: false, errors: [{ field: "issues", code: "root_not_mapping", message: "issues.yml must be a YAML mapping with an `issues` list" }] };
	}
	const root = doc as Record<string, unknown>;
	for (const key of Object.keys(root)) {
		if (key !== "issues") {
			errors.push({ field: "issues", code: "unknown_root_field", message: `unknown top-level field "${key}"; only "issues" is allowed` });
		}
	}
	const rawList = root.issues;
	if (!Array.isArray(rawList)) {
		errors.push({ field: "issues", code: "issues_not_list", message: "`issues` must be a YAML list of issue mappings" });
		return { ok: false, errors };
	}
	if (rawList.length === 0) {
		errors.push({ field: "issues", code: "issues_empty", message: "`issues` must contain at least one issue" });
		return { ok: false, errors };
	}
	if (rawList.length > bounds.maxIssues) {
		errors.push({ field: "issues", code: "too_many_issues", message: `issues list has ${rawList.length} entries; maximum is ${bounds.maxIssues}` });
		return { ok: false, errors };
	}

	const seenIds = new Set<string>();
	const issues: IssueSource[] = [];

	for (let i = 0; i < rawList.length; i++) {
		const entry = rawList[i];
		const err = (field: string, code: string, message: string) => errors.push({ index: i, field, code, message });

		if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
			err("issues", "entry_not_mapping", `issue #${i} must be a mapping`);
			continue;
		}
		const rec = entry as Record<string, unknown>;

		// Unknown-field rejection first, so a typo'd key never silently masks a schema error.
		for (const key of Object.keys(rec)) {
			if (!ALLOWED_KEYS.includes(key)) err(key, "unknown_field", `issue #${i} has unknown field "${key}"; allowed: ${ALLOWED_KEYS.join(", ")}`);
		}

		// --- id: validated BEFORE any safeId coercion; exact-string duplicate check ---
		const rawId = rec.id;
		if (rawId === undefined || rawId === null) {
			err("id", "id_missing", `issue #${i} is missing required field "id"`);
		} else if (typeof rawId !== "string") {
			err("id", "id_not_string", `issue #${i} id must be a string`);
		} else {
			const id = rawId.trim();
			if (id === "") {
				err("id", "id_blank", `issue #${i} id is blank`);
			} else if (id !== rawId) {
				err("id", "id_untrimmed", `issue #${i} id has leading/trailing whitespace; author it trimmed`);
			} else if (!ISSUE_ID_PATTERN.test(id)) {
				err("id", "id_unsafe", `issue #${i} id "${id}" must match ${String(ISSUE_ID_PATTERN)} (lowercase alnum/_/-, start alnum, max 64)`);
			} else if (seenIds.has(id)) {
				err("id", "id_duplicate", `issue #${i} duplicates id "${id}"`);
			} else {
				seenIds.add(id);
			}
		}

		// --- title ---
		const rawTitle = rec.title;
		if (rawTitle === undefined || rawTitle === null) {
			err("title", "title_missing", `issue #${i} is missing required field "title"`);
		} else if (typeof rawTitle !== "string") {
			err("title", "title_not_string", `issue #${i} title must be a string`);
		} else if (rawTitle.trim() === "") {
			err("title", "title_blank", `issue #${i} title is blank`);
		} else if (rawTitle.length > bounds.maxTitle) {
			err("title", "title_oversized", `issue #${i} title is ${rawTitle.length} chars; maximum is ${bounds.maxTitle}`);
		}

		// --- content ---
		const rawContent = rec.content;
		if (rawContent === undefined || rawContent === null) {
			err("content", "content_missing", `issue #${i} is missing required field "content"`);
		} else if (typeof rawContent !== "string") {
			err("content", "content_not_string", `issue #${i} content must be a string`);
		} else if (rawContent.trim() === "") {
			err("content", "content_blank", `issue #${i} content is blank`);
		} else if (rawContent.length > bounds.maxContent) {
			err("content", "content_oversized", `issue #${i} content is ${rawContent.length} chars; maximum is ${bounds.maxContent}`);
		}

		// --- docs ---
		const rawDocs = rec.docs;
		if (rawDocs === undefined || rawDocs === null) {
			err("docs", "docs_missing", `issue #${i} is missing required field "docs" (use [] for none)`);
		} else if (!Array.isArray(rawDocs) || rawDocs.some((d) => typeof d !== "string")) {
			err("docs", "docs_not_string_list", `issue #${i} docs must be a list of relative path strings`);
		} else if ((rawDocs as string[]).length > bounds.maxDocCount) {
			err("docs", "docs_too_many", `issue #${i} has ${(rawDocs as string[]).length} docs; maximum is ${bounds.maxDocCount}`);
		}

		// Normalize only fully-valid entries; if ANY error exists we return errors only.
		if (typeof rawId === "string" && typeof rawTitle === "string" && typeof rawContent === "string" && Array.isArray(rawDocs)) {
			issues.push({ id: rawId, title: rawTitle, content: rawContent, docs: rawDocs as string[] });
		}
	}

	if (errors.length > 0) return { ok: false, errors };
	return { ok: true, issues };
}

/**
 * PURE path-safety classification against the project root string — no filesystem.
 * Rejects absolute paths, `..` traversal, and non-normalized segments. Filesystem-level
 * containment (realpath/symlink escape/missing/directory) is `checkDocPaths` below.
 */
export type DocPathClass = { ok: true; normalized: string } | { ok: false; code: string; message: string };

export function classifyDocPath(root: string, docPath: string): DocPathClass {
	if (docPath.trim() === "") return { ok: false, code: "doc_blank", message: "doc path is blank" };
	if (docPath.startsWith("/") || /^[A-Za-z]:[\\/]/.test(docPath)) {
		return { ok: false, code: "doc_absolute", message: `doc path "${docPath}" must be relative to the project root` };
	}
	if (docPath.includes("\0")) return { ok: false, code: "doc_unsafe", message: `doc path "${docPath}" contains a NUL byte` };
	const segments = docPath.split("/");
	if (segments.some((s) => s === "..")) {
		return { ok: false, code: "doc_traversal", message: `doc path "${docPath}" must not contain ".."` };
	}
	const normalized = segments.filter((s) => s !== "" && s !== ".").join("/");
	if (normalized === "") return { ok: false, code: "doc_blank", message: `doc path "${docPath}" normalizes to empty` };
	// Root itself is always a safe containment prefix (root is a real project dir).
	return { ok: true, normalized };
}
