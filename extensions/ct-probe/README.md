# ct-probe

Real-lane probe extension for CT-3..CT-7 contract tests.

Phase-2 evidence (`task-202609021845-ct-phase2-probes`, commit `3d1f3c6`) was
retracted on 2026-09-02 because it used self-mocked `pi` / `ctx` objects
(`makeMockPi`, hand-coded `signal: undefined`, hand-thrown stale messages).
The transcripts under `.pi/mock-llm/transcripts/ct3..ct8-*/` were written by
the test harness's `writeProbeTranscript(...)` and lack the `fixturePath`
field that identifies provider-generated output.

This extension is the audit remediation: it captures REAL `pi` / `ctx` from
inside a REAL `pi` session and writes the observation as JSON to a
lane-scratch dir.

## Selection

```bash
PI_CT_PROBE=CT3|CT4|CT5|CT6|CT7
```

Defaults to `CT3` if unset. CT-8 is intentionally NOT implemented here — it
is a source-import unit (`extensions/swarm/src/identity.ts:80,106`
`ensureRoot`); see `extensions/swarm/ct-phase2-probes.test.mjs` §CT-8.

## Output

Each probe writes `<scratch>/<probe>-result.json`:

- `CT3`: `{ probe, capturedAt, subcase: "A", sendMessageCallCount, sendMessageReturnIsUndefined, wrapperInvokedOnSameTick, deltaMs, optsDeliverAs, optsTriggerTurn }`
- `CT4`: `{ probe, capturedAt, subcase: "A"|"B", trigger, isIdleSampleCountDuringCompaction, isIdleFalseCountDuringCompaction, compactionRetryObservedFalse, samples[] }`
- `CT5`: `{ probe, capturedAt, capturedSignalValue, capturedSignalType, isAbortSignalInstance, capturedValueWasUndefined, sessionStartReason }`
- `CT6`: `{ probe, capturedAt, preReloadRegisterToolReturned, preReloadThrew, reloadStartedAt, reloadResolvedAt, postReloadThrew, postReloadThrewMatchesStalePattern, thrownMessageContainsStaleSubstring, capturedPiIdentity }`
- `CT7`: `{ probe, capturedAt, agentEndEmittedCount, agentSettledEmittedCount, agentSettledNotYetAtMidStream, agentSettledAfterFollowUp, emissionOrderingMatches, timeline[] }`

## Launch

```bash
SCRATCH=$(mktemp -d -t ct2b-<probe>-XXXX)
cd "$SCRATCH"
PI_PROJ=/Users/lee/code/projects/pi-graph-agents

tmux new-window -t pi-swarm-pi-graph-agents-4206ca -n ct2b-<probe> -c "$SCRATCH"
tmux send-keys -t pi-swarm-pi-graph-agents-4206ca:ct2b-<probe> \
  "PI_CT_PROBE=<PROBE> PI_CT_PROBE_SCRATCH='$SCRATCH' \
   pi --provider mock-llm --model <fixture> \
   -e '$PI_PROJ/extensions/mock-llm' \
   -e '$PI_PROJ/extensions/ct-probe'" Enter

sleep 6
tmux capture-pane -t pi-swarm-pi-graph-agents-4206ca:ct2b-<probe> -p
```

Per-lane launch scripts are in
`.pi/swarm/tasks/task-202609021900-ct-phase2b-real-lanes/artifacts/lanes/<probe>/launch.sh`.

## What this extension is NOT

- It does NOT mock `pi` or `ctx`.
- It does NOT fabricate boundary counters.
- It does NOT write its own "transcripts" (those come from the provider at `.pi/mock-llm/transcripts/<modelId>/`).

The probe-result JSON is the probe's observation from inside a real pi session,
nothing more.
