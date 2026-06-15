#!/usr/bin/env bash
#
# Brain Auto-Capture — Claude-Code SessionEnd-Hook.
#
# Liest das Session-Transcript, lässt ein günstiges Modell (Haiku) dauerhafte
# Erkenntnisse/Entscheidungen/Präferenzen als JSON extrahieren und schickt sie
# als Inbox-Kandidaten an Brain (POST /api/inbox). Dort warten sie mit Tag
# `inbox` + TTL auf Review — Dedup verhindert Doppelungen.
#
# Backend wählbar via BRAIN_CAPTURE_BACKEND=claude|ollama (Default: claude).
# Bei `ollama` läuft die Extraktion lokal-first gegen OLLAMA_URL mit
# BRAIN_CAPTURE_OLLAMA_MODEL und erzwungenem JSON-Output (format:json).
#
# Installation: nach ~/.claude/hooks/ kopieren, ausführbar machen und in
# ~/.claude/settings.json unter hooks.SessionEnd registrieren:
#   { "hooks": [ { "type": "command", "command": "~/.claude/hooks/brain-capture.sh" } ] }
#
# Der Hook ist bewusst "fail-silent": jeder Fehler beendet ihn ohne die Session
# zu stören. Die eigentliche Arbeit läuft im Hintergrund (& disown) ab, damit
# das Session-Ende nicht blockiert.

set -euo pipefail

BRAIN_URL="${BRAIN_URL:-http://localhost:3000}"
LOG="${BRAIN_CAPTURE_LOG:-$HOME/.claude/hooks/brain-capture.log}"
MIN_MESSAGES="${BRAIN_CAPTURE_MIN_MESSAGES:-10}"
MODEL="${BRAIN_CAPTURE_MODEL:-haiku}"
MAX_CHARS="${BRAIN_CAPTURE_MAX_CHARS:-30000}"
BACKEND="${BRAIN_CAPTURE_BACKEND:-claude}"
OLLAMA_URL="${OLLAMA_URL:-http://localhost:11434}"
OLLAMA_MODEL="${BRAIN_CAPTURE_OLLAMA_MODEL:-qwen2.5:3b}"
# VM ohne AVX2: lokale Inferenz dauert Minuten — Hintergrund-Hook, Latenz egal.
OLLAMA_TIMEOUT="${BRAIN_CAPTURE_OLLAMA_TIMEOUT:-1800}"

log() { echo "[$(date -Is)] $*" >>"$LOG" 2>/dev/null || true; }

# ── Rekursionsschutz ──────────────────────────────────────────────────────
# Der headless `claude -p`-Aufruf weiter unten löst selbst wieder Hooks aus.
# Ohne diesen Guard würde sich der Capture endlos selbst triggern.
if [ "${BRAIN_CAPTURE:-}" = "1" ]; then
  exit 0
fi

# Hook-Payload von stdin (JSON: transcript_path, session_id, reason, ...).
INPUT="$(cat)"
command -v jq >/dev/null 2>&1 || { log "jq fehlt — abbruch"; exit 0; }

TRANSCRIPT="$(printf '%s' "$INPUT" | jq -r '.transcript_path // empty')"
SESSION_ID="$(printf '%s' "$INPUT" | jq -r '.session_id // empty')"
REASON="$(printf '%s' "$INPUT" | jq -r '.reason // empty')"

# clear/compact sind keine echten Session-Enden mit Erkenntniswert.
case "$REASON" in
  clear|compact) log "skip (reason=$REASON)"; exit 0 ;;
esac

[ -n "$TRANSCRIPT" ] && [ -f "$TRANSCRIPT" ] || { log "kein Transcript ($TRANSCRIPT)"; exit 0; }

# Kosten-Gate: nur Sessions mit genug Substanz.
MSG_COUNT="$(grep -c '"type":"user"' "$TRANSCRIPT" 2>/dev/null || echo 0)"
if [ "$MSG_COUNT" -lt "$MIN_MESSAGES" ]; then
  log "skip (nur $MSG_COUNT user-messages < $MIN_MESSAGES)"
  exit 0
