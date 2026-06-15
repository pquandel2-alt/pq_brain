#!/usr/bin/env bash
#
# Brain Session-Start — erstellt einen ephemeren Session-Knoten (Kurzzeitgedächtnis).
#
# Wird als Teil des SessionStart-Hooks ausgeführt. Legt einen Knoten an der
# aktuellen Sitzung entspricht: type=session, TTL=48h. Die ID wird in einer
# Temp-Datei gespeichert (~/.cache/brain/session-<SESSION_ID>.id) damit
# brain-capture.sh am SessionEnd den Knoten mit einer Zusammenfassung befüllen kann.
#
# Integration in ~/.claude/settings.json:
#   SessionStart → brain-session-start.sh (nach dem Briefing-Curl)

set -euo pipefail

BRAIN_URL="${BRAIN_URL:-http://localhost:3000}"
CACHE_DIR="${HOME}/.cache/brain"
LOG="${BRAIN_SESSION_LOG:-${HOME}/.claude/hooks/brain-session.log}"

log() { echo "[$(date -Is)] $*" >>"$LOG" 2>/dev/null || true; }

mkdir -p "$CACHE_DIR" 2>/dev/null || true

# SessionStart-Payload von stdin.
INPUT="$(cat)"
SESSION_ID="$(printf '%s' "$INPUT" | jq -r '.session_id // empty' 2>/dev/null || true)"
[ -n "$SESSION_ID" ] || { log "kein session_id — abbruch"; exit 0; }

# Keine Doppelanlage: Wenn schon eine Session-ID-Datei existiert, fertig.
SESSION_FILE="${CACHE_DIR}/session-${SESSION_ID}.id"
[ -f "$SESSION_FILE" ] && { log "session=$SESSION_ID: bereits angelegt"; exit 0; }

# Session-Label: ISO-Datum + Uhrzeit für menschliche Lesbarkeit.
LABEL="Session $(date -u '+%Y-%m-%d %H:%M') UTC"
PROJECT_NAME="$(basename "$PWD" 2>/dev/null || echo 'unknown')"

PAYLOAD="$(jq -n \
  --arg label "$LABEL" \
  --arg project "$PROJECT_NAME" \
  --arg sid "$SESSION_ID" \
  '{
    label: $label,
    type: "session",
    ttl: 172800,
    importance: "medium",
    tags: ["session", "auto"],
    source: "claude-code",
    summary: ("Session in project: " + $project),
    content: ("**Project:** " + $project + "\n**Session ID:** " + $sid + "\n**Status:** active")
  }')"

RESP="$(curl -s --max-time 5 -X POST "${BRAIN_URL}/api/nodes" \
  -H 'Content-Type: application/json' \
  -d "$PAYLOAD" 2>/dev/null || true)"

NODE_ID="$(printf '%s' "$RESP" | jq -r '.id // empty' 2>/dev/null || true)"
if [ -n "$NODE_ID" ]; then
  echo "$NODE_ID" > "$SESSION_FILE"
  log "session=$SESSION_ID: Knoten $NODE_ID angelegt ('$LABEL')"
  echo "Brain: Session-Knoten angelegt — '$LABEL' (ID: $NODE_ID)"
else
  log "session=$SESSION_ID: Knoten-Anlage fehlgeschlagen: $RESP"
fi

exit 0
