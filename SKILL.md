---
name: codex-collab
description: Delegate tasks to Codex — run prompts, code review, research, pair programming, or any collaboration mode. Use when the user asks to use Codex, send work to Codex, have Codex review/investigate/implement something, or collaborate with Codex.
---

# codex-collab

codex-collab is a bridge between Claude and Codex. It manages Codex sessions in tmux and gives you the ability to see Codex's TUI, send messages and keystrokes, and read its output. How you collaborate depends on what the user wants.

## Collaboration Modes

- **Run** — Single-command `run` for any prompted task (research, analysis, implementation). Starts session, sends prompt, waits, returns output.
- **Code review** — Single-command `review` or manual step-by-step (see below).
- **Pair programming** — You work on code, Codex reviews. Or Codex implements while you steer via `send`.
- **Plan review** — Draft a plan, send it to Codex for feedback, iterate.
- **Parallel work** — You and Codex work on different parts simultaneously. Start multiple jobs.
- **Research** — Spin up a read-only Codex session to investigate something while you continue other work.

## Run Command (Recommended for Prompted Tasks)

The `run` command handles prompted tasks in one call: starts an interactive session, sends the prompt, waits for completion, and prints output. The session stays reusable afterward.

```bash
# Research task
codex-collab run "what does this project do?" -s read-only --content-only

# Implementation task
codex-collab run "add input validation to the login form" --content-only

# Resume an existing session (faster, preserves Codex's file cache)
codex-collab run --resume <id> "now check the error handling" --content-only

# Specify working directory (omit -d if already in the project dir)
codex-collab run "investigate the auth module" -d /path/to/project --content-only
```

**Always run in the background** — tasks can take minutes:

```bash
# Via Bash tool with run_in_background=true
codex-collab run "investigate X" -s read-only --content-only
# Continue working on other things...
```

### Optimal run pattern:

```bash
# 1. Run prompt in background
codex-collab run "investigate X" -s read-only --content-only  # run_in_background=true

# 2. When background task finishes, the output is the result
# No separate output/capture needed — run prints results directly
```

## Code Review (Recommended: Single Command)

The `review` command handles the entire review workflow in one call.

**Note**: When no `--mode` is specified, passing a prompt string switches from the default `pr` mode to `custom` mode, which bypasses the built-in diff workflow. For a standard PR review, do not pass a prompt.

```bash
# PR-style review against main (default — no prompt)
codex-collab review -d /path/to/project --content-only

# Review uncommitted changes
codex-collab review --mode uncommitted -d /path/to/project --content-only

# Review a specific commit
codex-collab review --mode commit --ref abc1234 -d /path/to/project --content-only

# Custom review focus
codex-collab review "Focus on security issues" -d /path/to/project --content-only

# Resume an existing session
codex-collab review --resume <id> "Check error handling" -d /path/to/project --content-only
```

Review modes: `pr` (default), `uncommitted`, `commit`, `custom`

**Always run reviews in the background** — they take 5-15 minutes:

```bash
# Via Bash tool with run_in_background=true
codex-collab review -d /path/to/project --content-only
# Continue working on other things...
```

### Manual Step-by-Step Review (Fallback)

For fine-grained control over the review TUI, use an interactive session:

```bash
# Start interactive session
codex-collab start -s read-only -d /path/to/project

# Send /review and navigate the menu
codex-collab send <id> "/review"
codex-collab send-keys <id> Enter           # Select option 1 (PR-style)
codex-collab send-keys <id> Enter           # Accept default branch (main)

# Wait for completion in the background
codex-collab wait <id>

# Read results
codex-collab output <id> --content-only
```

## Context Efficiency

These patterns minimize context window waste:

- **Use `--content-only`** when reading output — strips TUI chrome (banner, tips, shortcuts, idle prompt). Implies `--strip-ansi`.
- **Use `output --content-only`** to read results, NOT `capture`. Output gets the full scrollback; capture gets only the visible pane.
- **`run` and `review` handle waiting internally** — just run them in the background (Bash tool `run_in_background`). No separate `wait` or `output` call needed; they print results directly when done.
- **`wait` is only for manual workflows** (`start` + `send`). It polls for the spinner to disappear and prints a status line to stderr. Use `output` afterward to read results.

### Optimal review pattern:

```bash
# 1. Start review in background
codex-collab review -d /project --content-only   # run_in_background=true

# 2. When background task finishes, the output is the review
# No separate output/capture needed — review prints results directly
```

### Optimal prompted task pattern:

```bash
# Preferred: use run (handles start + wait + output in one call)
codex-collab run "implement X" --content-only    # run_in_background=true

# Fallback: manual start + send + wait + output
codex-collab start -d /path/to/project
codex-collab send <id> "implement X"
codex-collab wait <id>                           # run_in_background=true
codex-collab output <id> --content-only
```

## Resuming Sessions

Prefer resuming sessions over starting fresh to save startup time and reduce resource waste.

