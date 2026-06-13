#!/bin/bash
# install.sh – Full Brain installation for Ubuntu / Debian
#
# What this does:
#   1. Installs Node.js 22 (via NodeSource) if not already present
#   2. Installs build tools (build-essential, python3) for native modules
#   3. Installs npm dependencies
#   4. Creates .env from .env.example
#   5. Optionally sets up the systemd service (auto-start on boot)
#
# Usage:
#   git clone https://github.com/pquandel2-alt/pq_brain.git
#   cd pq_brain
#   chmod +x install.sh
#   ./install.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NODE_REQUIRED=22

# ── helpers ───────────────────────────────────────────────────────────────────
step() { printf '\n\033[1;34m▶ %s\033[0m\n' "$*"; }
ok()   { printf '  \033[0;32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[0;33m⚠\033[0m  %s\n' "$*"; }
info() { printf '    %s\n' "$*"; }
err()  { printf '\n  \033[0;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

pkg_installed() { dpkg -s "$1" &>/dev/null 2>&1; }

# ── OS check ──────────────────────────────────────────────────────────────────
step "Checking environment"

if [[ "$(uname -s)" != "Linux" ]]; then
  err "This installer supports Linux only. On macOS: brew install node && npm ci && node server.js"
fi

if ! command -v apt-get &>/dev/null; then
  err "apt-get not found. This installer supports Ubuntu and Debian only."
fi

ok "Ubuntu / Debian detected"

# ── Node.js ───────────────────────────────────────────────────────────────────
step "Checking Node.js"

INSTALL_NODE=false
if command -v node &>/dev/null; then
  NODE_VER=$(node -e "process.stdout.write(String(parseInt(process.versions.node)))")
  if [[ "$NODE_VER" -ge "$NODE_REQUIRED" ]]; then
    ok "Node.js $(node --version) is installed"
  else
    warn "Node.js $(node --version) found — v${NODE_REQUIRED}+ required"
    INSTALL_NODE=true
  fi
else
  warn "Node.js not found"
  INSTALL_NODE=true
fi

if [[ "$INSTALL_NODE" == "true" ]]; then
  info "Installing Node.js ${NODE_REQUIRED} via NodeSource (needs sudo) ..."
  command -v curl &>/dev/null || sudo apt-get install -y curl
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_REQUIRED}.x" | sudo -E bash -
  sudo apt-get install -y nodejs
  ok "Node.js $(node --version) installed"
fi

# ── Build tools ───────────────────────────────────────────────────────────────
step "Checking build tools (needed for native SQLite modules)"

MISSING_PKGS=()
pkg_installed build-essential || MISSING_PKGS+=(build-essential)
pkg_installed python3-minimal  || MISSING_PKGS+=(python3-minimal)

