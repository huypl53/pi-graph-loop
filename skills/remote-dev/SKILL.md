---
name: remote-dev
description: Use this skill when source is edited locally but builds, tests, dev servers, or previews should run on a stronger remote machine over SSH. Prefer local-edit, remote-execute. Supports Mutagen mirror workflows, rsync fallback, SSH port forwarding, same-origin proxy setups, and detached remote previews.
---

# Remote Development

## Core rule

**Edit locally, execute remotely.**

Treat:
- **local machine** as source of truth
- **remote machine** as execution backend

Do local:
- source edits
- git status/diff/add/commit/push
- browser access (usually via localhost forward)

Do remote:
- dependency install
- build / typecheck / tests
- dev server / preview server
- Docker / heavy scripts
- large codegen

---

## Pick a sync mode

Use this order:

1. **Existing project helper** if present
   - `scripts/remote-*`
   - `Makefile`, `Taskfile.yml`, `justfile`
2. **Existing Mutagen session** if already configured
3. **`rsync` fallback** for one-shot remote run / deploy-now requests
4. **scp/manual copy** only for tiny surgical transfers

Do **not** assume Mutagen already exists.

---

## Fast preflight

Before running remote commands, determine:

- local repo path
- remote repo path
- SSH host/alias
- package manager (`bun`, `pnpm`, `npm`, `yarn`)
- remote runtime availability (`node`, `bun`, etc.)
- whether browser access will be:
  - localhost forward
  - same-origin proxy
  - direct remote IP
- whether backend/API CORS allows that browser origin
- whether a detached process tool exists remotely:
  - `tmux`
  - `screen`
  - `setsid`
  - `pm2`

Also verify backend reachability from the remote machine if the app depends on APIs or WebSockets.

---

## Sync guidance

### If Mutagen exists

Check it first:

```bash
mutagen sync list
mutagen sync flush <name>
```

If remote code seems stale:

```bash
mutagen sync list
mutagen sync flush <name>
ssh devbox 'cd ~/work/my-app && git status --short'
```

### If Mutagen does not exist

`rsync` is an acceptable fallback for one-shot remote execution.

Typical excludes:

```text
.git
node_modules
.next
dist
build
coverage
.cache
.turbo
.vite
.parcel-cache
storybook-static
```

Example:

```bash
rsync -az --delete \
  --exclude '.git' \
  --exclude 'node_modules' \
  --exclude '.next' \
  ~/code/my-app/ devbox:~/work/my-app/
```

Use `rsync` when:
- user wants a quick remote deploy/run now
- Mutagen is not configured
- this is not yet a long-lived mirrored workflow

---

## Remote execution

Examples:

```bash
ssh devbox 'cd ~/work/my-app && pnpm build'
ssh devbox 'cd ~/work/my-app && pnpm test'
ssh -t devbox 'cd ~/work/my-app && pnpm dev'
```

Prefer the remote machine for:
- `npm install` / `pnpm install` / `bun install`
- `next build`, `vite build`, `tsc`
- test suites
- Storybook
- Docker
- heavy lint/typecheck/codegen

Do **not** edit synchronized source files directly on the remote unless explicitly asked.

---

## Browser access: choose the right topology

### Best default: localhost forward

Run app remotely, browse locally via SSH tunnel:

```bash
ssh -N -L 3000:127.0.0.1:3000 devbox
```

Then open:

```text
http://localhost:3000
```

This is often the safest path for:
- HMR/dev preview
- cookie behavior
- browser origin issues
- backend CORS constraints

### Same-origin proxy mode

If backend CORS blocks direct browser access, use a frontend-origin proxy:
- browser talks only to frontend origin
- frontend server proxies `/api/...` to backend
- same idea for WebSocket if supported

### Direct remote IP access

Do **not** assume this will work.

If the frontend is at `http://remote-ip:3000` and it calls `http://backend-ip:...`, browser CORS may block even if both servers are healthy.

If localhost-forward works but direct remote-IP browser access fails, treat it as an **origin/CORS topology issue**, not automatically an app bug.

---

## Detached remote preview

For a preview that must survive SSH exit, prefer `tmux`.

Example:

```bash
ssh devbox 'tmux new-session -d -s my-app "cd ~/work/my-app && pnpm dev"'
```

Inspect:

```bash
ssh devbox 'tmux ls'
ssh devbox 'tmux capture-pane -pt my-app | tail -50'
```

Attach:

```bash
ssh -t devbox 'tmux attach -t my-app'
```

Stop:

```bash
ssh devbox 'tmux kill-session -t my-app'
```

Use `tmux` over fragile shell backgrounding when possible.

---

## Runtime matching

Match the remote runtime to the local validated path when possible.

Examples:
- if local build is proven with **Bun**, prefer Bun remotely
- if project expects custom `server.js`, do not silently switch to a different start mode
- if same-origin proxy or WS proxy exists locally, preserve that remotely

Changing package managers or run modes can surface different:
- type errors
- lockfile behavior
- dependency resolution
- server behavior

---

## Safety rules

Do not run destructive remote commands casually:

```bash
rm -rf
git reset --hard
git clean -fdx
docker system prune
```

Remember:
- local repo is authoritative
- remote is an execution mirror
- deletions may propagate if sync is active

Do not treat remote Git state as canonical.

---

## Decision table

| Task | Preferred place |
|---|---|
| Edit source | Local |
| Git operations | Local |
| Heavy install/build/test | Remote |
| Dev server / preview | Remote |
| Browser access | Local browser via tunnel, or same-origin proxy |
| Source sync | Mutagen if configured, else rsync fallback |
| Long-lived remote preview | tmux |
| `node_modules`, caches, `.next` | Remote-only |

---

## Agent checklist

When using this skill:

1. Edit files locally.
2. Keep local Git state authoritative.
3. Discover remote runtime/tooling first.
4. Use Mutagen if already configured.
5. Otherwise use `rsync` for one-shot sync.
6. Run expensive commands remotely.
7. Report whether each command ran locally or remotely.
8. Prefer localhost-forward or same-origin proxy if browser CORS/origin is risky.
9. Use `tmux` for persistent remote preview.
10. Do not make unrelated remote source edits.

---

## Mental model

The remote machine is:

> **a stronger execution backend for the local repository**

The workflow is:

> **edit locally, sync safely, execute remotely, browse through the right origin.**
