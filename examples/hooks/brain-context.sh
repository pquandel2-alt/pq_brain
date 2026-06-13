#!/usr/bin/env bash
# PreToolUse hook: inject Brain project context before the first Edit/Write/Bash
# call of a session. Fires exactly once per session (marker file pattern).
#
# Cost rationale: firing on every Edit/Write/Bash would add ~800 tokens × 20-50
# tool calls = 16k-40k extra tokens per session. Once is enough — the recall
# result stays in context.
#
# Register in ~/.claude/settings.json:
#   "PreToolUse": [
#     {"matcher":"Edit|Write|Bash","hooks":[{"type":"command","command":"~/.claude/hooks/brain-context.sh"}]}
#   ]

BRAIN_URL="${BRAIN_URL:-http://localhost:3000}"
BRAIN_CONTEXT_BUDGET="${BRAIN_CONTEXT_BUDGET:-800}"

INPUT="$(cat)"
SESSION_ID="$(printf '%s' "$INPUT" | jq -r '.session_id // empty' 2>/dev/null || true)"
[ -z "$SESSION_ID" ] && exit 0

MARKER="/tmp/brain-context-${SESSION_ID}"
[ -f "$MARKER" ] && exit 0
touch "$MARKER"

PROJECT=$(basename "$PWD")
curl -s --max-time 3 \
  "$BRAIN_URL/api/recall?q=${PROJECT}&budget=${BRAIN_CONTEXT_BUDGET}" \
  2>/dev/null || true
