#!/usr/bin/env bash
# PostToolUse hook: auto-link + auto-summary after brain_create_node / brain_update_node.
#
# Fires after every brain_create_node and brain_update_node MCP tool call.
# 1. If the new node has no summary (or a very short one), generates one via
#    headless `claude -p --model haiku`.
# 2. Waits for the async vector embedding, then fetches suggest-links and
#    automatically creates all links involving the new node.
#
# Register in ~/.claude/settings.json:
#   "PostToolUse": [
#     {"matcher":"mcp__brain__brain_create_node","hooks":[{"type":"command","command":"~/.claude/hooks/brain-autolink.sh"}]},
#     {"matcher":"mcp__brain__brain_update_node","hooks":[{"type":"command","command":"~/.claude/hooks/brain-autolink.sh"}]}
#   ]

set -euo pipefail
BRAIN_URL="${BRAIN_URL:-http://localhost:3000}"
LOG="${BRAIN_AUTOLINK_LOG:-$HOME/.claude/hooks/brain-autolink.log}"
log() { echo "[$(date -Is)] $*" >>"$LOG" 2>/dev/null || true; }

# Recursion guard: headless `claude -p` call would re-trigger this hook.
[ "${BRAIN_AUTOLINK:-}" = "1" ] && exit 0

INPUT="$(cat)"
TOOL_RESP="$(printf '%s' "$INPUT" | jq -r '.tool_response // empty' 2>/dev/null || true)"
[ -z "$TOOL_RESP" ] && exit 0

NODE_DATA="$(printf '%s' "$TOOL_RESP" | jq 'if type=="string" then fromjson else . end' 2>/dev/null || true)"
NODE_ID="$(printf '%s' "$NODE_DATA" | jq -r '.id // empty' 2>/dev/null || true)"
[ -z "$NODE_ID" ] && exit 0

(
  # 1. Summary check: generate one via headless Claude if missing or too short.
  SUMMARY="$(printf '%s' "$NODE_DATA" | jq -r '.summary // empty' 2>/dev/null || true)"
  LABEL="$(printf '%s' "$NODE_DATA" | jq -r '.label // empty' 2>/dev/null || true)"
  CONTENT="$(printf '%s' "$NODE_DATA" | jq -r '.content // empty' 2>/dev/null | head -c 500 || true)"
  if [ "${#SUMMARY}" -lt 20 ] && [ -n "$LABEL" ]; then
    NEW_SUMMARY="$(BRAIN_AUTOLINK=1 claude -p --model haiku \
      "Write a concise one-sentence summary (max 120 characters) for this Brain knowledge node.\nLabel: $LABEL\nContent: $CONTENT\nOutput only the summary text, no explanation." \
      2>>"$LOG" | tr -d '\n' | head -c 120 || true)"
    if [ -n "$NEW_SUMMARY" ]; then
      curl -s --max-time 5 -X PUT "$BRAIN_URL/api/nodes/$NODE_ID" \
        -H 'Content-Type: application/json' \
        -d "{\"summary\":$(printf '%s' "$NEW_SUMMARY" | jq -Rs .)}" >/dev/null 2>&1 || true
      log "node=$NODE_ID: summary generated"
    fi
  fi

  # 2. Auto-link: wait for async vector embedding, then fetch and apply suggestions.
  sleep 4
  SUGGESTIONS="$(curl -s --max-time 10 "$BRAIN_URL/api/brain/suggest-links?limit=30" 2>/dev/null || true)"
  [ -z "$SUGGESTIONS" ] && exit 0

  LINKED=0
  while IFS= read -r pair; do
    SRC="$(printf '%s' "$pair" | jq -r '.source.id')"
    TGT="$(printf '%s' "$pair" | jq -r '.target.id')"
    [ "$SRC" = "$NODE_ID" ] || [ "$TGT" = "$NODE_ID" ] || continue
    curl -s --max-time 5 -X POST "$BRAIN_URL/api/links" \
      -H 'Content-Type: application/json' \
      -d "{\"source\":\"$SRC\",\"target\":\"$TGT\"}" >/dev/null 2>&1 || true
    LINKED=$((LINKED + 1))
  done < <(printf '%s' "$SUGGESTIONS" | jq -c '.suggestions[]' 2>/dev/null || true)

  log "node=$NODE_ID: $LINKED link(s) created"
) &
disown 2>/dev/null || true
exit 0
