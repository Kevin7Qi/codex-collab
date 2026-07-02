# codex-collab

CLI tool for Claude + Codex collaboration via the Codex app server JSON-RPC protocol.

**Stack**: TypeScript, Bun, OpenAI Codex CLI (app server protocol)

## Development

```bash
./install.sh --dev    # symlink for live iteration
bun run src/cli.ts --help
codex-collab health
```

## Key Files

| File | Purpose |
|------|---------|
| `src/cli.ts` | CLI router, argument parsing, signal handlers |
| `src/client.ts` | JSON-RPC client for Codex app server (spawn, handshake, request routing) |
| `src/commands/` | CLI command handlers (run, review, threads, kill, config, approve) |
| `src/threads.ts` | Thread index, run ledger, short ID mapping |
| `src/turns.ts` | Turn lifecycle (runTurn, runReview), event wiring |
| `src/events.ts` | Event dispatcher (progress lines, log writer, output accumulator) |
| `src/approvals.ts` | Approval handler abstraction (auto-approve, interactive IPC) |
| `src/types.ts` | Protocol types (JSON-RPC, threads, turns, items, approvals) |
| `src/config.ts` | Configuration constants, workspace resolution |
| `src/broker.ts` | Shared app-server lifecycle (connection pooling) |
| `src/broker-client.ts` | Socket-based client for connecting to the broker server |
| `src/broker-server.ts` | Detached broker server process (multiplexes JSON-RPC between clients and app-server) |
| `src/process.ts` | Process spawn/lifecycle utilities |
| `src/lock.ts` | Advisory file locks (sync/async, single-winner stale breaking) |
| `src/git.ts` | Git operations (default-branch detection for reviews) |
| `SKILL.md` | Claude Code skill definition |

## Dependencies

- **Runtime**: Bun, codex CLI (`codex app-server`)

## Architecture Notes

- Communicates with Codex via `codex app-server` JSON-RPC protocol over stdio
- Per-workspace state under `~/.codex-collab/workspaces/{slug}-{hash}/` (threads, logs, runs, approvals, kill signals, PIDs)
- User defaults stored in `~/.codex-collab/config.json` (model, reasoning, sandbox, approval, timeout)
- Broker manages a shared app-server per workspace via Unix socket / named pipe; falls back to direct connection when broker is busy (parallel execution) or unavailable
- Short IDs are 8-char hex, support prefix resolution
- Run ledger tracks per-invocation state (status, timing, output) under `runs/`
- Bun is the TypeScript runtime — never use npm/yarn/pnpm for running
- Skill installed to `~/.claude/skills/codex-collab/` via `install.sh` (build + copy; `--dev` for symlinks)
