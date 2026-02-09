#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "Installing codex-collab from $REPO_DIR"

# Check prerequisites
missing=()
command -v bun  >/dev/null 2>&1 || missing+=(bun)
command -v tmux >/dev/null 2>&1 || missing+=(tmux)
command -v codex >/dev/null 2>&1 || missing+=(codex)

if [ ${#missing[@]} -gt 0 ]; then
  echo "Missing prerequisites: ${missing[*]}"
  echo "  bun:   https://bun.sh/"
  echo "  tmux:  sudo apt install tmux"
  echo "  codex: npm install -g @openai/codex"
  exit 1
fi

# Install dependencies
echo "Installing dependencies..."
(cd "$REPO_DIR" && bun install)

# Symlink binary
mkdir -p ~/.local/bin
ln -sf "$REPO_DIR/src/cli.ts" ~/.local/bin/codex-collab
echo "Linked binary to ~/.local/bin/codex-collab"

# Symlink skill
mkdir -p ~/.claude/skills
ln -sfn "$REPO_DIR/skill" ~/.claude/skills/codex-collab
echo "Linked skill to ~/.claude/skills/codex-collab"

# Verify
if ! command -v codex-collab >/dev/null 2>&1; then
  echo ""
  echo "Warning: codex-collab not found on PATH."
  echo "Make sure ~/.local/bin is in your PATH:"
  echo '  export PATH="$HOME/.local/bin:$PATH"'
  echo ""
fi

echo ""
"$REPO_DIR/src/cli.ts" health
echo ""
echo "Done. Run 'codex-collab --help' to get started."
