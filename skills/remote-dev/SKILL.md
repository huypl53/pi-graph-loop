---
name: remote-dev
description: Use this skill whenever the user is developing a local codebase that runs on a more powerful remote machine via sync + SSH, or mentions Mutagen, remote dev boxes, SSH port forwarding, remote builds,tests,dev servers, local-edit,remote-execute workflows, mirrored repos, or stale remote code. This skill covers React, Nextjs, Vite, TypeScript, Nodejs, monorepos, Docker, and other heavy projects where the correct pattern is edit locally, sync changes, execute remotely.
---

# Remote Development

## Purpose

Use this skill when developing a local codebase that is synchronized to a more powerful remote machine.

The development model is:

- **Local machine = source of truth**
- **Remote machine = execution environment**
- **Mutagen = source synchronization**
- **SSH = remote command execution and port forwarding**

The remote machine does **not** need to be able to SSH back into the local machine.

This workflow is especially appropriate for large React, Next.js, Vite, TypeScript, Node.js, monorepo, test, build, Docker, or other CPU/RAM-heavy projects.

---

## Core Architecture

```text
LOCAL MACHINE                         REMOTE MACHINE
────────────────────                  ─────────────────────
repo                                  synced repo
├─ source files      ── Mutagen ───►  ├─ source files
├─ .git                               ├─ node_modules
├─ Claude / pi                        ├─ build caches
├─ editor                             ├─ dev server
├─ git operations                     ├─ tests
└─ browser          ◄── SSH tunnel ── ├─ builds
                                      └─ heavy processes
```

The local checkout is authoritative.

The remote checkout should be treated as an **execution mirror**, not as an independent working copy.

---

# Operating Principles

## 1. Local repository is the source of truth

Perform source-control operations locally unless explicitly instructed otherwise.

Preferred local operations:

```bash
git status
git diff
git add
git commit
git switch
git checkout
git merge
git rebase
git pull
git push
```

Do not independently change branches on the remote machine.

Do not make unrelated source edits directly on the remote machine.

Do not run destructive Git commands remotely against the synchronized working tree unless the user explicitly requests it.

When unsure, modify files locally and let Mutagen propagate the changes.

---

## 2. Heavy execution belongs on the remote machine

Prefer remote execution for:

- `pnpm install`
- `npm install`
- `yarn install`
- dev servers
- TypeScript compilation
- Vite / Next.js / Webpack builds
- test suites
- Storybook
- linting when expensive
- Docker builds
- database containers
- code generation
- large dependency operations
- CPU-heavy scripts
- RAM-heavy scripts

Example:

```bash
ssh devbox 'cd ~/work/my-app && pnpm build'
```

Interactive example:

```bash
ssh -t devbox 'cd ~/work/my-app && pnpm dev'
```

---

## 3. Do not synchronize heavy generated directories

Remote-only directories commonly include:

```text
node_modules
dist
build
.next
.nuxt
.output
coverage
.cache
.turbo
.vite
.parcel-cache
storybook-static
```

Also consider keeping machine-specific caches and temporary files out of synchronization.

Do not assume local and remote operating systems can safely share `node_modules`.

Native Node modules may differ across operating systems, CPU architectures, Node versions, or libc implementations.

Dependencies should generally be installed on the remote machine.

---

# Mutagen Workflow

A typical synchronization session looks like:

```bash
mutagen sync create \
  ~/code/my-app \
  devbox:~/work/my-app \
  --name=my-app
```

Inspect sessions:

```bash
mutagen sync list
```

Force reconciliation when needed:

```bash
mutagen sync flush my-app
```

Pause:

```bash
mutagen sync pause my-app
```

Resume:

```bash
mutagen sync resume my-app
```

Terminate:

```bash
mutagen sync terminate my-app
```

Before assuming a remote failure is caused by code, check synchronization state.

Useful diagnostic sequence:

```bash
mutagen sync list
mutagen sync flush my-app
ssh devbox 'cd ~/work/my-app && git status --short'
```

