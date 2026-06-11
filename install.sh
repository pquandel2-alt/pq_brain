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
echo