| Situation | Action |
|-----------|--------|
| Same project, new prompt | `codex-collab run --resume <id> "prompt"` |
| Same project, want review | `codex-collab review --resume <id>` |
| Same project, manual control | `codex-collab reset <id>` then send |
| Different project | Start new session |
| Session crashed / stuck | `codex-collab kill <id>` then start new |

Before starting a new session, check for resumable ones:

```bash
codex-collab jobs          # Look for running interactive sessions in the same project
codex-collab reset <id>    # Clear context with /new
```

The `reset` command sends `/new` to an existing session, clearing Codex's context without killing the process. This is faster than starting a fresh session.

## Waiting for Completion

`run` and `review` wait internally — no separate `wait` needed. The `wait` command is only for manual workflows where you use `start` + `send` separately.

```bash
# Only needed after manual start + send (not needed with run/review)
codex-collab wait <id>

# Custom timeout and interval
codex-collab wait <id> --timeout 1800 --interval 60
```

`wait` polls for the spinner to disappear, then prints a status line to stderr. Use `output --content-only` afterward to read results. **Always run in the background** for long tasks.

## CLI Reference

### Run

```bash
codex-collab run "prompt" [options]              # New session, send prompt, wait, print output
codex-collab run --resume <id> "prompt" [options] # Resume existing session
codex-collab run "prompt" -s read-only           # Read-only sandbox
```

### Review

```bash
codex-collab review [options]                     # PR-style (default)
codex-collab review --mode uncommitted [options]   # Uncommitted changes
codex-collab review --mode commit [options]        # Latest commit
codex-collab review --mode commit --ref <hash>     # Specific commit
codex-collab review "instructions" [options]       # Custom review
codex-collab review --resume <id> [options]         # Resume existing session
```

### Starting Sessions

```bash
codex-collab start -d /path/to/project               # Interactive TUI session
codex-collab start -s read-only -d /path/to/project   # Read-only session
```

### Reading Output

```bash
codex-collab capture <id> [lines] --content-only  # Current screen (default: 50 lines)
codex-collab output <id> --content-only      # Full scrollback (clean)
codex-collab wait <id>                       # Wait for completion (status only)
```

### Sending Input

```bash
codex-collab send <id> "message"             # Text + Enter
codex-collab send-keys <id> Down             # Raw keystroke
codex-collab send-keys <id> Enter
codex-collab send-keys <id> C-c              # Ctrl+C
```

### Session Management

```bash
codex-collab reset <id>                      # Send /new (clear context)
codex-collab kill <id>                       # Kill session
codex-collab jobs                            # List jobs
codex-collab jobs --json                     # List jobs (JSON)
codex-collab status <id>                     # Job details
codex-collab attach <id>                     # tmux attach command
codex-collab delete <id>                     # Delete job and its files
codex-collab clean                           # Remove old jobs
codex-collab health                          # Check prerequisites
```

### Options

| Flag | Description |
|------|-------------|
| `-r, --reasoning <level>` | Reasoning effort: low, medium, high, xhigh |
| `-m, --model <model>` | Model name |
| `-s, --sandbox <mode>` | Sandbox: read-only, workspace-write, danger-full-access (default: workspace-write; review always uses read-only) |
| `-d, --dir <path>` | Working directory |
| `--strip-ansi` | Remove ANSI codes from output |
| `--content-only` | Strip TUI chrome (implies --strip-ansi) |
| `--mode <mode>` | Review mode: pr, uncommitted, commit, custom |
| `--ref <hash>` | Commit ref for --mode commit |
| `--resume <id>` | Resume existing session (run and review) |
| `--timeout <sec>` | Wait/review timeout (default: 900) |
| `--interval <sec>` | Poll interval (default: 30) |
| `--json` | JSON output (jobs command) |
| `--limit <n>` | Limit jobs shown |
| `--all` | Show all jobs |

## Non-Interactive Tasks (codex exec)

For simple one-shot tasks that don't need session management, use `codex exec` directly instead of codex-collab:

```bash
# Run a prompt, get output on stdout
codex exec "explain what this project does" -s read-only

# Specify working directory
codex exec "summarize the auth module" -s read-only -C /path/to/project

# Resume the most recent Codex session
codex exec resume --last

# Resume a specific session with a follow-up prompt
codex exec resume <session-id> "now check the error handling"
```

Use codex-collab's `run` and `review` commands when you need session resumption, multi-step TUI interaction, or approval handling.

## Tips

- **Always use `--content-only`** when reading output programmatically. It strips ANSI codes AND TUI chrome.
- **Codex is meticulous.** Reviews take 5-15 minutes. Run in background.
- **Use `-s read-only`** for reviews and research.
- **Omit `-d` if already in the project directory** — it defaults to cwd. Only pass `-d` when the target project differs from your current directory.
- **Multiple concurrent sessions** are supported. Each gets its own tmux session and job ID.
- **Resume sessions** when working on the same project repeatedly. `run --resume` and `review --resume` are much faster than starting fresh.
- **Validate Codex's findings.** After reading Codex's review or analysis output, verify each finding against the actual source code before presenting to the user. Drop false positives, note which findings you verified.

## Prerequisites

Requires tmux, bun, and codex CLI on PATH. Run `codex-collab health` to verify.
