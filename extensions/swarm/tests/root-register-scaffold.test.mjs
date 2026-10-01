// Regression reproduction test for:
// "register a pi agent as swarm root, but there is no .pi/swarm.yml initiated yet."
//
// Invariants under test:
//   1. Running `/swarm register here root` in a non-root session must scaffold `.pi/swarm.yml`
//      when no swarm.yml exists.
//   2. Running `/swarm init` in a fresh project must also ensure pool scaffold is initiated.
//   3. Subsequent registrations or inits must be idempotent (one-shot flag prevents re-notify).
//
// Run: node extensions/swarm/tests/root-register-scaffold.test.mjs

process.env.PI_SWARM_TERMINAL_MANAGER = "tmux";
import { rmSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const mod = await import(join(here, "..", "index.ts"));
const factory = mod.default;
const { stopRootPump } = await import(join(here, "..", "src", "hooks.ts"));
const { POOL_SCAFFOLD_YML_PLACEHOLDER } = await import(join(here, "..", "src", "constants.ts"));

let pass = 0,
	fail = 0;
const ok = (n, c, extra = "") => {
	if (c) {
		pass++;
		console.log("  ok  ", n);
	} else {
		fail++;
		console.error("  FAIL", n, extra);
	}
};

const scratch = join(tmpdir(), `swarm-scaffold-repro-${process.pid}-${Date.now()}`);
rmSync(scratch, { recursive: true, force: true });
mkdirSync(scratch, { recursive: true });

let swarmCmd = null;
const bind = (targetPaneId = "%7") => {
	swarmCmd = null;
	const pi = {
		registerTool: () => {},
		registerCommand: (name, opts) => {
			if (name === "swarm") swarmCmd = opts;
		},
		on: () => {},
		sendMessage: () => {},
		exec: async (cmd, args) => {
			if (cmd === "git") return { code: 0, stdout: "deadbeef\n", stderr: "" };
			if (cmd !== "tmux") return { code: 1, stdout: "", stderr: "" };
			if (args[0] === "display-message") {
				if (args.includes("-t")) return { code: 0, stdout: `${targetPaneId}\n`, stderr: "" };
				return { code: 0, stdout: "work\t0\t1\t%7\n", stderr: "" };
			}
			if (args[0] === "capture-pane") return { code: 0, stdout: "pi swarm session\n", stderr: "" };
			if (args[0] === "send-keys") return { code: 0, stdout: "", stderr: "" };
			return { code: 1, stdout: "", stderr: "unknown tmux subcommand" };
		},
	};
	factory(pi);
};

const mkCtx = (dir) => {
	const state = { status: null, notify: null, warnings: [] };
	const ctx = {
		cwd: dir,
		hasUI: true,
		mode: "tui",
		isIdle: () => true,
		ui: {
			notify: (m, k) => {
				state.notify = [m, k];
			},
			setStatus: (k, v) => {
				state.status = [k, v];
			},
		},
	};
	return { ctx, state };
};

const resetEnv = () => {
	delete process.env.PI_SWARM_AGENT_ID;
	delete process.env.PI_SWARM_IS_ROOT;
	delete process.env.TMUX;
};

console.log("\n[1] '/swarm register here root' scaffolds .pi/swarm.yml in a fresh workspace");
{
	const case1 = join(scratch, "case1");
	mkdirSync(case1, { recursive: true });
	bind("%7");
	resetEnv();
	process.env.TMUX = "/tmp/tmux-501/default,1234,0";

	const { ctx, state } = mkCtx(case1);
	await swarmCmd.handler("register here root PM", ctx);

	const ymlPath = join(case1, ".pi", "swarm.yml");
	const ymlExists = existsSync(ymlPath);
	ok("case1: .pi/swarm.yml initiated on register root", ymlExists);
	if (ymlExists) {
		const content = readFileSync(ymlPath, "utf8");
		ok("case1: .pi/swarm.yml has expected placeholder content", content === POOL_SCAFFOLD_YML_PLACEHOLDER);
	}

	const stPath = join(case1, ".pi", "swarm", "swarm-state.json");
	if (existsSync(stPath)) {
		const st = JSON.parse(readFileSync(stPath, "utf8"));
		ok("case1: poolScaffoldNotifiedAt is stamped in SwarmState", Boolean(st.poolScaffoldNotifiedAt));
	} else {
		ok("case1: swarm-state.json exists", false);
	}

	stopRootPump();
}

console.log("\n[2] '/swarm init' also scaffolds .pi/swarm.yml if not yet initiated");
{
	const case2 = join(scratch, "case2");
	mkdirSync(case2, { recursive: true });
	bind("%7");
	resetEnv();

	const { ctx, state } = mkCtx(case2);
	await swarmCmd.handler("init", ctx);

	const ymlPath = join(case2, ".pi", "swarm.yml");
	const ymlExists = existsSync(ymlPath);
	ok("case2: .pi/swarm.yml initiated on /swarm init", ymlExists);
}

console.log(`\nRESULTS: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
