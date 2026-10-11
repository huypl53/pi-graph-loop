# Swarm task dashboard

The dashboard is a static, offline visual review surface for current task graphs, agent conversations, inspector details, and recent trace events. It is read-only with respect to swarm state. Its executable owner is [`scripts/swarm_dashboard.py`](../scripts/swarm_dashboard.py); use [`scripts/swarm_dashboard.sh --help`](../scripts/swarm_dashboard.sh) for the current options and defaults.

Quick start:

```bash
scripts/swarm_dashboard.sh --out dashboard.html
```

Use `--cwd` to select the workspace whose `.pi/swarm` state is reviewed. The selected cwd is the read boundary: task/state inputs and inline artifact content must remain inside it. Relative `--artifact` paths are resolved from `.pi/swarm`; absolute paths use their given location. Artifacts inside `.pi/swarm` may be shown inline; artifacts elsewhere inside the selected cwd are link-only, and paths escaping the cwd (including symlink escapes) are rejected. Rendering does not mutate swarm state; HTML output is the only write and goes to the selected `--out` path (or the live-mode default documented by `--help`).

The dashboard intentionally focuses on the active task workflow. Metric, run, memory, and iteration views belong to the retired experimentation subsystem; retained historical docs or runtime records do not imply those features are supported.

For the command-line UAT entrypoint, see [`scripts/swarm_task_uat.sh`](../scripts/swarm_task_uat.sh). The canonical swarm documentation map is [`docs/swarm/index.md`](swarm/index.md).
