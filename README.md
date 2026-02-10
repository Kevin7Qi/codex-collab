# codex-collab

Collaborate with [Codex](https://github.com/openai/codex) from [Claude Code](https://docs.anthropic.com/en/docs/claude-code). Run tasks, get code reviews, do parallel research, all without leaving your Claude session.

codex-collab is a [Claude Code skill](https://docs.anthropic.com/en/docs/claude-code/skills) that manages persistent Codex sessions in tmux. Normally, Claude can only call Codex in non-interactive mode (single prompt in, single response out). codex-collab keeps sessions alive so Claude can steer them mid-task, reuse context across prompts, and chain multi-step workflows like interactive code review.

## Prerequisites

Tested on Linux (Ubuntu 22.04). All three must be installed and on your PATH.

- [Bun](https://bun.sh/) >= 1.0 — runs the CLI
- [tmux](https://github.com/tmux/tmux) >= 3.2 — hosts Codex sessions in the background
- [Codex CLI](https://github.com/openai/codex) >= 0.9 — the agent being orchestrated (`npm install -g @openai/codex`)

## Installation

```bash
git clone https://github.com/Kevin7Qi/codex-collab.git
cd codex-collab
./install.sh
```

The install script builds a self-contained bundle, copies it to `~/.claude/skills/codex-collab/`, and symlinks the binary. Once installed, Claude discovers the skill automatically.

For development (live-reloading source changes):

```bash
./install.sh --dev
```

## Quick Start

```bash
# Run a prompted task
codex-collab run "what does this project do?" -s read-only --content-only

# Code review
codex-collab review --content-only

# Resume a session
codex-collab run --resume <id> "now check error handling" --content-only
```

## CLI Commands

| Command | Description |
|---------|-------------|
| `run "prompt" [opts]` | Run a prompt: start session, wait, print output |
| `review [opts]` | One-shot code review (PR, uncommitted, commit) |
| `jobs [--json]` | List jobs |
| `kill <id>` | Kill a running job |
| `clean` | Remove old completed jobs |
| `health` | Check dependencies |

<details>
<summary>Job management</summary>

| Command | Description |
|---------|-------------|
| `status <id>` | Job details |
| `reset <id>` | Clear context with /new |
| `delete <id>` | Delete job and its files |
| `attach <id>` | Print tmux attach command |

</details>

<details>
<summary>Advanced — manual control</summary>

For fine-grained control when `run` and `review` aren't enough.

| Command | Description |
|---------|-------------|
| `start [opts]` | Start an interactive session (TUI mode) |
| `send <id> "message"` | Send text + Enter |
| `send-keys <id> <key>` | Send raw keystrokes (Down, Enter, Escape, C-c, etc.) |
| `capture <id> [lines]` | Capture current screen (default: 50 lines) |
| `output <id>` | Full scrollback output |
| `wait <id>` | Wait for Codex to finish (poll-based) |

</details>

<details>
<summary>Options</summary>

| Flag | Description |
|------|-------------|
| `-d, --dir <path>` | Working directory |
| `-m, --model <model>` | Model name |
| `-r, --reasoning <level>` | low, medium, high, xhigh |
| `-s, --sandbox <mode>` | read-only, workspace-write, danger-full-access (default: workspace-write; review always uses read-only) |
| `--mode <mode>` | Review mode: pr, uncommitted, commit, custom |
| `--ref <hash>` | Commit ref for `--mode commit` |
| `--resume <id>` | Resume existing session |
| `--strip-ansi` | Remove ANSI escape codes from output |
| `--content-only` | Strip TUI chrome and ANSI codes |
| `--json` | JSON output (`jobs` command) |
| `--timeout <sec>` | Wait/review timeout (default: 900) |
| `--interval <sec>` | Poll interval (default: 30) |
| `--limit <n>` | Limit jobs shown |
| `--all` | Show all jobs |

</details>
