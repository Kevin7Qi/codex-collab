# Contributing to codex-collab

## Prerequisites

- [Bun](https://bun.sh/) >= 1.0
- [Codex CLI](https://github.com/openai/codex) with `app-server` support

## Development Setup

```bash
git clone https://github.com/Kevin7Qi/codex-collab.git
cd codex-collab
bun install
./install.sh --dev    # symlink for live iteration
```

On Windows (PowerShell):

```powershell
powershell -ExecutionPolicy Bypass -File install.ps1 -Dev
```

## Running Tests

```bash
bun test              # run all tests (integration tests are skipped by default)
bun run typecheck     # type checking

RUN_INTEGRATION=1 bun test   # include integration tests (requires codex CLI + credentials)
RUN_UPDATE_E2E=1 bun test src/update-e2e.test.ts   # self-update E2E against a local mock release host (POSIX, requires codex CLI)
```

All tests must pass and type checking must be clean before submitting a PR.

## Code of Conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md) code of conduct.

## Architecture

The codebase is organized into focused modules:

| File | Purpose |
|------|---------|
| `src/cli.ts` | CLI router, signal handlers |
| `src/client.ts` | JSON-RPC client for Codex app server (spawn, handshake, request routing) |
| `src/commands/` | CLI command handlers (run, review, threads, kill, config, approve) |
| `src/broker.ts` | Shared app-server lifecycle (connection pooling, busy fallback) |
| `src/broker-server.ts` | Detached broker process (multiplexes JSON-RPC between clients and app-server) |
| `src/broker-client.ts` | Socket-based client for connecting to the broker server |
| `src/threads.ts` | Thread index, run ledger, short ID mapping |
| `src/turns.ts` | Turn lifecycle (runTurn, runReview), event wiring |
| `src/events.ts` | Event dispatcher, log writer, output accumulator |
| `src/approvals.ts` | Approval handler abstraction |
| `src/types.ts` | Protocol types (JSON-RPC, threads, turns, items, approvals) |
| `src/config.ts` | Configuration constants, workspace resolution |
| `src/process.ts` | Process spawn/lifecycle utilities |
| `src/lock.ts` | Advisory file locks (sync/async, single-winner stale breaking) |
| `src/git.ts` | Git operations (default-branch detection for reviews) |
| `src/skill.ts` | Installed-skill rendering (embedded SKILL.md source), drift detection, unified diff |
| `src/update.ts` | Release checking, update-notice state (`~/.codex-collab/update-check.json`) |

## Releases

`codex-collab update` installs from GitHub releases, so publishing one is what makes a version reachable by self-update:

```bash
# 1. Bump the version
#    edit package.json "version" (e.g. 0.3.0), commit
# 2. Tag and publish — release notes double as the changelog `update` shows users
git tag v0.3.0
git push origin main v0.3.0
gh release create v0.3.0 --generate-notes
```

The tag must be `v<version>` matching `package.json` — `update` compares the release tag against the binary's embedded version and downloads the tag's source tarball (built locally by the release's own installer).

## Pull Requests

- Keep PRs focused — one feature or fix per PR
- Run `bun test` and `bun run typecheck` before submitting
- Write tests for new functionality
- Follow existing code style and patterns