if [[ ${#MISSING_PKGS[@]} -gt 0 ]]; then
  info "Installing: ${MISSING_PKGS[*]} (needs sudo) ..."
  sudo apt-get install -y "${MISSING_PKGS[@]}"
  ok "Build tools installed"
else
  ok "Build tools already present"
fi

# ── npm dependencies ──────────────────────────────────────────────────────────
step "Installing npm dependencies"

cd "$SCRIPT_DIR"
if [[ -f package-lock.json ]]; then
  npm ci --omit=dev
else
  npm install --omit=dev
fi

ok "Dependencies installed"

# ── .env ──────────────────────────────────────────────────────────────────────
step "Configuration"

if [[ -f "$SCRIPT_DIR/.env" ]]; then
  ok ".env already exists — keeping it"
elif [[ -f "$SCRIPT_DIR/.env.example" ]]; then
  cp "$SCRIPT_DIR/.env.example" "$SCRIPT_DIR/.env"
  ok ".env created from .env.example"
  info "Edit .env to change port, data directory, etc. (all settings are optional)"
fi

# ── systemd ───────────────────────────────────────────────────────────────────
step "systemd service (auto-start on boot)"

echo
if [[ -t 0 ]]; then
  read -r -p "  Set up systemd service so Brain starts automatically? [Y/n] " REPLY
  REPLY="${REPLY:-Y}"
else
  REPLY="Y"
fi

if [[ "$REPLY" =~ ^[Yy] ]]; then
  sudo "$SCRIPT_DIR/setup-service.sh"
else
  info "Skipping systemd setup."
  info "To start Brain now:     node server.js"
  info "To set up later:        sudo ./setup-service.sh"
fi

# ── Auto-Capture / Ollama (optional) ─────────────────────────────────────────
step "Auto-Capture with Ollama (optional)"
info "Auto-Capture extracts durable knowledge from AI session transcripts"
info "automatically — fully local via Ollama, no cloud account needed."
echo

SETUP_CAPTURE=false
if [[ -t 0 ]]; then
  read -r -p "  Install Ollama and set up Auto-Capture? [Y/n] " REPLY_OLLAMA
  REPLY_OLLAMA="${REPLY_OLLAMA:-Y}"
else
  REPLY_OLLAMA="Y"
fi

if [[ "$REPLY_OLLAMA" =~ ^[Yy] ]]; then
  # jq (benötigt vom Hook für JSON-Parsing)
  if ! command -v jq &>/dev/null; then
    info "Installing jq (required by the capture hook) ..."
    sudo apt-get install -y jq
    ok "jq installed"
  else
    ok "jq already installed"
  fi

  # Ollama installieren
  if command -v ollama &>/dev/null; then
    ok "Ollama already installed"
  else
    info "Installing Ollama (needs sudo) ..."
    curl -fsSL https://ollama.com/install.sh | sh
    ok "Ollama installed"
  fi

  # Modell wählen
  echo
  info "Choose a model for Auto-Capture:"
  info "  1) qwen2.5:3b   — 2 GB · fast · great JSON output  (recommended)"
  info "  2) llama3.2:3b  — 2 GB · general purpose"
  info "  3) phi4-mini    — 2.5 GB · strong reasoning"
  info "  4) mistral:7b   — 4 GB · highest quality"
  info "  5) Custom       — enter any Ollama model name"
  echo

  if [[ -t 0 ]]; then
    read -r -p "  Choice [1]: " MODEL_CHOICE
    MODEL_CHOICE="${MODEL_CHOICE:-1}"
  else
    MODEL_CHOICE="1"
  fi

  case "$MODEL_CHOICE" in
    1) CAPTURE_MODEL="qwen2.5:3b" ;;
    2) CAPTURE_MODEL="llama3.2:3b" ;;
    3) CAPTURE_MODEL="phi4-mini" ;;
    4) CAPTURE_MODEL="mistral:7b" ;;
    5)
      if [[ -t 0 ]]; then
        read -r -p "  Model name (e.g. qwen2.5:1.5b): " CAPTURE_MODEL
        CAPTURE_MODEL="${CAPTURE_MODEL:-qwen2.5:3b}"
      else
        CAPTURE_MODEL="qwen2.5:3b"
      fi
      ;;
    *) CAPTURE_MODEL="qwen2.5:3b" ;;
  esac

  info "Pulling ${CAPTURE_MODEL} — this may take a few minutes ..."
  ollama pull "$CAPTURE_MODEL"
  ok "Model ${CAPTURE_MODEL} ready"

  # Auto-Capture-Einstellungen in .env schreiben
  ENV_FILE="$SCRIPT_DIR/.env"
  if ! grep -q "BRAIN_CAPTURE_BACKEND" "$ENV_FILE" 2>/dev/null; then
    {
      echo ""
      echo "# ── Auto-Capture ──────────────────────────────────────────────────"
      echo "BRAIN_CAPTURE_BACKEND=ollama"
      echo "OLLAMA_URL=http://localhost:11434"
      echo "BRAIN_CAPTURE_OLLAMA_MODEL=${CAPTURE_MODEL}"
      echo "BRAIN_CAPTURE_OLLAMA_TIMEOUT=1800"
    } >> "$ENV_FILE"
    ok "Auto-Capture settings written to .env"
  else
    ok "Auto-Capture settings already in .env — skipping"
  fi

  # Hook installieren
  HOOK_SRC="$SCRIPT_DIR/examples/hooks/brain-capture.sh"
  HOOK_DST="$HOME/.claude/hooks/brain-capture.sh"
  mkdir -p "$HOME/.claude/hooks"
  cp "$HOOK_SRC" "$HOOK_DST"
  chmod +x "$HOOK_DST"
  ok "Hook installed at $HOOK_DST"

  # In Claude Code settings.json registrieren (falls Claude Code installiert)
  CLAUDE_SETTINGS="$HOME/.claude/settings.json"
  if command -v claude &>/dev/null || [[ -f "$CLAUDE_SETTINGS" ]]; then
    # Python-Hilfsskript in Temp-Datei — vermeidet Quoting-Probleme im Heredoc
    PY_TMP=$(mktemp /tmp/brain-register-hook.XXXXXX.py)
    cat > "$PY_TMP" << 'PYEOF'
