#!/usr/bin/env node
// mailbox-oversized-line.test.mjs — RED-FIRST repro for task-fu-readmailbox-rss
// (reviewer-05 finding B: readMailbox fully parses oversized legacy mailbox lines;
// 200MB line = +609MB RSS per parse, every pump poll).
//
// RED symptoms (pre-fix, observed before any source change):
//   [R1] after readMailbox on a mailbox with 2 normal + 1 oversized line, NO durable
//        skip entry exists in .pi/swarm/traces/errors.jsonl
//        (op === "mailbox.oversized_line_skipped") — hard assertion;
//   [R2] readMailbox returns the oversized message as a fully parsed record instead
//        of skipping it (skipped lines must be INERT);
//   [R3] readMailboxSince incremental branch also parses the oversized line;
//   [R4] readMailboxLine (flow/collectors.ts sync path) JSON.parses the oversized line;
//   [R5] no per-process log-once ledger: pre-change nothing logs at all.
//
// GREEN contract (post-fix):
//   - oversized lines (well-formed but byteLength > PI_SWARM_MAILBOX_LINE_MAX_BYTES)
//     are skipped before JSON.parse; first encounter per process per
//     file:byteOffset:byteLength writes a durable logSwarmError entry naming
//     file + lineIndex + byteOffset + byteLength + cap; subsequent reads of the same
//     key add NO new entry (log-once ledger);
//   - the line STAYS in the file (append-only contract; no gc/quarantine here);
//   - readMailboxSince checkpoint still advances past the full byte length of the
//     skipped line;
//   - corrupt-but-SMALL lines keep the DISTINCT mailbox.corrupt_lines_ignored trace
//     path (corrupt ≠ oversized);
//   - normal-size lines parse byte-identically.
//
// SOFT guard (logged, NOT hard-fail in CI): heapUsed delta across readMailbox stays
// below 2 × oversizedLineBytes — RSS/heap measurement is allocator/timing dependent,
// so the binary red gate is the durable trace entry [R1], per plan §0.
//
// Cap lanes: the main process pins PI_SWARM_MAILBOX_LINE_MAX_BYTES=8192 (small-cap
// variant per plan §3 so CI does not depend on the 1 MiB default) and uses a real
// 50 MB oversized line for realism. A child process with the env var UNSET runs the
// DEFAULT-cap lane (2 MiB oversized line vs 1 MiB default) exactly once.
//
// Run: node extensions/swarm/tests/mailbox-oversized-line.test.mjs
import { rmSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

// Pin the read-side cap at process boot, BEFORE the dynamic imports below:
// constants.ts reads PI_SWARM_MAILBOX_LINE_MAX_BYTES at module load.
const CAP = 8192;
process.env.PI_SWARM_MAILBOX_LINE_MAX_BYTES = String(CAP);

const scratch = mkdtempSync(join(tmpdir(), `swarm-mailbox-oversize-${process.pid}-`));
rmSync(scratch, { recursive: true, force: true });
mkdirSync(join(scratch, ".pi", "swarm"), { recursive: true });

const { paths } = await import(join(here, "..", "src", "state.ts"));
const mailboxMod = await import(join(here, "..", "src", "mailbox.ts"));
const collectors = await import(join(here, "..", "src", "flow", "collectors.ts"));

const p = paths(scratch);
mkdirSync(p.mailboxes, { recursive: true });

const AGENT = "oversize";
const file = join(p.mailboxes, `${AGENT}.jsonl`);

let passed = 0;
let failed = 0;
function t(name, fn) {
	return Promise.resolve()
		.then(fn)
		.then(() => {
			passed++;
			console.log(`  ok   ${name}`);
		})
		.catch((err) => {
			failed++;
			console.log(`  FAIL ${name}: ${err?.message || err}`);
		});
}

function makeMsg(id, body) {
	return {
		id,
		swarmId: "swarm-test",
		from: "root",
		to: AGENT,
		subject: `s-${id}`,
		priority: "normal",
		type: "swarm.message",
		schemaVersion: 1,
		createdAt: new Date().toISOString(),
		body,
		requiresAck: false,
		requiresResponse: false,
	};
}

// === fixture: 2 normal lines + 1 oversized (50 MB) line ===
const OVERSIZE_BODY = "x".repeat(50 * 1024 * 1024);
const l1 = JSON.stringify(makeMsg("msg-n1", "hello one"));
const l2 = JSON.stringify(makeMsg("msg-n2", "hello two"));
const lBig = JSON.stringify(makeMsg("msg-oversize", OVERSIZE_BODY));
const bigBytes = Buffer.byteLength(lBig, "utf8");
const bigOffset = Buffer.byteLength(l1, "utf8") + 1 + Buffer.byteLength(l2, "utf8") + 1;
writeFileSync(file, `${l1}\n${l2}\n${lBig}\n`, "utf8");
const fileSize = Buffer.byteLength(`${l1}\n${l2}\n${lBig}\n`, "utf8");

function readErrors() {
	const ef = join(scratch, ".pi", "swarm", "traces", "errors.jsonl");
	if (!existsSync(ef)) return [];
	return readFileSync(ef, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((l) => {
			try {
				return JSON.parse(l);
			} catch {
				return null;
			}
		})
		.filter(Boolean);
}
function oversizeEntries() {
	return readErrors().filter((e) => e.op === "mailbox.oversized_line_skipped");
}

console.log(`\n[1] RED [R1]: durable skip entry absent pre-change (hard gate)`);
let heapBefore = 0;
let heapAfter = 0;
await t("readMailbox writes a durable mailbox.oversized_line_skipped entry naming file+lineIndex+byteOffset+byteLength", async () => {
	heapBefore = process.memoryUsage().heapUsed;
	const msgs = await mailboxMod.readMailbox(p, AGENT);
	// logSwarmError is async fire-and-forget from the sync guard; give the durable append a beat.
	await new Promise((r) => setTimeout(r, 250));
	heapAfter = process.memoryUsage().heapUsed;
	const entries = oversizeEntries();
	if (entries.length === 0)
		throw new Error("no mailbox.oversized_line_skipped entry in errors.jsonl (guard missing) — RED [R1]");
	const e = entries[0];
	if (!String(e.file || e.extra?.file || "").endsWith(`${AGENT}.jsonl`) && !String(e.error || "").includes(AGENT))
		throw new Error(`skip entry does not name the mailbox file: ${JSON.stringify(e).slice(0, 300)}`);
	const ex = e.extra || e;
	if (Number(ex.lineIndex) !== 3) throw new Error(`expected lineIndex 3 (1-based), got ${ex.lineIndex}`);
	if (Number(ex.byteOffset) !== bigOffset) throw new Error(`expected byteOffset ${bigOffset}, got ${ex.byteOffset}`);
	if (Number(ex.byteLength) !== bigBytes) throw new Error(`expected byteLength ${bigBytes}, got ${ex.byteLength}`);
});

console.log(`\n[2] GREEN contract: skipped line is INERT + STAYS in file`);
await t("readMailbox returns only the 2 normal messages (oversized never materialized)", async () => {
	const msgs = await mailboxMod.readMailbox(p, AGENT);
	const ids = msgs.map((m) => m.id).sort();
	if (JSON.stringify(ids) !== JSON.stringify(["msg-n1", "msg-n2"])) throw new Error(`unexpected ids: ${ids.join(",")}`);
	if (msgs.some((m) => m.id === "msg-oversize")) throw new Error("oversized line leaked into results — RED [R2]");
});
await t("oversized line STAYS in the file (append-only, no quarantine)", async () => {
	const raw = readFileSync(file, "utf8");
	if (!raw.includes(OVERSIZE_BODY.slice(0, 1024))) throw new Error("oversized line was removed/rewritten from the mailbox file");
	if (Buffer.byteLength(raw, "utf8") !== fileSize) throw new Error("mailbox file size changed");
});
await t("log-once ledger: second read adds NO new durable entry for the same file:offset:length key", async () => {
	const before = oversizeEntries().length;
	await mailboxMod.readMailbox(p, AGENT);
	const after = oversizeEntries().length;
	if (after !== before) throw new Error(`ledger not log-once: ${before} -> ${after} entries`);
});

console.log(`\n[3] GREEN contract: checkpoint semantics unchanged`);
await t("readMailboxSince(0) skips the oversized line and still advances the offset past its FULL byte length", async () => {
	const r = await mailboxMod.readMailboxSince(p, AGENT, 0);
	if (r.messages.some((m) => m.id === "msg-oversize")) throw new Error("oversized line parsed in incremental branch — RED [R3]");
	const ids = r.messages.map((m) => m.id).sort();
	if (JSON.stringify(ids) !== JSON.stringify(["msg-n1", "msg-n2"])) throw new Error(`unexpected ids: ${ids.join(",")}`);
	if (r.offset !== fileSize) throw new Error(`checkpoint did not advance past full line length: ${r.offset} != ${fileSize}`);
});

console.log(`\n[4] corrupt-small path stays DISTINCT from oversized path`);
await t("a corrupt-but-small line still routes through mailbox.corrupt_lines_ignored, not the oversize event", async () => {
	writeFileSync(file, `${l1}\n${l2}\n${lBig}\n{not json\n`, "utf8");
	const eventsBefore = existsSync(p.events) ? readFileSync(p.events, "utf8") : "";
	await mailboxMod.readMailbox(p, AGENT);
	const eventsAfter = existsSync(p.events) ? readFileSync(p.events, "utf8") : "";
	if (!eventsAfter.includes("mailbox.corrupt_lines_ignored")) throw new Error("corrupt small line did not hit corrupt_lines_ignored trace");
	const newOversize = oversizeEntries().filter((e) => Number((e.extra || e).byteLength) === Buffer.byteLength("{not json", "utf8"));
	if (newOversize.length > 0) throw new Error("small corrupt line misclassified as oversized");
	void eventsBefore;
	// restore fixture for later lanes
	writeFileSync(file, `${l1}\n${l2}\n${lBig}\n`, "utf8");
});

console.log(`\n[5] GREEN contract: sync path (flow/collectors.readMailboxLine) also skips`);
await t("readMailboxLine returns null for the oversized message id (never parses it) and still finds normal messages", async () => {
	const hit = await collectors.readMailboxLine(p, AGENT, "msg-n1");
	if (!hit || hit.body !== "hello one") throw new Error(`normal message not found via sync path: ${JSON.stringify(hit)}`);
	const oversize = await collectors.readMailboxLine(p, AGENT, "msg-oversize");
	if (oversize) throw new Error("oversized line materialized via sync path — RED [R4]");
});

console.log(`\n[6] constants surface: default 1 MiB + env-tunable + floor vs body cap`);
await t("child process (env unset): DEFAULT_MAILBOX_LINE_MAX_BYTES is 1 MiB; env floor = max(env, PI_SWARM_MESSAGE_BODY_MAX_BYTES)", () => {
	const script = `
		const c = await import(${JSON.stringify(join(here, "..", "src", "constants.ts"))});
		if (c.DEFAULT_MAILBOX_LINE_MAX_BYTES !== 1024 * 1024) throw new Error("default is not 1 MiB: " + c.DEFAULT_MAILBOX_LINE_MAX_BYTES);
		if (c.PI_SWARM_MAILBOX_LINE_MAX_BYTES !== 1024 * 1024) throw new Error("default env read is not 1 MiB: " + c.PI_SWARM_MAILBOX_LINE_MAX_BYTES);
		console.log("OK");
	`;
	const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
		env: { ...process.env, PI_SWARM_MAILBOX_LINE_MAX_BYTES: "" },
		encoding: "utf8",
	});
	if (!out.includes("OK")) throw new Error(`child did not confirm constants: ${out}`);
});
await t("child process (env=2048 < body cap): effective cap floors at PI_SWARM_MESSAGE_BODY_MAX_BYTES", () => {
	const script = `
		const c = await import(${JSON.stringify(join(here, "..", "src", "constants.ts"))});
		if (c.PI_SWARM_MAILBOX_LINE_MAX_BYTES !== Math.max(2048, c.PI_SWARM_MESSAGE_BODY_MAX_BYTES))
			throw new Error("floor violated: " + c.PI_SWARM_MAILBOX_LINE_MAX_BYTES);
		console.log("OK");
	`;
	const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
		env: { ...process.env, PI_SWARM_MAILBOX_LINE_MAX_BYTES: "2048" },
		encoding: "utf8",
	});
	if (!out.includes("OK")) throw new Error(`child did not confirm floor: ${out}`);
});

