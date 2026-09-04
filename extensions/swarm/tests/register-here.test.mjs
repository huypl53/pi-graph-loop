// Tests for the "register here" / current-pane / panes-listing helpers in tmux.ts.
//
// These make adopting the CURRENT pi pane easy: an operator can run `/swarm register here <id> [role]`
// without first discovering the pane's tmux target. We cover: magic-token detection, pass-through of
// explicit targets, 'here' resolution inside/outside tmux, and pane listing with the current flag.
//
// Run: node extensions/swarm/register-here.test.mjs
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const { isHereToken, resolveRegisterTarget, currentPaneTarget, listAllPanes } = await import(join(here, "..", "src", "tmux.ts"));

// Minimal mock pi: only `exec` is used by the tmux helpers.
const mkPi = (tmuxImpl) => ({
	exec: async (cmd, args) => {
		if (cmd !== "tmux") return { code: 1, stdout: "", stderr: "" };
		return tmuxImpl(args);
	},
});

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log("  ok  ", n); } else { fail++; console.error("  FAIL", n); } };
const throws = async (n, p) => { try { await p; fail++; console.error("  FAIL", n, "(did not throw)"); } catch { pass++; console.log("  ok  ", n); } };

console.log("\n[1] isHereToken recognizes the magic 'current pane' tokens");
ok("here", isHereToken("here"));
ok("self", isHereToken("self"));
ok("current", isHereToken("current"));
ok(".", isHereToken("."));
ok("case-insensitive (HERE)", isHereToken("HERE"));
ok("whitespace-tolerant", isHereToken("  here  "));
ok("explicit target rejected", !isHereToken("mysess:0.1"));
ok("empty rejected", !isHereToken(""));

console.log("\n[2] resolveRegisterTarget passes explicit targets through unchanged (no tmux call)");
{
	let called = false;
	const pi = mkPi(async () => { called = true; return { code: 0, stdout: "", stderr: "" }; });
	const t = await resolveRegisterTarget(pi, "mysess:research.1");
	ok("explicit target unchanged", t === "mysess:research.1");
	ok("no tmux call for explicit target", called === false);
}

console.log("\n[3] 'here' resolves to the current pane target when inside tmux");
{
	process.env.TMUX = "/tmp/tmux-501/default,1234,0"; // pretend we are inside tmux
	const pi = mkPi(async (args) => {
		if (args[0] === "display-message") return { code: 0, stdout: "work\t0\t1\t%7\n", stderr: "" };
		return { code: 1, stdout: "", stderr: "" };
	});
	const cur = await currentPaneTarget(pi);
	ok("current pane detected", !!cur && cur.target === "work:0.1" && cur.paneId === "%7" && cur.session === "work");
	ok("here -> current target", await resolveRegisterTarget(pi, "here") === "work:0.1");
	ok("self -> current target", await resolveRegisterTarget(pi, "self") === "work:0.1");
	ok(". -> current target", await resolveRegisterTarget(pi, ".") === "work:0.1");
	delete process.env.TMUX;
}

console.log("\n[4] 'here' throws a clear, actionable error when not inside tmux");
{
	delete process.env.TMUX;
	const pi = mkPi(async () => ({ code: 0, stdout: "", stderr: "" }));
	let msg = "";
	try { await resolveRegisterTarget(pi, "here"); } catch (e) { msg = String(e.message || e); }
	ok("throws outside tmux", /not running inside tmux/i.test(msg));
	ok("error mentions /swarm panes", msg.includes("/swarm panes"));
}

console.log("\n[5] listAllPanes parses every pane, formats targets, and flags the current one");
{
	process.env.TMUX = "/tmp/tmux-501/default,1234,0";
	const pi = mkPi(async (args) => {
		if (args[0] === "display-message") return { code: 0, stdout: "work\t0\t1\t%7\n", stderr: "" };
		if (args[0] === "list-panes") return { code: 0, stdout: [
			"work\t0\t0\t%5\tbash\tlogs\t0",
			"work\t0\t1\t%7\tpi\tmain\t1",
			"other\t1\t0\t%9\tnode\tbuild\t1",
		].join("\n") + "\n", stderr: "" };
		return { code: 1, stdout: "", stderr: "" };
	});
	const panes = await listAllPanes(pi);
	ok("three panes listed", panes.length === 3);
	ok("target format session:window.pane", panes[1].target === "work:0.1" && panes[2].target === "other:1.0");
	ok("paneId + command captured", panes[1].paneId === "%7" && panes[1].command === "pi");
	ok("current pane flagged", panes.find((p) => p.current)?.paneId === "%7");
	ok("only one current pane", panes.filter((p) => p.current).length === 1);
	delete process.env.TMUX;
}

console.log("\n[6] listAllPanes returns [] when tmux is unavailable (no server / not in tmux)");
{
	delete process.env.TMUX;
	const pi = mkPi(async () => ({ code: 1, stdout: "", stderr: "no server running" }));
	const panes = await listAllPanes(pi);
	ok("empty list on tmux failure", Array.isArray(panes) && panes.length === 0);
}

console.log(`\n${fail === 0 ? "REGISTER-HERE PASS" : "REGISTER-HERE FAIL"} (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
