# codex-collab

CLI tool for Claude + Codex collaboration via the Codex app server JSON-RPC protocol.

**Stack**: TypeScript, Bun, OpenAI Codex CLI (app server protocol)

## Development

```bash
./install.sh --dev    # symlink for live iteration
bun run src/cli.ts --help
codex-collab health
bun run test:ci       # what CI runs, the way it runs it (no claude on PATH) — before every push
```

- Bun is the TypeScript runtime — never use npm/yarn/pnpm for running
- Contract tests against live `codex`/`claude` binaries live in `contracts/` — opt-in via `CODEX_COLLAB_CONTRACTS=1 bun test contracts/` (skipped by default; spends a few trivial model turns, writes probe entries into the real session registry, and starts two background Claude Code sessions in the current folder, which Claude Code must trust; all removed afterwards)
- For a no-sign-in smoke test with the real CLIs and canned loopback model replies, run `bun run test:fake-models`; see [the harness guide](scripts/fake-models/README.md) for setup and coverage.

## Architecture Notes

- Communicates with Codex via the `codex app-server` JSON-RPC protocol: over Codex's control socket (`$CODEX_HOME/app-server-control/app-server-control.sock`, WebSocket) when a shared app-server is running, else over stdio to a private child (`config server auto|shared|private`)
- Codex 0.145+ allows one writer per thread (flock in `~/.codex/thread-writer-locks/`), released only when the holding process unloads the thread or exits. The broker unsubscribes idle threads it does not keep; Codex unloads an unsubscribed idle thread after a delay (observed ~7 min on 0.153.4 — `-c thread_unload_delay_secs` did not shorten it) and releases the lock then. A thread held by another process is reported as exit code 8
- Broker manages one app-server connection per workspace via Unix socket / named pipe with thread-scoped routing: parallel runs on different threads multiplex over it; same-thread contention is refused (-32001) — a second app-server could no longer take the thread anyway — and only an unavailable broker falls back to a direct connection
- State lives under `~/.codex-collab/`: user defaults in `config.json`, each workspace's state in `workspaces/{slug}-{hash}/`
