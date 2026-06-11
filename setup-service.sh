#!/bin/bash
set -e

echo "=== Setting up pq_brain as systemd service ==="
echo

# Needs root (writes to /etc/systemd/system).
if [[ $EUID -ne 0 ]]; then
  echo "⚠️  This script needs sudo. Run:"
  echo "   sudo $(cd "$(dirname "$0")" && pwd)/setup-service.sh"
  exit 1
fi

# Host-agnostisch: Pfad aus dem Skript-Ort, Nutzer aus dem Verzeichnis-Owner
# (bzw. SUDO_USER). So funktioniert das Setup auf jedem System, nicht nur hier.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVICE_TEMPLATE="$SCRIPT_DIR/systemd/pq-brain.service"
INSTALL_PATH="/etc/systemd/system/pq-brain.service"
RUN_USER="${SUDO_USER:-$(stat -c '%U' "$SCRIPT_DIR")}"

if [ ! -f "$SERVICE_TEMPLATE" ]; then
  echo "❌ Service template not found: $SERVICE_TEMPLATE"
  exit 1
fi

echo "📋 Generating service file for user '$RUN_USER' at '$SCRIPT_DIR'"
sed -e "s|__USER__|$RUN_USER|g" -e "s|__DIR__|$SCRIPT_DIR|g" \
  "$SERVICE_TEMPLATE" > "$INSTALL_PATH"
chmod 644 "$INSTALL_PATH"

# Optionale Env-Datei anlegen, falls noch nicht vorhanden (aus .env.example).
if [ ! -f /etc/default/pq-brain ] && [ -f "$SCRIPT_DIR/.env.example" ]; then
  echo "📝 Creating /etc/default/pq-brain from .env.example (edit as needed)"
  cp "$SCRIPT_DIR/.env.example" /etc/default/pq-brain
  chmod 600 /etc/default/pq-brain
fi

echo "🔄 Reloading systemd daemon"
systemctl daemon-reload

echo "✅ Enabling service (auto-start on boot)"
systemctl enable pq-brain.service

echo "🚀 Starting service"
systemctl restart pq-brain.service

echo
echo "=== Service setup complete ==="
echo
echo "Config (optional):  /etc/default/pq-brain"
echo "Status:             systemctl status pq-brain"
echo "Logs:               journalctl -u pq-brain -f"
echo "Stop / restart:     systemctl stop|restart pq-brain"
