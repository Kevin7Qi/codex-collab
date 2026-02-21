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
| `src/cli.ts` | CLI commands, argument parsing, output formatting |
| `src/protocol.ts` | JSON-RPC client for Codex app server (spawn, handshake, request routing) |
| `src/threads.ts` | Thread lifecycle, short ID mapping |
| `src/turns.ts` | Turn lifecycle (runTurn, runReview), event wiring |
| `src/events.ts` | Event dispatcher (progress lines, log writer, output accumulator) |
| `src/approvals.ts` | Approval handler abstraction (auto-approve, interactive IPC) |
| `src/types.ts` | Protocol types (JSON-RPC, threads, turns, items, approvals) |
| `src/config.ts` | Configuration constants |
| `SKILL.md` | Claude Code skill definition |

## Dependencies

- **Runtime**: Bun, codex CLI (`codex app-server`)
- **NPM**: (none)

## Architecture Notes

- Communicates with Codex via `codex app-server` JSON-RPC protocol over stdio
- Threads stored in `~/.codex-collab/threads.json` as short ID → full ID mapping
- Logs stored in `~/.codex-collab/logs/` per thread
- Approval requests use file-based IPC in `~/.codex-collab/approvals/`
- Short IDs are 8-char hex, support prefix resolution
- Bun is the TypeScript runtime — never use npm/yarn/pnpm for running
- Skill installed to `~/.claude/skills/codex-collab/` via `install.sh` (build + copy; `--dev` for symlinks)
