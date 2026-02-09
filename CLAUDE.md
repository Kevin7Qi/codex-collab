# codex-collab

CLI tool for Claude + Codex collaboration via tmux sessions.

**Stack**: TypeScript, Bun, tmux, OpenAI Codex CLI

## Development

```bash
bun run src/cli.ts --help
# or via shell wrapper
./bin/codex-collab --help
codex-collab health
```

## Key Files

| File | Purpose |
|------|---------|
| `src/cli.ts` | CLI commands, argument parsing, output formatting |
| `src/jobs.ts` | Job lifecycle, persistence, polling, review orchestration |
| `src/tmux.ts` | tmux session management (all via spawnSync, no shell) |
| `src/config.ts` | Configuration constants |
| `src/files.ts` | File loading for context injection (supports negation globs) |
| `src/session-parser.ts` | Parse Codex session files for metadata |
| `skill/SKILL.md` | Claude Code skill definition |

## Dependencies

- **Runtime**: Bun, tmux, codex CLI
- **NPM**: glob (file matching)

## Architecture Notes

- Jobs stored in `~/.codex-collab/jobs/` as JSON + `.log` files
- Uses `script` command for output logging
- All tmux interaction goes through `spawnSync` argument arrays (no shell interpolation)
- tmux sessions use 220x50 pane size so Codex spinner lines aren't truncated
- `waitForJob` detects completion via screen stability (2 consecutive unchanged captures)
- Job IDs are validated (`/^[0-9a-f]{8}$/`) before use in file paths
- Bun is the TypeScript runtime — never use npm/yarn/pnpm for running
- Skill hardlinked to `~/.claude/skills/codex-collab/SKILL.md`