console.log(`\n[7] DEFAULT-cap lane (child process, env unset): 2 MiB oversized line skipped under 1 MiB default`);
await t("default-cap child: skip entry durable, oversized line inert, normal lines parse", () => {
	const childScript = `
		const { rmSync, mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const scratch = mkdtempSync(join(tmpdir(), "swarm-oversize-default-"));
		rmSync(scratch, { recursive: true, force: true });
		mkdirSync(join(scratch, ".pi", "swarm"), { recursive: true });
		const { paths } = await import(${JSON.stringify(join(here, "..", "src", "state.ts"))});
		const mb = await import(${JSON.stringify(join(here, "..", "src", "mailbox.ts"))});
		const p = paths(scratch);
		mkdirSync(p.mailboxes, { recursive: true });
		const AGENT = "defcap";
		const file = join(p.mailboxes, AGENT + ".jsonl");
		const msg = (id) => JSON.stringify({ id, type: "swarm.message", body: "b-" + id });
		const big = JSON.stringify({ id: "msg-big", type: "swarm.message", body: "y".repeat(2 * 1024 * 1024) });
		writeFileSync(file, msg("msg-ok") + "\\n" + big + "\\n");
		const msgs = await mb.readMailbox(p, AGENT);
		await new Promise((r) => setTimeout(r, 250)); // durable append settle (logSwarmError is async)
		if (msgs.length !== 1 || msgs[0].id !== "msg-ok") throw new Error("default-cap skip failed: " + msgs.map(m => m.id));
		const ef = join(scratch, ".pi", "swarm", "traces", "errors.jsonl");
		const raw = readFileSync(ef, "utf8");
		if (!raw.includes("mailbox.oversized_line_skipped")) throw new Error("no durable skip entry under default cap");
		console.log("OK");
	`;
	// readFileSync needed in child: pass via import
	const scriptWithImport = `const { readFileSync } = await import("node:fs");\n${childScript}`;
	const out = execFileSync(process.execPath, ["--input-type=module", "-e", scriptWithImport], {
		env: { ...process.env, PI_SWARM_MAILBOX_LINE_MAX_BYTES: "" },
		encoding: "utf8",
	});
	if (!out.includes("OK")) throw new Error(`default-cap child failed: ${out}`);
});

console.log(`\n[SOFT] heap guard (logged, not CI-hard): heapUsed delta across first readMailbox`);
const heapDelta = Math.max(0, heapAfter - heapBefore);
const budget = 2 * OVERSIZE_BODY.length;
console.log(`  heapBefore=${(heapBefore / 1e6).toFixed(1)}MB heapAfter=${(heapAfter / 1e6).toFixed(1)}MB delta=${(heapDelta / 1e6).toFixed(1)}MB budget=${(budget / 1e6).toFixed(1)}MB -> ${heapDelta < budget ? "within" : "OVER (soft, logged only)"}`);

rmSync(scratch, { recursive: true, force: true });
console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
