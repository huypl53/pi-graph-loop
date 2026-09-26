# Changelog Guidelines

This document defines conventions and procedures for maintaining `CHANGELOG.md` in this repository.

## Principles

1. **Keep a Changelog**: Maintain human-readable, reverse-chronological documentation of notable changes.
2. **Evidence-Grounded**: Note what actually changed, why it changed, and how it was verified (unit tests, mock-LLM scenarios, live tmux runs).
3. **Traceability**: Group changes by released version (`## [vX.Y.Z] - YYYY-MM-DD`) and maintain an active `## [Unreleased]` section during ongoing development.

## Entry Structure & Format

Each release section follows:

```markdown
## [vX.Y.Z] - YYYY-MM-DD

### <type>(<scope>): <concise summary>

- **Context / Symptom**: What motivated the change or what failure occurred.
- **Key Changes**: Concrete additions, removals, or behavior shifts (mentioning tool names, settings, or CLI flags).
- **Verification**: How the change was tested (e.g., test suite names, mock-LLM scenarios, or tmux verification).
```

### Types & Scopes
Use conventional commit prefixes:
- `feat(scope)`: New capabilities, tools, commands, or behaviors.
- `fix(scope)`: Bug fixes, race conditions, edge-case hardening.
- `refactor(scope)`: Code restructuring without functional behavior changes.
- `test(scope)`: New test suites, mock-LLM fixtures, or UAT harnesses.
- `docs(scope)`: Documentation, architecture updates, contract changes.
- `chore(scope)`: Housekeeping, dependency bumps, cleanup.

Common scopes include `swarm`, `mock-llm`, `ct-probe`, `background-tasks`, `cron`, `package`.

## Tagging & Release Workflow

When cutting a new release or tag:
1. Review git history since the previous tag: `git log --oneline <last-tag>..HEAD`.
2. Move relevant entries from `[Unreleased]` into `[vX.Y.Z] - YYYY-MM-DD` and document any missing commits.
3. Commit the changelog and documentation updates:
   ```bash
   git add CHANGELOG.md docs/
   git commit -m "docs: update changelog for vX.Y.Z"
   ```
4. Point the git tag to the changelog commit (if a tag was already created, move it to the changelog commit):
   ```bash
   git tag -f vX.Y.Z
   git push origin vX.Y.Z --force
   ```