import sys, json, os

settings_path = sys.argv[1]
hook_cmd      = sys.argv[2]

try:
    with open(settings_path, 'r') as f:
        s = json.load(f)
except (FileNotFoundError, json.JSONDecodeError):
    s = {}

hooks       = s.setdefault('hooks', {})
session_end = hooks.setdefault('SessionEnd', [])

# Bereits registriert?
for entry in session_end:
    for h in entry.get('hooks', []):
        if h.get('command') == hook_cmd:
            print('already_registered')
            sys.exit(0)

session_end.append({'hooks': [{'type': 'command', 'command': hook_cmd}]})

os.makedirs(os.path.dirname(settings_path), exist_ok=True)
with open(settings_path, 'w') as f:
    json.dump(s, f, indent=2, ensure_ascii=False)
    f.write('\n')

print('registered')
PYEOF

    REG=$(python3 "$PY_TMP" "$CLAUDE_SETTINGS" "$HOOK_DST" 2>/dev/null || echo "error")
    rm -f "$PY_TMP"

    if [[ "$REG" == "registered" ]]; then
      ok "SessionEnd hook registered in $CLAUDE_SETTINGS"
    elif [[ "$REG" == "already_registered" ]]; then
      ok "SessionEnd hook already registered"
    else
      warn "Could not auto-register hook. Add manually to $CLAUDE_SETTINGS:"
      info "  \"SessionEnd\": [{\"hooks\": [{\"type\": \"command\", \"command\": \"$HOOK_DST\"}]}]"
    fi
  else
    warn "Claude Code not found — hook installed but not registered."
    info "If you use Claude Code later, add to ~/.claude/settings.json:"
    info "  \"SessionEnd\": [{\"hooks\": [{\"type\": \"command\", \"command\": \"$HOOK_DST\"}]}]"
    info "Or re-run this installer after installing Claude Code."
  fi

  SETUP_CAPTURE=true
fi

# ── done ──────────────────────────────────────────────────────────────────────
echo
echo "  ╔══════════════════════════════════════════════════╗"
echo "  ║  Brain is ready!                                ║"
echo "  ║                                                  ║"
echo "  ║  UI      http://localhost:3000                   ║"
echo "  ║  Health  curl http://localhost:3000/api/health   ║"
echo "  ║  Logs    journalctl -u pq-brain -f               ║"
echo "  ╚══════════════════════════════════════════════════╝"
echo
echo "  Note: The first start downloads the bge-m3 embedding model"
echo "  (~400 MB). This happens once and is then cached locally."
if [[ "$SETUP_CAPTURE" == "true" ]]; then
  echo
  echo "  Auto-Capture: every session end → Ollama extracts knowledge"
  echo "  → Brain Inbox → review in the GUI at http://localhost:3000"
  echo "  → Training data: GET http://localhost:3000/api/inbox/decisions?format=jsonl"
fi
echo