Be aware that Git metadata may intentionally not be synchronized depending on project configuration.

---

# Recommended Ignore Policy

Prefer explicit Mutagen ignores for generated content.

Example conceptual ignore list:

```text
node_modules
dist
build
.next
coverage
.cache
.turbo
.vite
.parcel-cache
storybook-static
.DS_Store
```

Do not automatically add a directory to ignores if the project depends on synchronized generated artifacts.

Inspect the repository first.

---

# SSH Execution

Assume an SSH config alias such as:

```sshconfig
Host devbox
    HostName remote.example.com
    User developer
    IdentityFile ~/.ssh/id_ed25519
    ServerAliveInterval 30
    ServerAliveCountMax 3
    ControlMaster auto
    ControlPersist 10m
    ControlPath ~/.ssh/cm-%r@%h:%p
```

Prefer the SSH alias rather than repeating hostnames or usernames.

For one command:

```bash
ssh devbox 'cd ~/work/my-app && pnpm test'
```

For an interactive process:

```bash
ssh -t devbox 'cd ~/work/my-app && exec $SHELL -l'
```

For a long-lived dev server:

```bash
ssh -t devbox 'cd ~/work/my-app && pnpm dev'
```

When executing compound commands remotely, quote them so shell expansion happens on the remote machine rather than locally.

---

# Port Forwarding

A remote service should usually bind to the remote loopback interface and be exposed locally through SSH.

Example for Vite:

```bash
ssh -N \
  -L 5173:127.0.0.1:5173 \
  devbox
```

Then open locally:

```text
http://localhost:5173
```

Multiple forwards can share one SSH connection:

```bash
ssh -N devbox \
  -L 5173:127.0.0.1:5173 \
  -L 3000:127.0.0.1:3000 \
  -L 6006:127.0.0.1:6006
```

Typical mapping:

```text
5173 -> Vite
3000 -> application API
6006 -> Storybook
```

Prefer tunneling over exposing development servers directly to the public network.

---

# Reverse Port Forwarding

The remote machine may be unable to initiate SSH connections to the local machine.

That is fine.

If remote software must access a service running locally, create a reverse tunnel from the local machine:

```bash
ssh -R 8787:127.0.0.1:8787 devbox
```

Then on the remote machine:

```bash
curl http://127.0.0.1:8787
```

This reaches the service on the local machine through the existing SSH connection.

Use this for:

- local mock APIs
- agent helper services
- callback endpoints
- development proxies
- local model servers
- local debugging services

Do not expose reverse tunnels on non-loopback remote interfaces unless explicitly required.

---

# Agent Behavior

When acting as a coding agent in this environment:

1. **Read and edit source files locally.**
2. Let Mutagen synchronize changes.
3. Execute expensive commands remotely through SSH.
4. Report whether a command was executed locally or remotely.
5. Prefer remote logs and test output when validating changes.
6. Keep local Git state authoritative.
7. Avoid modifying synchronized source files directly on remote.
8. Avoid touching remote `node_modules` from the local filesystem.
9. Check synchronization before diagnosing stale-code behavior.
10. Use SSH port forwarding for browser-visible remote services.

---

# Before Running a Remote Command

Determine:

- local project path
- corresponding remote project path
- SSH host alias
- package manager
- required environment variables
- required ports
- whether synchronization is current

Do not guess paths if the repository already contains project-specific configuration documenting them.

If a repository-level helper script exists, prefer it.

Examples:

```text
scripts/remote-dev
scripts/remote-test
scripts/remote-build
bin/remote
Makefile
Taskfile.yml
justfile
```

---

# Preferred Project Commands

Projects are encouraged to expose simple wrappers.

Example:

```bash
#!/usr/bin/env bash
set -euo pipefail

ssh -t devbox '
  cd ~/work/my-app
  exec pnpm dev
'
```

Example `remote-test`:

```bash
#!/usr/bin/env bash
set -euo pipefail

mutagen sync flush my-app

ssh devbox '
  cd ~/work/my-app
  pnpm test
'
```

