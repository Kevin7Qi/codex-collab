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
- **Code review** — Use Codex's built-in `/review` command (see workflow below).
- **Plan review** — Draft a plan, send it to Codex for feedback, iterate.
- **Parallel work** — You and Codex work on different parts simultaneously. Start multiple jobs.
- **Research** — Spin up a read-only Codex session to investigate something while you continue other work.

## Code Review with `/review`

Codex has a built-in `/review` command with a TUI menu. Use an interactive session to drive it:

### `/review` Menu

When you send `/review`, Codex shows 4 presets:

| # | Preset | What it does | Next step |
|---|--------|--------------|-----------|
| 1 | Review against a base branch (PR Style) | Diffs current branch vs a base | Searchable branch picker → Enter to confirm |
| 2 | Review uncommitted changes | Reviews `git diff` (staged + unstaged) | Starts immediately |
| 3 | Review a commit | Reviews a single commit's changes | Searchable commit picker → Enter to confirm |
| 4 | Custom review instructions | Reviews with your own focus prompt | Text input for custom instructions |

Navigation: **Down/Up** to move between options, **Enter** to select, **Escape** to go back.

### Example: PR-style review against a base branch

```bash
# 1. Start interactive session in the project directory
codex-collab start --interactive -s read-only -d /path/to/project

# 2. Send the /review command
codex-collab send <id> "/review"

# 3. Wait for the menu, then capture to see it
codex-collab capture <id> --strip-ansi

# 4. Option 1 is already selected (default), press Enter
codex-collab send-keys <id> Enter

# 5. Branch picker appears — capture to see branches, Enter to confirm default (main)
codex-collab capture <id> --strip-ansi
codex-collab send-keys <id> Enter

# 6. Wait for the review to finish in the background (can take 5-15 minutes)
codex-collab wait <id> --strip-ansi   # run in background

# 7. When done, get the full review output:
codex-collab output <id> --strip-ansi
```

### Example: Review uncommitted changes

```bash
codex-collab start --interactive -s read-only -d /path/to/project
codex-collab send <id> "/review"
codex-collab capture <id> --strip-ansi
# Navigate to option 2
codex-collab send-keys <id> Down
codex-collab send-keys <id> Enter
# Wait for completion
codex-collab wait <id> --strip-ansi
codex-collab output <id> --strip-ansi
```

### Example: Review a specific commit

```bash
codex-collab start --interactive -s read-only -d /path/to/project
codex-collab send <id> "/review"
codex-collab capture <id> --strip-ansi
# Navigate to option 3
codex-collab send-keys <id> Down
codex-collab send-keys <id> Down
codex-collab send-keys <id> Enter
# Searchable commit picker appears — capture to see, type to search, Enter to select
codex-collab capture <id> --strip-ansi
codex-collab send-keys <id> Enter
```

### Example: Custom review instructions

```bash
# Shortcut: pass instructions directly to /review (skips the menu)
codex-collab start --interactive -s read-only -d /path/to/project
codex-collab send <id> "/review Focus on security issues and shell injection risks"
# Wait for completion
codex-collab wait <id> --strip-ansi
codex-collab output <id> --strip-ansi
```

### Waiting for Review Completion

Codex reviews are thorough and can take **5-15 minutes**. Use the `wait` command in the background so you can continue working:

```bash
# Run wait in the background (via Bash tool with run_in_background)
codex-collab wait <id> --strip-ansi
# Continue doing other work while codex reviews...
# Check the background task output when notified it's done
```

The full review output is available via `codex-collab output <id> --strip-ansi` once complete.

## Waiting for Completion

Use the `wait` command to block until codex finishes. **Run this in the background** so you can continue other work while codex is busy:

```bash
# Wait for codex to finish (default: 900s timeout, 30s poll interval)
codex-collab wait <id> --strip-ansi

# Custom timeout and interval
codex-collab wait <id> --timeout 1800 --interval 60 --strip-ansi
```

The `wait` command polls `capture` internally, checking for the spinner (`esc to interrupt`) to disappear. It prints the final capture output when done, or exits with code 1 on timeout.

**Important**: For long-running tasks (reviews, complex prompts), always run `wait` in the background rather than blocking. This lets you continue working on other things while codex processes.

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

# Wait for codex to finish working
codex-collab wait <id> --strip-ansi

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

## Interactive TUI Workflow

When using `--interactive`, Codex starts with an empty input. You navigate the TUI with `send-keys`:

1. `codex-collab start --interactive -d /path/to/project`
2. `codex-collab capture <id> --strip-ansi` — see what's on screen
3. `codex-collab send-keys <id> Down` — navigate a menu
4. `codex-collab send-keys <id> Enter` — select an option
5. `codex-collab send <id> "your message"` — type and submit text

This pattern works for all Codex TUI interactions: `/review`, `/compact`, model switching, etc.

## Tips

- **Always use `--strip-ansi`** when reading capture/output programmatically. Raw terminal output contains ANSI escape codes that are hard to parse.
- **Codex is meticulous.** Reviews and complex tasks take 5-15 minutes. Don't poll too aggressively — check every 30-60 seconds.
- **Use `-s read-only`** for reviews and research. Only use `workspace-write` or `danger-full-access` when Codex needs to modify files.
- **Use `-d`** to set the working directory. Codex operates in the directory it was started in.
- **Multiple concurrent sessions** are supported. Each gets its own tmux session and job ID.

## Prerequisites

- **tmux** — `sudo apt install tmux`
- **bun** — TypeScript runtime
- **codex** — `npm install -g @openai/codex`

All three must be on PATH. Run `codex-collab health` to verify.
