# codex-collab

Collaborate with [Codex](https://github.com/openai/codex) from [Claude Code](https://docs.anthropic.com/en/docs/claude-code). Run tasks, get code reviews, do parallel research, all without leaving your Claude session.

codex-collab is a [Claude Code skill](https://docs.anthropic.com/en/docs/claude-code/skills) that drives Codex through its app server JSON-RPC protocol. It manages threads, streams structured events, handles tool-call approvals, and lets you resume conversations — all without leaving your Claude session.

## Why

- **Structured communication** — Talks to Codex via JSON-RPC over stdio. Every event is typed and parseable.
- **Event-driven progress** — Streams progress lines as Codex works, so Claude sees what's happening in real time.
- **Review automation** — One command to run code reviews for PRs, uncommitted changes, or specific commits in a read-only sandbox.
- **Thread reuse** — Resume existing threads to send follow-up prompts, build on previous responses, or steer the work in a new direction.
- **Approval control** — Configurable approval policies for tool calls: auto-approve, interactive, or deny.

## Prerequisites

Tested on Linux (Ubuntu 22.04). Both must be installed and on your PATH.

- [Bun](https://bun.sh/) >= 1.0 — runs the CLI
- [Codex CLI](https://github.com/openai/codex) with `app-server` support — the agent being orchestrated (`npm install -g @openai/codex`)

## Installation

```bash
git clone https://github.com/Kevin7Qi/codex-collab.git
cd codex-collab
./install.sh
```

The install script builds a self-contained bundle, copies it to `~/.claude/skills/codex-collab/`, and symlinks the binary. Once installed, Claude discovers the skill automatically and can invoke it without explicit prompting.

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

# Resume a thread
codex-collab run --resume <id> "now check error handling" --content-only
```

## CLI Commands

| Command | Description |
|---------|-------------|
| `run "prompt" [opts]` | Start thread, send prompt, wait, print output |
| `review [opts]` | Code review (PR, uncommitted, commit) |
| `jobs [--json]` | List threads |
| `kill <id>` | Interrupt running thread |
| `output <id>` | Full log for thread |
| `progress <id>` | Recent activity (tail of log) |
| `models` | List available models |
| `health` | Check dependencies |

<details>
<summary>Thread management</summary>

| Command | Description |
|---------|-------------|
| `delete <id>` | Archive thread, delete local files |
| `clean` | Delete old logs and stale mappings |
| `approve <id>` | Approve a pending request |
| `decline <id>` | Decline a pending request |

</details>

<details>
<summary>Options</summary>

| Flag | Description |
|------|-------------|
| `-d, --dir <path>` | Working directory |
| `-m, --model <model>` | Model name |
| `-r, --reasoning <level>` | low, medium, high, xhigh (default: xhigh) |
| `-s, --sandbox <mode>` | read-only, workspace-write, danger-full-access (default: workspace-write; review always uses read-only) |
| `--mode <mode>` | Review mode: pr, uncommitted, commit |
| `--ref <hash>` | Commit ref for `--mode commit` |
| `--resume <id>` | Resume existing thread |
| `--approval <policy>` | Approval policy: never, on-request, on-failure, untrusted (default: never) |
| `--content-only` | Suppress progress lines; with `output`, return only extracted content |
| `--json` | JSON output (`jobs` command) |
| `--timeout <sec>` | Turn timeout (default: 1200) |
| `--limit <n>` | Limit threads shown |

</details>

## See also

For single-prompt Codex calls, the official [Codex MCP server](https://developers.openai.com/codex/guides/agents-sdk) is simpler. codex-collab exists because you need persistent threads, structured event streaming, or approval control.