Example `remote-build`:

```bash
#!/usr/bin/env bash
set -euo pipefail

mutagen sync flush my-app

ssh devbox '
  cd ~/work/my-app
  pnpm build
'
```

When reproducibility matters, flushing Mutagen before tests or builds is preferred.

---

# React / Vite Guidance

For a Vite application, normally run:

```bash
ssh -t devbox 'cd ~/work/my-app && pnpm dev'
```

Then forward the port:

```bash
ssh -N -L 5173:127.0.0.1:5173 devbox
```

Avoid setting `host: 0.0.0.0` merely to make the app accessible locally.

SSH forwarding is preferred.

If HMR behaves incorrectly, investigate:

- tunnel connectivity
- Vite HMR configuration
- host/port mismatch
- proxy configuration
- browser origin
- stale Mutagen synchronization

Do not immediately expose the Vite server publicly.

---

# Next.js Guidance

Run the application remotely:

```bash
ssh -t devbox 'cd ~/work/my-app && pnpm dev'
```

Forward its port:

```bash
ssh -N -L 3000:127.0.0.1:3000 devbox
```

Keep `.next` remote-only unless the project has a specific reason to synchronize it.

---

# Monorepo Guidance

For large monorepos, avoid synchronizing unnecessary generated directories.

Common remote-only directories:

```text
**/node_modules
**/.next
**/dist
**/coverage
.turbo
```

Run workspace commands remotely:

```bash
ssh devbox '
  cd ~/work/my-monorepo &&
  pnpm --filter web test
'
```

or:

```bash
ssh devbox '
  cd ~/work/my-monorepo &&
  pnpm turbo build
'
```

---

# Environment Variables

Do not assume local `.env` files should always be synchronized.

Secrets may need different handling on local and remote machines.

Possible patterns:

- synchronized development `.env`
- remote-only `.env`
- remote shell environment variables
- secret manager integration

Before changing secret handling, inspect existing project conventions.

Never print secrets into logs or agent responses.

---

# Debugging Checklist

If remote code appears stale:

```bash
mutagen sync list
mutagen sync flush my-app
```

Then inspect the remote file:

```bash
ssh devbox 'cd ~/work/my-app && sed -n "1,120p" path/to/file'
```

If dependencies behave strangely:

```bash
ssh devbox '
  cd ~/work/my-app &&
  node --version &&
  pnpm --version
'
```

Check that dependencies were installed remotely.

If the browser cannot connect:

```bash
ssh devbox 'ss -ltn | grep 5173'
```

Then verify the local tunnel.

If HMR does not work, distinguish between:

- source sync problem
- Vite watcher problem
- websocket/HMR tunnel problem
- application runtime problem

Do not treat these as the same failure.

---

# Safety Rules

Never run destructive commands such as:

```bash
rm -rf
git reset --hard
git clean -fdx
docker system prune
```

on the remote project without understanding the consequences.

Remember that Mutagen may propagate deletions.

Before performing broad file deletion locally or remotely, verify synchronization behavior and affected paths.

Avoid two-way independent editing of the same files.

---

# Decision Table

| Task | Preferred location |
|---|---|
| Edit source | Local |
| Claude/pi agent | Local |
| Git operations | Local |
| Browse app | Local browser |
| Dependency install | Remote |
| Dev server | Remote |
| Unit/integration tests | Remote |
| Type checking | Remote |
| Production build | Remote |
| Docker | Remote |
| Heavy code generation | Remote |
| `node_modules` | Remote |
| Build caches | Remote |
| Source synchronization | Mutagen |
| Access remote web service | SSH `-L` |
| Remote access to local service | SSH `-R` |

---

# Mental Model

Treat the remote machine as:

> A powerful execution backend for the local repository.

The coding agent should behave as though the local working tree is the canonical project, while transparently delegating expensive execution to the remote machine.

When deciding between editing remote files and executing remote commands:

**edit locally, execute remotely.**

