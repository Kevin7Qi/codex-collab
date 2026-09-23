#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
SKILL_DIR="$HOME/.claude/skills/codex-collab"
CODEX_SKILL_DIR="${CODEX_COLLAB_CODEX_SKILL_DIR:-${CODEX_HOME:-$HOME/.codex}/skills/claude-collab}"
CODEX_RULES_FILE="${CODEX_COLLAB_CODEX_RULES_PATH:-${CODEX_HOME:-$HOME/.codex}/rules/codex-collab.rules}"
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
  local entry="$1" out="$2" out_tmp
  # Render to a temp file first: writing straight to $out would truncate the
  # installed SKILL.md before bun even runs, so a render failure (set -e)
  # would leave a dev install with an empty file and the old one gone.
  out_tmp=$(mktemp)
  bun "$entry" skill render > "$out_tmp"
  # Remove old file/symlink so a stale symlink is never written through.
  rm -f "$out"
  mv "$out_tmp" "$out"
}

# The Codex-side skill: what a Codex session reads to learn that
# `codex-collab peers` / `send` reach the Claude Code sessions in its
# workspace. Same renderer, `--codex`.
generate_codex_skill_md() {
  local entry="$1" out="$2" out_tmp
  # Render OUTSIDE Codex's skills directory: a failed render (set -e) must
  # not leave a stray file where Codex scans for skills.
  out_tmp="$(mktemp)"
  bun "$entry" skill render --codex > "$out_tmp"
  mkdir -p "$(dirname "$out")"
  mv "$out_tmp" "$out"
}

# The opt-in Codex exec-policy rule (`codex-collab config codex-rule on`):
# refreshed on reinstall for a user who turned it on; offered once, on an
# interactive install, to a user who has not decided (either answer is
# recorded, so a reinstall does not ask again); never written otherwise.
offer_or_refresh_codex_rule() {
  local entry="$1" setting out_tmp answer
  setting="$(bun "$entry" config codex-rule 2>/dev/null || true)"
  case "$setting" in
    *": on")
      out_tmp="$(mktemp)"
      bun "$entry" skill render --rules > "$out_tmp"
      mkdir -p "$(dirname "$CODEX_RULES_FILE")"
      mv "$out_tmp" "$CODEX_RULES_FILE"
      echo "Refreshed Codex rule at $CODEX_RULES_FILE (config codex-rule is on: Codex runs \`send\` and \`peers stop\` without asking)"
      ;;
    *"not set"*)
      # Only a person at a terminal is asked: an agent's shell (Claude Code's
      # Bash tool, Codex's exec) has no TTY and gets the hint instead. A
      # terminal nobody answers within a minute is treated the same way —
      # the key stays unset, so a later interactive install asks again.
      if [ -t 0 ] && [ -t 1 ]; then
        echo ""
        echo "Codex asks (its approval flow) before each \`codex-collab send\` and \`codex-collab peers stop\`,"
        echo "which reach Claude Code outside Codex's sandbox. Experimental: an exec-policy rule at $CODEX_RULES_FILE"
        echo "lets any Codex session run both without asking: message your Claude Code sessions, start one, and"
        echo "stop one it started. Change later: codex-collab config codex-rule on|off"
        answer=""
        if read -r -t 60 -p "Let Codex run \`codex-collab send\` and \`peers stop\` without asking? [y/N] " answer; then
          case "$answer" in
            [yY]*) bun "$entry" config codex-rule on ;;
            *)     bun "$entry" config codex-rule off ;;
          esac
        else
          echo ""
          echo "No answer — left unset; run \`codex-collab config codex-rule on\` to let Codex run \`send\` and \`peers stop\` without asking"
        fi
      else
        echo "Codex asks before each \`send\` and \`peers stop\`; run \`codex-collab config codex-rule on\` to let it run them without asking"
      fi
      ;;
    *)
      echo "Codex asks before each \`send\` and \`peers stop\` (config codex-rule is off)"
      ;;
  esac
}

if [ "$MODE" = "dev" ]; then
  echo "$INSTALL_ACTION dev install at $SKILL_DIR (symlinks)..."

  # Generate SKILL.md with template table (can't inject into a symlink)
  mkdir -p "$SKILL_DIR/scripts"
  generate_skill_md "$REPO_DIR/src/cli.ts" "$SKILL_DIR/SKILL.md"
  generate_codex_skill_md "$REPO_DIR/src/cli.ts" "$CODEX_SKILL_DIR/SKILL.md"
  CLI_ENTRY="$REPO_DIR/src/cli.ts"
  ln -sf "$REPO_DIR/src/cli.ts" "$SKILL_DIR/scripts/codex-collab"
  ln -sf "$REPO_DIR/src/broker-server.ts" "$SKILL_DIR/scripts/broker-server"
  ln -sf "$REPO_DIR/LICENSE" "$SKILL_DIR/LICENSE.txt"

  # Symlink binary
  mkdir -p "$BIN_DIR"
  ln -sf "$REPO_DIR/src/cli.ts" "$BIN_DIR/codex-collab"
  echo "$INSTALL_DONE dev skill at $SKILL_DIR"
  echo "$INSTALL_DONE Codex skill at $CODEX_SKILL_DIR"
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

  # Codex's copy: rendered by the installed binary into Codex's skills dir
  generate_codex_skill_md "$SKILL_DIR/scripts/codex-collab" "$CODEX_SKILL_DIR/SKILL.md"
  echo "$INSTALL_DONE Codex skill at $CODEX_SKILL_DIR"
  CLI_ENTRY="$SKILL_DIR/scripts/codex-collab"

  # Symlink binary from installed skill
  mkdir -p "$BIN_DIR"
  ln -sf "$SKILL_DIR/scripts/codex-collab" "$BIN_DIR/codex-collab"
  chmod +x "$SKILL_DIR/scripts/codex-collab"
  echo "Linked binary shim to $BIN_DIR/codex-collab"
fi

# The Codex rule: refresh it, or ask once (see offer_or_refresh_codex_rule)
offer_or_refresh_codex_rule "$CLI_ENTRY"

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
