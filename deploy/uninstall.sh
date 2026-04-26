#!/usr/bin/env bash
# Cleanly remove emporia-monitor from a remote host.
# Reads DEPLOY_HOST and DEPLOY_DIR from .env (same as deploy.sh).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.."; pwd)"
cd "$ROOT"

[ -f .env ] && { set -a; . ./.env; set +a; }

: "${DEPLOY_HOST:?Set DEPLOY_HOST in .env}"
: "${DEPLOY_DIR:=/home/${DEPLOY_HOST%%@*}/emporia-monitor}"
: "${DEPLOY_SERVICE_NAME:=emporia-monitor}"

SSH_OPTS=(-o StrictHostKeyChecking=accept-new -o LogLevel=ERROR)

if [ -n "${DEPLOY_PASSWORD:-}" ]; then
  ssh_pi() { sshpass -p "$DEPLOY_PASSWORD" ssh "${SSH_OPTS[@]}" "$DEPLOY_HOST" "$@"; }
else
  ssh_pi() { ssh "${SSH_OPTS[@]}" "$DEPLOY_HOST" "$@"; }
fi

echo "Uninstalling $DEPLOY_SERVICE_NAME from $DEPLOY_HOST..."
ssh_pi "
  sudo systemctl stop ${DEPLOY_SERVICE_NAME} 2>/dev/null || true
  sudo systemctl disable ${DEPLOY_SERVICE_NAME} 2>/dev/null || true
  sudo rm -f /etc/systemd/system/${DEPLOY_SERVICE_NAME}.service
  sudo systemctl daemon-reload
  rm -rf '$DEPLOY_DIR'
"
echo "✓ Removed service, systemd unit, and $DEPLOY_DIR"