fi

# ── Eigentliche Extraktion im Hintergrund ─────────────────────────────────
(
  # Transcript zu reinem Text kondensieren (nur User/Assistant-Prosa, Tool-Lärm
  # raus), auf MAX_CHARS vom Ende begrenzen (jüngster Kontext zählt am meisten).
  CONDENSED="$(jq -r '
    select(.type=="user" or .type=="assistant")
    | .message.content
    | if type=="array" then map(select(.type=="text").text) | join("\n") else . end
    | select(. != null and . != "")
  ' "$TRANSCRIPT" 2>/dev/null | tail -c "$MAX_CHARS")"

  [ -n "$CONDENSED" ] || { log "leeres Transcript nach Kondensierung"; exit 0; }

  # Few-Shot-Block aus vergangenen Inbox-Entscheidungen aufbauen.
  # Bis zu 3 accepted + 3 rejected als Beispiele → verbessert Präzision ohne Fine-Tune.
  FEW_SHOT_BLOCK=""
  DECISIONS_RAW="$(curl -s --max-time 5 "${BRAIN_URL}/api/inbox/decisions?limit=30" 2>/dev/null || true)"
  if [ -n "$DECISIONS_RAW" ] && echo "$DECISIONS_RAW" | jq -e '.items | length > 0' >/dev/null 2>&1; then
    ACCEPTED="$(echo "$DECISIONS_RAW" | jq -r '.items | map(select(.decision=="accepted")) | .[0:3][] | "✓ \"" + .label + "\" (" + (.type//"note") + ") — " + (.summary//"dauerhaftes Wissen")' 2>/dev/null || true)"
    REJECTED="$(echo "$DECISIONS_RAW" | jq -r '.items | map(select(.decision=="rejected")) | .[0:3][] | "✗ \"" + .label + "\" (" + (.type//"note") + ") — flüchtig/irrelevant"' 2>/dev/null || true)"
    if [ -n "$ACCEPTED" ] || [ -n "$REJECTED" ]; then
      FEW_SHOT_BLOCK="Lernbeispiele aus früheren Reviews:
$([ -n "$ACCEPTED" ] && echo "BEHALTEN (accepted):
$ACCEPTED")
$([ -n "$REJECTED" ] && echo "VERWORFEN (rejected):
$REJECTED")

"
    fi
  fi

  PROMPT="$(cat <<'EOF'
Du extrahierst dauerhaftes Wissen aus einem Coding-Session-Transcript für einen
persönlichen Knowledge-Graph ("Brain"). Gib AUSSCHLIESSLICH gültiges JSON zurück:

{"nodes":[{"label":"...","type":"note|idea|project|reference|memory","content":"...","summary":"...","tags":["..."],"confidence":0.9}]}

Regeln:
- Nur DAUERHAFTE Erkenntnisse: getroffene Entscheidungen, gelöste Probleme/Patterns,
  Nutzer-Präferenzen, wichtige Fakten über Projekte/Tooling.
- KEIN Smalltalk, keine flüchtigen Zwischenschritte, keine reinen Tool-Ausgaben.
- label: prägnant, eindeutig. summary: 1 Satz. content: knappes Markdown.
- confidence: 0.0–1.0. Hohe Werte (>=0.85) für klare, eindeutige Fakten/Entscheidungen.
  Niedrige Werte für unsichere oder kontextabhängige Erkenntnisse.
- Im Zweifel WENIGER. Wenn nichts Dauerhaftes dabei ist: {"nodes":[]}.
- Maximal 5 Knoten.
Gib nur das JSON aus, keine Erklärung, kein Markdown-Codeblock.
EOF
)"

  # Few-Shot-Block voranstellen (nur wenn Beispiele vorhanden).
  if [ -n "$FEW_SHOT_BLOCK" ]; then
    PROMPT="${FEW_SHOT_BLOCK}${PROMPT}"
  fi

  FULL_PROMPT="$PROMPT

--- TRANSCRIPT ---
$CONDENSED"

  case "$BACKEND" in
    ollama)
      # Lokale Extraktion: /api/generate mit format:json zwingt gültiges JSON.
      # num_ctx großzügig, sonst schneidet Ollama das Transcript bei 2048 ab.
      REQ="$(jq -n --arg model "$OLLAMA_MODEL" --arg prompt "$FULL_PROMPT" \
        '{model:$model, prompt:$prompt, stream:false, format:"json",
          options:{temperature:0, num_ctx:8192}}')"
      RESULT="$(curl -s --max-time "$OLLAMA_TIMEOUT" -X POST "$OLLAMA_URL/api/generate" \
        -H 'Content-Type: application/json' -d "$REQ" 2>>"$LOG" \
        | jq -r '.response // empty' 2>/dev/null || true)"
      [ -n "$RESULT" ] || { log "session=$SESSION_ID: ollama ($OLLAMA_MODEL) lieferte nichts — abbruch"; exit 0; }
      ;;
    *)
      # Headless-Extraktion mit Rekursionsschutz-Flag.
      RESULT="$(BRAIN_CAPTURE=1 claude -p --model "$MODEL" "$FULL_PROMPT" 2>>"$LOG" || true)"
      ;;
  esac

  # Mögliche ```json-Fences entfernen, dann auf gültiges JSON prüfen.
  RESULT="$(printf '%s' "$RESULT" | sed -e 's/^```json//' -e 's/^```//' -e 's/```$//')"
  NODES="$(printf '%s' "$RESULT" | jq -c '.nodes // empty' 2>/dev/null || true)"
  if [ -z "$NODES" ] || [ "$NODES" = "[]" ]; then
    log "session=$SESSION_ID: keine Kandidaten extrahiert"
    exit 0
  fi

  PAYLOAD="$(jq -n --arg sid "$SESSION_ID" --argjson nodes "$NODES" \
    '{session_id:$sid, nodes:$nodes}')"
  RESP="$(curl -s --max-time 20 -X POST "$BRAIN_URL/api/inbox" \
    -H 'Content-Type: application/json' -d "$PAYLOAD" 2>>"$LOG" || true)"
  CREATED="$(printf '%s' "$RESP" | jq -r '.created // "?"' 2>/dev/null || echo '?')"
  FAILED="$(printf '%s' "$RESP" | jq -r '.failed // "?"' 2>/dev/null || echo '?')"
  log "session=$SESSION_ID: created=$CREATED skipped/dup=$FAILED"

  # Session-Knoten mit Zusammenfassung befüllen (Kurzzeitgedächtnis abschließen).
  CACHE_DIR="${HOME}/.cache/brain"
  SESSION_FILE="${CACHE_DIR}/session-${SESSION_ID}.id"
  if [ -f "$SESSION_FILE" ]; then
    NODE_ID="$(cat "$SESSION_FILE")"
    NODE_LABELS="$(printf '%s' "$NODES" | jq -r '.[].label' 2>/dev/null | head -5 | tr '\n' ', ' | sed 's/,$//')"
    SESSION_SUMMARY="Session beendet — ${CREATED} Erkenntnisse extrahiert: ${NODE_LABELS:-keine}"
    SESSION_CONTENT="$(printf '%s' "$NODES" | jq -r '.[] | "- **" + .label + "**: " + (.summary // .content[:80] // "")' 2>/dev/null | head -10)"
    UPDATE_PAYLOAD="$(jq -n \
      --arg summary "$SESSION_SUMMARY" \
      --arg content "$(printf '## Extrahierte Erkenntnisse\n%s' "$SESSION_CONTENT")" \
      '{summary: $summary, content: $content, tags: ["session", "auto", "done"]}')"
    curl -s --max-time 10 -X PUT "${BRAIN_URL}/api/nodes/${NODE_ID}" \
      -H 'Content-Type: application/json' \
      -d "$UPDATE_PAYLOAD" >>"$LOG" 2>&1 || true
    rm -f "$SESSION_FILE" 2>/dev/null || true
    log "session=$SESSION_ID: Session-Knoten $NODE_ID abgeschlossen"
  fi
) &
disown || true

exit 0
