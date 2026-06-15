#!/usr/bin/env bash
# install-hooks-claude.sh — Brain hook installer for Claude Code
#
# Copies the Brain hook scripts to ~/.claude/hooks/ and registers all hooks
# in ~/.claude/settings.json using dynamically resolved absolute paths.
#
# Run this after ./install.sh:
#   ./install-hooks-claude.sh
#
# What gets installed:
#   SessionStart  — loads Brain briefing + checks for project node
#   PreToolUse    — injects project context before first Edit/Write/Bash (once/session)
#   PostToolUse   — auto-links + auto-summarizes new/updated Brain nodes
#   Stop          — reminds AI to write insights to Brain + triggers auto-capture
#   SessionEnd    — auto-capture fallback (when SessionEnd fires)

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
HOOKS_SRC="$REPO_DIR/examples/hooks"
HOOKS_DST="$HOME/.claude/hooks"
SETTINGS="$HOME/.claude/settings.json"
BRAIN_URL="${BRAIN_URL:-http://localhost:3000}"

# ── Prerequisites ─────────────────────────────────────────────────────────────
if ! command -v jq >/dev/null 2>&1; then
  echo "ERROR: jq is required. Install with: sudo apt install jq"
  exit 1
fi

# ── Copy hook scripts ─────────────────────────────────────────────────────────
mkdir -p "$HOOKS_DST"
cp "$HOOKS_SRC/brain-reminder.sh"       "$HOOKS_DST/"
cp "$HOOKS_SRC/brain-capture.sh"        "$HOOKS_DST/"
cp "$HOOKS_SRC/brain-autolink.sh"       "$HOOKS_DST/"
cp "$HOOKS_SRC/brain-context.sh"        "$HOOKS_DST/"
cp "$HOOKS_SRC/brain-session-start.sh"  "$HOOKS_DST/"
chmod +x "$HOOKS_DST"/brain-*.sh
echo "✓ Hook scripts installed to $HOOKS_DST"

# ── Merge settings.json ───────────────────────────────────────────────────────
# Resolve absolute paths (JSON does not expand ~ or $HOME).
AUTOLINK="$HOOKS_DST/brain-autolink.sh"
CONTEXT="$HOOKS_DST/brain-context.sh"
REMINDER="$HOOKS_DST/brain-reminder.sh"
CAPTURE="$HOOKS_DST/brain-capture.sh"
SESSION_START="$HOOKS_DST/brain-session-start.sh"

# Preserve existing settings; only overwrite Brain-related hook sections.
mkdir -p "$(dirname "$SETTINGS")"
BASE='{}'
[ -f "$SETTINGS" ] && BASE="$(cat "$SETTINGS")" && cp "$SETTINGS" "${SETTINGS}.bak" && echo "✓ Backed up existing settings to ${SETTINGS}.bak"

SESSION_START_CMD_1="curl -s --max-time 3 '${BRAIN_URL}/api/brain?smart=true&depth=1&fields=label,type,tags,summary' 2>/dev/null || echo '(Brain not reachable)'"
SESSION_START_CMD_2="PROJECT_NAME=\$(basename \"\$PWD\"); RESULT=\$(curl -s --max-time 3 \"${BRAIN_URL}/api/recall?q=\${PROJECT_NAME}+project&budget=300\" 2>/dev/null); if echo \"\$RESULT\" | grep -qi \"\$PROJECT_NAME\"; then echo \"Brain: node for '\$PROJECT_NAME' found.\"; else echo \"Brain: NO node for '\$PROJECT_NAME' found -- please create one!\"; fi"

printf '%s' "$BASE" | jq \
  --arg cmd1 "$SESSION_START_CMD_1" \
  --arg cmd2 "$SESSION_START_CMD_2" \
  --arg autolink "$AUTOLINK" \
  --arg context "$CONTEXT" \
  --arg reminder "$REMINDER" \
  --arg capture "$CAPTURE" \
  --arg session_start "$SESSION_START" \
  '
  .hooks.SessionStart = [{"hooks": [
    {"type":"command","command":$cmd1,"statusMessage":"Loading Brain briefing..."},
    {"type":"command","command":$cmd2,"statusMessage":"Checking Brain project node..."},
    {"type":"command","command":$session_start,"statusMessage":"Creating Brain session node..."}
  ]}] |
  .hooks.PostToolUse = [
    {"matcher":"mcp__brain__brain_create_node","hooks":[{"type":"command","command":$autolink}]},
    {"matcher":"mcp__brain__brain_update_node","hooks":[{"type":"command","command":$autolink}]}
  ] |
  .hooks.PreToolUse = [
    {"matcher":"Edit|Write|Bash","hooks":[{"type":"command","command":$context}]}
  ] |
  .hooks.Stop = [{"hooks":[{"type":"command","command":$reminder}]}] |
  .hooks.SessionEnd = [{"hooks":[{"type":"command","command":$capture}]}]
  ' > "${SETTINGS}.new" && mv "${SETTINGS}.new" "$SETTINGS"

echo "✓ ~/.claude/settings.json configured"
echo ""
echo "Restart Claude Code for hooks to take effect."
echo ""
echo "Verify setup:"
echo "  cat ~/.claude/settings.json | jq '.hooks | keys'"
