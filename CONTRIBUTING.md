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

## Pull Requests

- Keep PRs focused — one feature or fix per PR
- Run `bun test` and `bun run typecheck` before submitting
- Write tests for new functionality
- Follow existing code style and patterns
