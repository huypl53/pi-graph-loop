// Helper for watchdog.test.mjs: spawns ONE background task as a SHORT-LIVED "pi" then exits,
// simulating the spawning pi process dying. The parent-death watchdog should then kill the task
// (unless survive:true). The taskId is printed to stdout for the parent test to read.
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const lib = await jiti.import("./src/lifecycle.ts");
const { spawnTask } = lib;

const cwd = process.env.BG_TEST_CWD;
const settings = JSON.parse(process.env.BG_TEST_SETTINGS);
const command = process.env.BG_TEST_CMD;
const label = process.env.BG_TEST_LABEL || "wd-probe";
const survive = process.env.BG_TEST_SURVIVE === "1";

const t = await spawnTask(
	cwd,
	settings,
	{ command, cwd, label, survive, shell: true },
	() => {},
);
process.stdout.write(t.taskId);
// Let the task register + the watchdog capture its parent, then EXIT (== the spawning pi dying).
setTimeout(() => process.exit(0), 400);
