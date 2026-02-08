# codex-collab

Claude + Codex collaboration bridge. A CLI that manages Codex sessions in tmux, giving Claude the ability to see Codex's TUI, send messages and keystrokes, and have back-and-forth conversations.

## Prerequisites

- [Bun](https://bun.sh/) — TypeScript runtime
- [tmux](https://github.com/tmux/tmux) — terminal multiplexer
- [Codex CLI](https://github.com/openai/codex) — `npm install -g @openai/codex`

## Install

```bash
# Install dependencies
bun install

# Add to PATH (add to your shell profile)
export PATH="$HOME/Documents/Coding/codex-collab/bin:$PATH"

# Symlink the skill so Claude Code discovers it
mkdir -p ~/.claude/skills
ln -sf ~/Documents/Coding/codex-collab/skill ~/.claude/skills/codex-collab

# Verify
codex-collab health
```

## Usage

```bash
# Start a Codex session with a prompt
codex-collab start "review this code for security issues" -f "src/**/*.ts"

# Start an interactive session (no auto-prompt)
codex-collab start --interactive -d /path/to/project

# See what Codex is showing
codex-collab capture <id>

# Send a message
codex-collab send <id> "also check the auth module"

# Send keystrokes for TUI navigation
codex-collab send-keys <id> Down
codex-collab send-keys <id> Enter

# List jobs
codex-collab jobs

# Kill a job
codex-collab kill <id>
```

## CLI Commands

| Command | Description |
|---------|-------------|
| `start "prompt" [opts]` | Start a Codex session with a prompt |
| `start --interactive [opts]` | Start a session in TUI mode |
| `send <id> "message"` | Send text + Enter |
| `send-keys <id> <key>` | Send raw keystrokes |
| `send-control <id> <key>` | Send control sequences (C-c, C-d) |
| `capture <id> [lines]` | Capture terminal output |
| `output <id>` | Full session output |
| `watch <id>` | Stream output updates |
| `jobs [--json]` | List jobs |
| `status <id>` | Job status |
| `attach <id>` | Print tmux attach command |
| `kill <id>` | Kill a running job |
| `clean` | Remove old completed jobs |
| `health` | Check dependencies |

## Claude Code Skill

The skill at `skill/SKILL.md` teaches Claude how to use the CLI to collaborate with Codex. Trigger it with `/codex-collab` in Claude Code.

## License

MIT
