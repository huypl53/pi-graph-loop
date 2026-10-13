#!/usr/bin/env node
/**
 * create-task-coaching.test.mjs — S1 regression suite (task task-202610131005-task-intent-coach).
 *
 * RED-FIRST (AGENTS.md 2026-08-31): written and observed FAILING against HEAD before the
 * create.ts source change; the red log is archived under the task artifacts/red/ directory.
 *
 * Contract (plan §1 — prompt-only coaching, no new fields, no enforcement):
 *   C-1  swarm_create_task description teaches the existing-field mapping:
 *        outcome → goal; touch set → allowedFiles; observable done-conditions →
 *        acceptanceCriteria + validationCommands; per-node outputs → nodes[].writeArtifacts;
 *        NO rules field exists — constraints go into acceptanceCriteria or goal; material
 *        human decisions → qualificationMode:"human-discuss"; ask, don't invent structure.
 *   C-2  promptGuidelines gains ONE additional distinct entry (pi dedupes by trimmed string,
 *        agent-session.js _normalizePromptGuidelines ~L1254 — the new string must survive
 *        dedupe as a separate entry) stating the no-rules-field coaching + clarify-first steer.
 *   C-3  Both new strings stay tool-name-free beyond swarm_create_task itself (retired-surface
 *        D-style guards) and carry no model/provider hints (swarm-yaml-no-provider-hints shape).
 *
 * Assertions run at the REAL registration boundary (extension factory → pi.registerTool
 * capture), never at source-grep level, per the R10-1 discipline.
 *
 * Run: node extensions/swarm/tests/create-task-coaching.test.mjs
 */
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const mod = await import(join(here, "..", "index.ts"));
const factory = mod.default;
if (typeof factory !== "function") throw new Error("no default export");

const toolDefs = new Map();
factory({
	registerTool: (def) => {
		toolDefs.set(def.name, def);
	},
	registerCommand: () => {},
	on: () => {},
	exec: async () => ({ code: 0, stdout: "", stderr: "" }),
	sendMessage: () => {},
});

const create = toolDefs.get("swarm_create_task");
if (!create) throw new Error("swarm_create_task not registered by the factory");

let pass = 0,
	fail = 0;
const ok = (name, cond, info = "") => {
	if (cond) {
		pass++;
		console.log("  ok  ", name);
	} else {
		fail++;
		console.error("  FAIL", name, info);
	}
};

const description = typeof create.description === "string" ? create.description : "";
const guidelines = (create.promptGuidelines || []).map((g) => String(g).trim());

console.log("C-1: description teaches the existing-field mapping");
ok(
	"C-1.a: description maps outcome → goal",
	/goal/i.test(description) && /outcome/i.test(description),
	description.slice(-220),
);
ok(
	"C-1.b: description maps scope/touch set → allowedFiles",
	/allowedFiles/i.test(description),
	"(missing allowedFiles mapping)",
);
ok(
	"C-1.c: description maps done-conditions → acceptanceCriteria + validationCommands",
	/acceptanceCriteria/i.test(description) && /validationCommands/i.test(description),
	"(missing acceptance/validation mapping)",
);
ok(
	"C-1.d: description maps per-node outputs → nodes[].writeArtifacts",
	/writeArtifacts/i.test(description),
	"(missing writeArtifacts mapping)",
);
ok(
	"C-1.e: description states there is NO rules field (constraints → acceptanceCriteria or goal)",
	/no rules field/i.test(description) && /acceptanceCriteria|goal/i.test(description),
	"(missing no-rules-field statement)",
);
ok(
	"C-1.f: description routes material human decisions to qualificationMode human-discuss",
	/qualificationMode/i.test(description) && /human-discuss/i.test(description),
	"(missing qualificationMode human-discuss)",
);
ok(
	"C-1.g: description steers to ask rather than invent structure",
	/ask/i.test(description) && /invent/i.test(description),
	"(missing ask-don't-invent steer)",
);

console.log("C-2: promptGuidelines gains a distinct no-rules-field coaching entry");
const coaching = guidelines.find(
	(g) => /no rules field/i.test(g) && /qualificationMode/i.test(g) && /human-discuss/i.test(g),
);
ok("C-2.a: a coaching guideline entry exists (no-rules-field + qualificationMode)", Boolean(coaching), guidelines.join(" | ").slice(0, 300));
ok(
	"C-2.b: the coaching entry is DISTINCT from the existing registration guideline (dedupe survival)",
	guidelines.length >= 2 && new Set(guidelines).size === guidelines.length,
	`entries=${guidelines.length}`,
);
ok(
	"C-2.c: the coaching entry steers clarification for materially ambiguous asks",
	/ask/i.test(coaching || "") || /ambigu/i.test(coaching || ""),
	coaching || "(none)",
);

console.log("C-3: string hygiene (no retired tool names, no provider hints)");
const both = [description, ...guidelines].join("\n");
const toolNames = [...both.matchAll(/\bswarm_[a-z0-9_]+\b/g)].map((m) => m[0]);
ok(
	"C-3.a: no swarm_ tool names beyond swarm_create_task itself",
	toolNames.every((n) => n === "swarm_create_task"),
	`found=${[...new Set(toolNames)].join(",")}`,
);
ok(
	"C-3.b: no model/provider hints",
	!/zai-coding-cn|openai|glm-5|gpt-|claude-|anthropic/i.test(both),
	"(provider token found)",
);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
