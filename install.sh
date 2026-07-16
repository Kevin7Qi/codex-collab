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

if [ -e "$SKILL_DIR" ]; then
  INSTALL_ACTION="Updating existing"
  INSTALL_DONE="Updated"
else
  INSTALL_ACTION="Installing new"
  INSTALL_DONE="Installed"
fi

# Check prerequisites
missing=()
command -v bun  >/dev/null 2>&1 || missing+=(bun)
command -v codex >/dev/null 2>&1 || missing+=(codex)

if [ ${#missing[@]} -gt 0 ]; then
  echo "Missing prerequisites: ${missing[*]}"
  echo "  bun:   https://bun.sh/"
  echo "  codex: npm install -g @openai/codex"
  exit 1
fi

# Install dependencies
echo "Installing dependencies..."
(cd "$REPO_DIR" && bun install)

# ---------------------------------------------------------------------------
# Generate SKILL.md with injected template table
# ---------------------------------------------------------------------------

# SKILL.md generation lives in the CLI itself (`skill render`: embedded
# SKILL.md source + current template table) so the installers and
# `codex-collab skill sync` share one implementation.
generate_skill_md() {
  local entry="$1" out="$2"
  # Remove old file/symlink first so a stale symlink is never written through.
  rm -f "$out"
  bun "$entry" skill render > "$out"
}

if [ "$MODE" = "dev" ]; then
  echo "$INSTALL_ACTION dev install at $SKILL_DIR (symlinks)..."

  # Generate SKILL.md with template table (can't inject into a symlink)
  mkdir -p "$SKILL_DIR/scripts"
  generate_skill_md "$REPO_DIR/src/cli.ts" "$SKILL_DIR/SKILL.md"
  ln -sf "$REPO_DIR/src/cli.ts" "$SKILL_DIR/scripts/codex-collab"
  ln -sf "$REPO_DIR/src/broker-server.ts" "$SKILL_DIR/scripts/broker-server"
  ln -sf "$REPO_DIR/LICENSE" "$SKILL_DIR/LICENSE.txt"

  # Symlink binary
  mkdir -p "$BIN_DIR"
  ln -sf "$REPO_DIR/src/cli.ts" "$BIN_DIR/codex-collab"
  echo "$INSTALL_DONE dev skill at $SKILL_DIR"
  echo "Linked binary shim to $BIN_DIR/codex-collab"

else
  echo "$INSTALL_ACTION install at $SKILL_DIR..."
  echo "Building..."

  # Build bundled JS (CLI + broker server)
  rm -rf "$REPO_DIR/skill"
  mkdir -p "$REPO_DIR/skill/codex-collab/scripts"
  bun build "$REPO_DIR/src/cli.ts" --outfile "$REPO_DIR/skill/codex-collab/scripts/codex-collab" --target bun
  bun build "$REPO_DIR/src/broker-server.ts" --outfile "$REPO_DIR/skill/codex-collab/scripts/broker-server" --target bun

  # Prepend shebangs
  for BUILT in "$REPO_DIR/skill/codex-collab/scripts/codex-collab" "$REPO_DIR/skill/codex-collab/scripts/broker-server"; do
    if ! head -1 "$BUILT" | grep -q '^#!/'; then
      TEMP=$(mktemp)
      trap 'rm -f "$TEMP"' EXIT
      printf '#!/usr/bin/env bun\n' > "$TEMP"
      cat "$BUILT" >> "$TEMP"
      mv "$TEMP" "$BUILT"
      trap - EXIT
    fi
    chmod +x "$BUILT"
  done

  # Copy prompts BEFORE rendering — `skill render` resolves built-in
  # templates relative to the built binary (scripts/prompts)
  cp -r "$REPO_DIR/src/prompts" "$REPO_DIR/skill/codex-collab/scripts/prompts"

  # Generate SKILL.md with injected template table, copy LICENSE
  generate_skill_md "$REPO_DIR/skill/codex-collab/scripts/codex-collab" "$REPO_DIR/skill/codex-collab/SKILL.md"
  cp "$REPO_DIR/LICENSE" "$REPO_DIR/skill/codex-collab/LICENSE.txt"

  # Install skill (copy to ~/.claude/skills/)
  rm -rf "$SKILL_DIR"
  mkdir -p "$(dirname "$SKILL_DIR")"
  cp -r "$REPO_DIR/skill/codex-collab" "$SKILL_DIR"
  echo "$INSTALL_DONE skill at $SKILL_DIR"

  # Symlink binary from installed skill
  mkdir -p "$BIN_DIR"
  ln -sf "$SKILL_DIR/scripts/codex-collab" "$BIN_DIR/codex-collab"
  chmod +x "$SKILL_DIR/scripts/codex-collab"
  echo "Linked binary shim to $BIN_DIR/codex-collab"
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
