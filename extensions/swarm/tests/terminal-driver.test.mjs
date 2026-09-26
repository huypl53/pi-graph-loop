import { ok as assertOk, equal, deepEqual } from "node:assert/strict";
import { tmuxDriver, TmuxDriver, MockTerminalDriver, isRootHostPane, isPiLikeCommand, isHereToken } from "../src/terminal/index.ts";

let pass = 0;
let fail = 0;
function test(name, fn) {
	try {
		fn();
		pass++;
		console.log(`  ok   ${name}`);
	} catch (err) {
		fail++;
		console.error(`  FAIL ${name}:`, err);
	}
}

async function asyncTest(name, fn) {
	try {
		await fn();
		pass++;
		console.log(`  ok   ${name}`);
	} catch (err) {
		fail++;
		console.error(`  FAIL ${name}:`, err);
	}
}

console.log("=== MockTerminalDriver Tests ===");
const mock = new MockTerminalDriver();

test("Mock driver id is 'mock'", () => {
	equal(mock.id, "mock");
});

await asyncTest("Mock driver spawn and list panes", async () => {
	const dummyPi = { exec: async () => ({ code: 0, stdout: "", stderr: "" }) };
	const spawned = await mock.spawnAgent(dummyPi, {
		session: "test-sess",
		window: "worker-1",
		command: "pi",
		cwd: "/test",
	});
	equal(spawned.session, "test-sess");
	equal(spawned.window, "worker-1");
	equal(spawned.target, "test-sess:worker-1.0");

	const panes = await mock.listPanes(dummyPi);
	equal(panes.length, 1);
	equal(panes[0].target, "test-sess:worker-1.0");

	const alive = await mock.isTargetAlive(dummyPi, "test-sess:worker-1.0");
	assertOk(alive);

	const proc = await mock.inspectProcess(dummyPi, "test-sess:worker-1.0");
	assertOk(proc.piLike);

	await mock.sendText(dummyPi, "test-sess:worker-1.0", "hello world");
	equal(mock.sentTexts.length, 1);
	equal(mock.sentTexts[0].text, "hello world");

	await mock.sendKeys(dummyPi, "test-sess:worker-1.0", "C-c", { enter: false });
	equal(mock.sentKeys.length, 1);
	equal(mock.sentKeys[0].keys, "C-c");

	const killed = await mock.killAgent(dummyPi, "test-sess:worker-1.0");
	assertOk(killed.killed);
	const dead = await mock.isTargetAlive(dummyPi, "test-sess:worker-1.0");
	assertOk(!dead);
});

console.log("\n=== Target Comparison Tests ===");
test("TmuxDriver isSameTarget matches identical and normalized targets", () => {
	const driver = new TmuxDriver();
	assertOk(driver.isSameTarget("sess:win.0", "sess:win.0"));
	assertOk(driver.isSameTarget("sess:win.0", "sess:win"));
	assertOk(driver.isSameTarget("sess:win", "sess:win.0"));
	assertOk(driver.isSameTarget("%1", "%1"));
	assertOk(!driver.isSameTarget("%1", "%2"));
	assertOk(!driver.isSameTarget("sess:win.0", "sess:other.0"));
});

console.log("\n=== Host Pane Detection Tests ===");
await asyncTest("isRootHostPane detects matching host pane", async () => {
	const fakePi = {
		exec: async (cmd, args) => {
			if (cmd === "tmux" && args[0] === "display-message") {
				return { code: 0, stdout: "host-sess\t0\t0\t%99\n", stderr: "" };
			}
			return { code: 0, stdout: "", stderr: "" };
		},
	};
	process.env.TMUX = "1";
	try {
		const isHost = await isRootHostPane(fakePi, "host-sess:0.0");
		assertOk(isHost, "host-sess:0.0 should be detected as host pane");

		const isHostPaneId = await isRootHostPane(fakePi, "%99");
		assertOk(isHostPaneId, "%99 should be detected as host pane");

		const notHost = await isRootHostPane(fakePi, "other-sess:1.0");
		assertOk(!notHost, "other-sess:1.0 should not be host pane");

		const unknownNotHost = await isRootHostPane(fakePi, "unknown");
		assertOk(!unknownNotHost, "unknown target should return false");
	} finally {
		delete process.env.TMUX;
	}
});

console.log(`\nTerminal Driver Tests: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
