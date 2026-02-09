# codex-collab

Claude + Codex collaboration bridge. A CLI that manages Codex sessions in tmux, giving Claude the ability to see Codex's TUI, send messages and keystrokes, and read output.

## Prerequisites

- [Bun](https://bun.sh/) — TypeScript runtime
- [tmux](https://github.com/tmux/tmux) — terminal multiplexer
- [Codex CLI](https://github.com/openai/codex) — `npm install -g @openai/codex`

## Install

```bash
bun install

# Symlink binary and skill
ln -sf ~/Documents/Coding/codex-collab/bin/codex-collab ~/.local/bin/codex-collab
mkdir -p ~/.claude/skills
ln -sf ~/Documents/Coding/codex-collab/skill ~/.claude/skills/codex-collab

codex-collab health
```

## Quick Start

```bash
# Code review (single command, handles everything)
codex-collab review -d /path/to/project --content-only
codex-collab review --mode uncommitted -d . --content-only
codex-collab review --mode commit --ref abc1234 -d . --content-only

# Start a prompted task
codex-collab start "refactor auth module" -d /path/to/project
codex-collab wait <id>
codex-collab output <id> --content-only

# Interactive session
codex-collab start --interactive -d /path/to/project
codex-collab send <id> "check the auth module"
codex-collab send-keys <id> Enter

# Session reuse (faster than starting fresh)
codex-collab reset <id>
codex-collab review --reuse <id> -d /path/to/project --content-only
```

## CLI Commands

| Command | Description |
|---------|-------------|
| `review [opts]` | One-shot code review (PR, uncommitted, commit) |
| `start "prompt" [opts]` | Start a Codex session with a prompt |
| `start --interactive [opts]` | Start a session in TUI mode |
| `send <id> "message"` | Send text + Enter |
| `send-keys <id> <key>` | Send raw keystrokes |
| `send-control <id> <key>` | Send control sequences (C-c, C-d) |
| `capture <id>` | Capture current screen |
| `output <id>` | Full scrollback output |
| `wait <id>` | Wait for Codex to finish (poll-based) |
| `reset <id>` | Clear context with /new |
| `jobs [--json]` | List jobs |
| `status <id>` | Job details |
| `attach <id>` | Print tmux attach command |
| `kill <id>` | Kill a running job |
| `delete <id>` | Delete job and its files |
| `clean` | Remove old completed jobs |
| `sessions` | List raw tmux sessions |
| `health` | Check dependencies |

### Key Options

| Flag | Description |
|------|-------------|
| `-d, --dir <path>` | Working directory |
| `-f, --file <glob>` | Include files (repeatable) |
| `-m, --model <model>` | Model name |
| `-r, --reasoning <level>` | low, medium, high, xhigh |
| `-s, --sandbox <mode>` | read-only, workspace-write, danger-full-access |
| `--mode <mode>` | Review mode: pr, uncommitted, commit, custom |
| `--ref <hash>` | Commit ref for `--mode commit` |
| `--reuse <id>` | Reuse existing session for review |
| `--content-only` | Strip TUI chrome and ANSI codes |
| `--timeout <sec>` | Wait/review timeout (default: 900) |
| `--interval <sec>` | Poll interval (default: 30) |

## Claude Code Skill

The skill at `skill/SKILL.md` teaches Claude how to use the CLI. Trigger with `/codex-collab` in Claude Code.

## License

MIT
