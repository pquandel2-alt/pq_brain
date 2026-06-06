#!/bin/bash
set -e

echo "=== Setting up pq_brain as systemd service ==="
echo

# Check if running as root
if [[ $EUID -ne 0 ]]; then
  echo "⚠️  This script needs sudo. Run:"
  echo "   sudo ./setup-service.sh"
  exit 1
fi

SERVICE_FILE="systemd/pq-brain.service"
INSTALL_PATH="/etc/systemd/system/pq-brain.service"

if [ ! -f "$SERVICE_FILE" ]; then
  echo "❌ Service file not found: $SERVICE_FILE"
  exit 1
fi

echo "📋 Installing service file to $INSTALL_PATH"
cp "$SERVICE_FILE" "$INSTALL_PATH"
chmod 644 "$INSTALL_PATH"

echo "🔄 Reloading systemd daemon"
systemctl daemon-reload

echo "✅ Enabling service (auto-start on boot)"
systemctl enable pq-brain.service

echo "🚀 Starting service"
systemctl start pq-brain.service

echo
echo "=== Service setup complete ==="
echo
echo "Verify status:"
echo "   systemctl status pq-brain"
echo
echo "View logs:"
echo "   journalctl -u pq-brain -f"
echo
echo "Manual commands:"
echo "   systemctl stop pq-brain"
echo "   systemctl restart pq-brain"
echo "   systemctl disable pq-brain  (removes auto-start)"
