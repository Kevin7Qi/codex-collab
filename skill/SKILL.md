---
name: codex-collab
description: Collaborate with Codex — pair programming, code review, plan feedback, or any mode the user defines
triggers:
  - codex-collab
  - codex collab
  - collaborate with codex
  - pair with codex
  - codex review
---

# codex-collab

codex-collab is a bridge between Claude and Codex. It manages Codex sessions in tmux and gives you the ability to see Codex's TUI, send messages and keystrokes, and read its output. How you collaborate depends on what the user wants.

## Collaboration Modes

These are examples — the user can define their own:

- **Pair programming** — You work on code, send it to Codex for review. Or Codex implements while you watch and steer via `capture` + `send`.
- **Code review** — Start an interactive session, use `send-keys` to navigate to Codex's `/review` command, and read back the results.
- **Plan review** — Draft a plan, send it to Codex for feedback, iterate.
- **Parallel work** — You and Codex work on different parts simultaneously. Start multiple jobs.
- **Research** — Spin up a read-only Codex session to investigate something while you continue other work.

## CLI Reference

### Starting Sessions

```bash
# Start with a prompt (Codex begins working immediately)
codex-collab start "implement the login form" -d /path/to/project

# Start interactive (no auto-prompt — you navigate the TUI)
codex-collab start --interactive -d /path/to/project

# With file context
codex-collab start "review these files" -f "src/**/*.ts" -d /path/to/project

# With codebase map
codex-collab start "understand the architecture" --map -d /path/to/project

# Read-only sandbox
codex-collab start "investigate the bug" -s read-only -d /path/to/project
```

### Seeing What Codex Shows

```bash
# Capture the current terminal screen (default: 50 lines)
codex-collab capture <id>

# Capture more lines
codex-collab capture <id> 100

# Strip ANSI codes for clean text
codex-collab capture <id> --strip-ansi

# Full session output (scrollback)
codex-collab output <id>

# Stream updates
codex-collab watch <id>
```

### Sending Input

```bash
# Send a chat message (text + Enter)
codex-collab send <id> "please also check error handling"

# Send raw keystrokes (no Enter appended — for TUI navigation)
codex-collab send-keys <id> Down
codex-collab send-keys <id> Up
codex-collab send-keys <id> Enter
codex-collab send-keys <id> Escape
codex-collab send-keys <id> Tab
codex-collab send-keys <id> 1        # number selection

# Send control sequences
codex-collab send-control <id> C-c   # Ctrl+C (interrupt)
codex-collab send-control <id> C-d   # Ctrl+D (EOF)
```

### Job Management

```bash
# List jobs
codex-collab jobs
codex-collab jobs --json

# Job status
codex-collab status <id>

# Kill a running job
codex-collab kill <id>

# Clean old completed jobs
codex-collab clean

# Get tmux attach command
codex-collab attach <id>
```

### Options

| Flag | Description |
|------|-------------|
| `-r, --reasoning <level>` | Reasoning effort: low, medium, high, xhigh |
| `-m, --model <model>` | Model name |
| `-s, --sandbox <mode>` | Sandbox: read-only, workspace-write, danger-full-access |
| `-f, --file <glob>` | Include files matching glob (repeatable) |
| `-d, --dir <path>` | Working directory |
| `--map` | Include codebase map |
| `--dry-run` | Show prompt without executing |
| `--strip-ansi` | Remove ANSI codes from output |
| `--interactive` | Start in interactive TUI mode |
| `--json` | JSON output (jobs command) |

### Health Check

```bash
codex-collab health
```

Checks that tmux and codex CLI are installed and available.

## Interactive TUI Workflow

When using `--interactive`, Codex starts with an empty input. You navigate the TUI with `send-keys`:

1. `codex-collab start --interactive -d /path/to/project`
2. `codex-collab capture <id>` — see what's on screen
3. `codex-collab send-keys <id> Down` — navigate a menu
4. `codex-collab send-keys <id> Enter` — select an option
5. `codex-collab send <id> "your message"` — type and submit text

This is useful for accessing Codex's built-in commands like `/review`, `/compact`, etc.

## Prerequisites

- **tmux** — `sudo apt install tmux`
- **bun** — TypeScript runtime
- **codex** — `npm install -g @openai/codex`

All three must be on PATH. Run `codex-collab health` to verify.
