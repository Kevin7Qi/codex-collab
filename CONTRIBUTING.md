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

## Running Tests

```bash
bun test              # run all tests
bun run typecheck     # type checking
```

All tests must pass and type checking must be clean before submitting a PR.

## Architecture

The codebase is organized into focused modules:

| File | Purpose |
|------|---------|
| `src/cli.ts` | CLI commands, argument parsing, output formatting |
| `src/protocol.ts` | JSON-RPC client for Codex app server |
| `src/threads.ts` | Thread lifecycle, short ID mapping |
| `src/turns.ts` | Turn lifecycle, event wiring |
| `src/events.ts` | Event dispatcher, log writer |
| `src/approvals.ts` | Approval handler abstraction |
| `src/types.ts` | Protocol types |
| `src/config.ts` | Configuration constants |

## Pull Requests

- Keep PRs focused — one feature or fix per PR
- Run `bun test` and `bun run typecheck` before submitting
- Write tests for new functionality
- Follow existing code style and patterns
