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
| `src/cli.ts` | CLI commands and argument parsing |
| `src/jobs.ts` | Job lifecycle and persistence |
| `src/tmux.ts` | tmux session management |
| `src/config.ts` | Configuration constants |
| `src/files.ts` | File loading for context injection |
| `src/session-parser.ts` | Parse Codex session files for metadata |
| `skill/SKILL.md` | Claude Code skill definition |

## Dependencies

- **Runtime**: Bun, tmux, codex CLI
- **NPM**: glob (file matching)

## Notes

- Jobs stored in `~/.codex-collab/jobs/`
- Uses `script` command for output logging
- Bun is the TypeScript runtime — never use npm/yarn/pnpm for running
- Skill symlinked to `~/.claude/skills/codex-collab/SKILL.md`
