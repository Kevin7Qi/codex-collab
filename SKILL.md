---
name: codex-collab
description: Delegate tasks to Codex — run prompts, code review, research, pair programming, or any collaboration mode. Use when the user asks to use Codex, send work to Codex, have Codex review/investigate/implement something, or collaborate with Codex.
---

# codex-collab

codex-collab is a bridge between Claude and Codex. It manages Codex sessions in tmux and gives you the ability to see Codex's TUI, send messages and keystrokes, and read its output.

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

# Resume an existing session (preserves conversation context)
codex-collab run --resume <id> "now check the error handling" --content-only

# Specify working directory (omit -d if already in the project dir)
codex-collab run "investigate the auth module" -d /path/to/project --content-only
```

**IMPORTANT: Always use `run_in_background=true`** — tasks take minutes. You will be notified automatically when the command finishes. After launching, tell the user it's running and end your turn. Do NOT use TaskOutput, block, poll, wait, or spawn an agent to monitor the result — the background task notification handles this automatically.

If the user asks about progress, use `capture` to check the current screen:

```bash
codex-collab capture <id> --content-only
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

**IMPORTANT: Always use `run_in_background=true`** — reviews typically take 5-15 minutes. You will be notified automatically when done. After launching, tell the user it's running and end your turn. Do NOT use TaskOutput, block, poll, wait, or spawn an agent to monitor the result — the background task notification handles this automatically.

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

- **Use `--content-only`** when reading output — strips TUI chrome (banner, tips, shortcuts, idle prompt). Implies `--strip-ansi`.
- **Use `output --content-only`** to read results, NOT `capture`. Output gets the full scrollback; capture gets only the visible pane.
- **`run` and `review` print results on completion** — no separate `output` call needed. The `wait` + `output` pattern is only for manual `start` + `send` workflows.

## Resuming Sessions

When consecutive tasks relate to the same project, resume the existing session. Codex retains the conversation history, so follow-ups like "now fix what you found" or "check the tests too" work better when Codex already has context from the previous exchange. Start a fresh session when the task is unrelated or targets a different project.

| Situation | Action |
|-----------|--------|
| Same project, new prompt | `codex-collab run --resume <id> "prompt"` |
| Same project, want review | `codex-collab review --resume <id>` |
| Same project, clean slate | `codex-collab reset <id>` then `run --resume <id> "prompt"` |
| Same project, manual control | `codex-collab send <id> "message"` |
| Different project | Start new session |
| Session crashed / stuck | `codex-collab kill <id>` then start new |

Sessions time out after 45 minutes of inactivity. If a session has expired, start a new one. If you've lost track of the job ID, use `codex-collab jobs` to find running sessions.

To clear context without killing the session, use `reset`:

```bash
codex-collab reset <id>    # Sends /new to clear Codex's conversation history in this session
```

## Waiting for Completion

The `wait` command is only for manual workflows (`start` + `send`). Do NOT use `wait` after `run` or `review` — they already wait internally and print results when done. Adding a separate `wait` causes duplicate notifications.

`wait` polls for the spinner to disappear, then prints a status line to stderr. Use `output --content-only` afterward to read results.

Always run `wait` in the background (`run_in_background=true`).

```bash
codex-collab wait <id>
codex-collab wait <id> --timeout 1800 --interval 60
```

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

For simple one-shot tasks that don't need session management, use `codex exec` directly. Use codex-collab when you need session reuse, TUI interaction, or review automation.

```bash
codex exec "explain what this project does" -s read-only
codex exec "summarize the auth module" -s read-only -C /path/to/project
```

## Tips

- **`run --resume` requires a prompt.** `review --resume` works without one (it uses the review workflow), but `run --resume <id>` will error if no prompt is given.
- **Omit `-d` if already in the project directory** — it defaults to cwd. Only pass `-d` when the target project differs from your current directory.
- **Multiple concurrent sessions** are supported. Each gets its own tmux session and job ID.
- **Validate Codex's findings.** After reading Codex's review or analysis output, verify each finding against the actual source code before presenting to the user. Drop false positives, note which findings you verified.

## Prerequisites

Requires tmux, bun, and codex CLI on PATH. Run `codex-collab health` to verify.
