#!/usr/bin/env bash
# Stop-Hook: reminds the AI once per session to write new insights to Brain.
# Also triggers brain-capture.sh in the background (SessionEnd is unreliable).
# Marker file per session_id ensures the block fires exactly once.

input=$(cat)

# Infinite-loop guard: if we already blocked once, let through.
if echo "$input" | grep -q '"stop_hook_active":[[:space:]]*true'; then
  exit 0
fi

session_id=$(echo "$input" | sed -n 's/.*"session_id":[[:space:]]*"\([^"]*\)".*/\1/p')
[ -z "$session_id" ] && exit 0

marker="/tmp/brain-reminder-${session_id}"
[ -f "$marker" ] && exit 0
touch "$marker"

# Trigger auto-capture in background (SessionEnd hook does not fire reliably
# in all Claude Code environments, so we piggyback on Stop instead).
CAPTURE_SCRIPT="$HOME/.claude/hooks/brain-capture.sh"
[ -x "$CAPTURE_SCRIPT" ] && printf '%s' "$input" | "$CAPTURE_SCRIPT" &
disown 2>/dev/null || true

cat <<'JSON'
{"decision":"block","reason":"Brain check: if this session produced new insights, decisions, or project progress, write them to Brain now (brain_create_node / brain_update_node, always include a summary). If nothing new: just exit."}
JSON
