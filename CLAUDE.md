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
| `src/questions.ts` | Ask-channel mailbox (Codex asks mid-turn via `ask`, fail-open on timeout; markers, temp-space mailbox) |
| `src/types.ts` | Protocol types (JSON-RPC, threads, turns, items, approvals) |
| `src/config.ts` | Configuration constants, workspace resolution |
| `src/broker.ts` | Shared app-server lifecycle (connection pooling) |
| `src/peer.ts` | Native peer messaging (Claude session-registry entries, messaging sockets, consult bridge, per-thread peers) |
| `src/broker-client.ts` | Socket-based client for connecting to the broker server |
| `src/shared-server.ts` | Attach to Codex's shared app-server over its control socket (WebSocket client, attach/spawn decision) |
| `src/models.ts` | Model and effort defaults shared by the CLI and the peer |
| `src/broker-server.ts` | Detached broker server process (multiplexes JSON-RPC between clients and app-server) |
| `src/process.ts` | Process spawn/lifecycle utilities |
| `src/lock.ts` | Advisory file locks (sync/async, single-winner stale breaking) |
| `src/git.ts` | Git operations (default-branch detection for reviews) |
| `src/skill.ts` | Installed-skill rendering (embedded SKILL.md source), drift detection, unified diff |
| `src/update.ts` | Release checking, update notices (`skill sync` / `update` commands live in `src/commands/update.ts`) |
| `SKILL.md` | Claude Code skill definition |

## Dependencies

- **Runtime**: Bun, codex CLI (`codex app-server`)

## Architecture Notes

- Communicates with Codex via the `codex app-server` JSON-RPC protocol: over Codex's control socket (`$CODEX_HOME/app-server-control/app-server-control.sock`, WebSocket) when a shared app-server is running, else over stdio to a private child (`config server auto|shared|private`)
- Codex 0.145+ allows one writer per thread (flock in `~/.codex/thread-writer-locks/`), released only when the holding process unloads the thread or exits. The broker unsubscribes idle threads it does not keep; Codex unloads an unsubscribed idle thread after a delay (observed ~7 min on 0.153.4 — `-c thread_unload_delay_secs` did not shorten it) and releases the lock then. A thread held by another process is reported as exit code 8
- Per-workspace state under `~/.codex-collab/workspaces/{slug}-{hash}/` (threads, logs, runs, approvals, kill signals, PIDs)
- User defaults stored in `~/.codex-collab/config.json` (model, reasoning, sandbox, approval, timeout)
- Broker manages one app-server connection per workspace via Unix socket / named pipe with thread-scoped routing: parallel runs on different threads multiplex over it; same-thread contention is refused (-32001) — a second app-server could no longer take the thread anyway — and only an unavailable broker falls back to a direct connection
- Short IDs are 8-char hex, support prefix resolution
- Run ledger tracks per-invocation state (status, timing, output) under `runs/`
- Bun is the TypeScript runtime — never use npm/yarn/pnpm for running
- Skill installed to `~/.claude/skills/codex-collab/` via `install.sh` (build + copy; `--dev` for symlinks)
- Contract tests against live `codex`/`claude` binaries live in `contracts/` — opt-in via `CODEX_COLLAB_CONTRACTS=1 bun test contracts/` (skipped by default; spends a few trivial model turns and writes probe entries into the real session registry with cleanup)
