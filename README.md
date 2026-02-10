# codex-collab

Claude + Codex collaboration bridge. A CLI that manages Codex sessions in tmux, giving Claude the ability to see Codex's TUI, send messages and keystrokes, and read output.

## Prerequisites

- [Bun](https://bun.sh/) — TypeScript runtime
- [tmux](https://github.com/tmux/tmux) — terminal multiplexer
- [Codex CLI](https://github.com/openai/codex) — `npm install -g @openai/codex`

## Install

```bash
git clone https://github.com/Kevin7Qi/codex-collab.git
cd codex-collab
./install.sh
```

The install script builds a self-contained bundle, copies it to `~/.claude/skills/codex-collab/`, and symlinks the binary.

For development (live-reloading source changes):

```bash
./install.sh --dev
```

## Quick Start

```bash
# Run a prompted task (single command: start + wait + output)
codex-collab run "what does this project do?" -s read-only --content-only
codex-collab run --reuse <id> "now summarize the key files" --content-only

# Code review (single command, handles everything)
codex-collab review --content-only
codex-collab review --mode uncommitted --content-only
codex-collab review --mode commit --ref abc1234 --content-only

# Manual start + wait + output (fallback)
codex-collab start "refactor auth module" -d /path/to/project
codex-collab wait <id>
codex-collab output <id> --content-only

# Interactive session
codex-collab start --interactive -d /path/to/project
codex-collab send <id> "check the auth module"
codex-collab send-keys <id> Enter

# Session reuse (faster than starting fresh)
codex-collab run --reuse <id> "follow-up question" --content-only
codex-collab review --reuse <id> --content-only
```

## CLI Commands

| Command | Description |
|---------|-------------|
| `run "prompt" [opts]` | Run a prompt: start session, wait, print output |
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

`SKILL.md` at the project root teaches Claude how to use the CLI. It's installed to `~/.claude/skills/codex-collab/` by `install.sh`.

## License

MIT
