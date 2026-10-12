// lane-ext.ts — live-lane boundary auditor for loop-read-streak-lane.test.mjs.
// At agent_settled it counts the DURABLE loop_streak.nudge / loop_streak.escalated audit
// records under .pi/swarm/traces/*.jsonl — the injection-path audit written by
// consumeTurnEndNudge / maybeEscalateToRoot in extensions/swarm/src/nudges/loop-detect.ts.
// (A dynamic import of turns.ts here would create a separate module instance with its own
// counter binding — counting the durable audit records instead: same site, post-run readable.)
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SCRATCH = process.env.PI_READ_STREAK_LANE_SCRATCH || process.cwd();

export default function (pi) {
	pi.on("agent_settled", async () => {
		let nudges = 0;
		let escalations = 0;
		try {
			const tracesDir = join(SCRATCH, ".pi", "swarm", "traces");
			for (const f of readdirSync(tracesDir)) {
				if (!f.endsWith(".jsonl")) continue;
				for (const line of readFileSync(join(tracesDir, f), "utf8").split("\n")) {
					if (line.includes('"loop_streak.nudge"')) nudges++;
					if (line.includes('"loop_streak.escalated"')) escalations++;
				}
			}
		} catch {
			// traces dir absent — zero counts (lane failed before any audit)
		}
		writeFileSync(join(SCRATCH, "lane-counts.json"), JSON.stringify({ nudges, escalations }));
	});
}
