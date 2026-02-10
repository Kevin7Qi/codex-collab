#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
SKILL_DIR="$HOME/.claude/skills/codex-collab"
BIN_DIR="$HOME/.local/bin"

usage() {
  echo "Usage: ./install.sh [--dev]"
  echo ""
  echo "  (default)  Build and copy a self-contained skill directory"
  echo "  --dev      Symlink source files for live development"
}

# Parse arguments first (fail fast)
MODE="build"
if [ "${1:-}" = "--dev" ]; then
  MODE="dev"
elif [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  usage
  exit 0
elif [ -n "${1:-}" ]; then
  echo "Unknown option: $1"
  usage
  exit 1
fi

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

if [ "$MODE" = "dev" ]; then
  echo "Installing in dev mode (symlinks)..."

  # Symlink skill files
  mkdir -p "$SKILL_DIR/scripts"
  ln -sf "$REPO_DIR/SKILL.md" "$SKILL_DIR/SKILL.md"
  ln -sf "$REPO_DIR/src/cli.ts" "$SKILL_DIR/scripts/codex-collab"
  ln -sf "$REPO_DIR/LICENSE" "$SKILL_DIR/LICENSE.txt"
  echo "Linked skill to $SKILL_DIR"

  # Symlink binary
  mkdir -p "$BIN_DIR"
  ln -sf "$REPO_DIR/src/cli.ts" "$BIN_DIR/codex-collab"
  echo "Linked binary to $BIN_DIR/codex-collab"

else
  echo "Building..."

  # Build bundled JS
  rm -rf "$REPO_DIR/skill"
  mkdir -p "$REPO_DIR/skill/codex-collab/scripts"
  bun build "$REPO_DIR/src/cli.ts" --outfile "$REPO_DIR/skill/codex-collab/scripts/codex-collab" --target bun

  # Prepend shebang
  BUILT="$REPO_DIR/skill/codex-collab/scripts/codex-collab"
  if ! head -1 "$BUILT" | grep -q '^#!/'; then
    TEMP=$(mktemp)
    trap 'rm -f "$TEMP"' EXIT
    printf '#!/usr/bin/env bun\n' > "$TEMP"
    cat "$BUILT" >> "$TEMP"
    mv "$TEMP" "$BUILT"
    trap - EXIT
  fi

  # Copy SKILL.md and LICENSE into build
  cp "$REPO_DIR/SKILL.md" "$REPO_DIR/skill/codex-collab/SKILL.md"
  cp "$REPO_DIR/LICENSE" "$REPO_DIR/skill/codex-collab/LICENSE.txt"

  # Install skill (copy to ~/.claude/skills/)
  rm -rf "$SKILL_DIR"
  mkdir -p "$(dirname "$SKILL_DIR")"
  cp -r "$REPO_DIR/skill/codex-collab" "$SKILL_DIR"
  echo "Installed skill to $SKILL_DIR"

  # Symlink binary from installed skill
  mkdir -p "$BIN_DIR"
  ln -sf "$SKILL_DIR/scripts/codex-collab" "$BIN_DIR/codex-collab"
  chmod +x "$SKILL_DIR/scripts/codex-collab"
  echo "Linked binary to $BIN_DIR/codex-collab"
fi

# Verify PATH and run health check
echo ""
if command -v codex-collab >/dev/null 2>&1; then
  codex-collab health
else
  echo "Warning: codex-collab not found on PATH."
  echo "Add ~/.local/bin to your PATH:"
  echo ""
  echo '  # Current session'
  echo '  export PATH="$HOME/.local/bin:$PATH"'
  echo ""
  echo '  # Permanent (add to your shell config)'
  echo '  echo '\''export PATH="$HOME/.local/bin:$PATH"'\'' >> ~/.bashrc  # or ~/.zshrc'
  echo ""
  echo "Then run 'codex-collab health' to verify."
fi
echo ""
echo "Done ($MODE mode). Run 'codex-collab --help' to get started."
