#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Optional Raspberry Pi deployment pipeline.
# Reads config from .env (DEPLOY_*). Set DEPLOY_ENABLED=1 to use.
#
# What it does (idempotent — re-run anytime to push updates):
#   1. SSH into a target host
#   2. Drop a self-contained Node.js into <APP_DIR>/.node (NOT system-wide)
#   3. rsync source files into <APP_DIR>
#   4. npm install --omit=dev
#   5. Install systemd unit + start service
#
# Isolation: runs as the SSH user, port from .env (default 3030), resource
# limits (256 MB memory, 40% CPU), strict systemd hardening. Does not touch
# any other services on the target.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.."; pwd)"
cd "$ROOT"

# ─── Load .env ───────────────────────────────────────────────────────────────
if [ -f .env ]; then
  set -a; . ./.env; set +a
fi

# ─── Required config ─────────────────────────────────────────────────────────
: "${DEPLOY_ENABLED:=0}"

if [ "$DEPLOY_ENABLED" != "1" ]; then
  echo "Deployment is disabled. Set DEPLOY_ENABLED=1 in .env to enable."
  echo "See .env.example for required DEPLOY_* variables."
  exit 0
fi

: "${DEPLOY_HOST:?Set DEPLOY_HOST in .env (e.g. user@hostname.local)}"
: "${DEPLOY_DIR:=/home/${DEPLOY_HOST%%@*}/emporia-monitor}"
: "${DEPLOY_PORT:=${PORT:-3030}}"
: "${DEPLOY_NODE_VERSION:=20.18.1}"
: "${DEPLOY_SERVICE_NAME:=emporia-monitor}"

NODE_TARBALL="node-v${DEPLOY_NODE_VERSION}-linux-arm64.tar.xz"
NODE_URL="https://nodejs.org/dist/v${DEPLOY_NODE_VERSION}/${NODE_TARBALL}"

# ─── SSH wrappers (key auth or sshpass) ──────────────────────────────────────
SSH_OPTS=(-o StrictHostKeyChecking=accept-new -o LogLevel=ERROR)

if [ -n "${DEPLOY_PASSWORD:-}" ]; then
  command -v sshpass >/dev/null \
    || { echo "❌ sshpass required for password auth. brew install sshpass" >&2; exit 1; }
  ssh_pi()   { sshpass -p "$DEPLOY_PASSWORD" ssh   "${SSH_OPTS[@]}" "$DEPLOY_HOST" "$@"; }
  scp_pi()   { sshpass -p "$DEPLOY_PASSWORD" scp   "${SSH_OPTS[@]}" "$@"; }
  rsync_pi() { sshpass -p "$DEPLOY_PASSWORD" rsync -e "ssh ${SSH_OPTS[*]}" "$@"; }
else
  ssh_pi()   { ssh "${SSH_OPTS[@]}" "$DEPLOY_HOST" "$@"; }
  scp_pi()   { scp "${SSH_OPTS[@]}" "$@"; }
  rsync_pi() { rsync -e "ssh ${SSH_OPTS[*]}" "$@"; }
fi

step() { printf "\n\033[1;36m▸ %s\033[0m\n" "$*"; }
ok()   { printf "  \033[1;32m✓\033[0m %s\n" "$*"; }
warn() { printf "  \033[1;33m!\033[0m %s\n" "$*"; }

command -v rsync >/dev/null || { echo "❌ rsync not installed (run: brew install rsync)" >&2; exit 1; }

echo "╭─────────────────────────────────────────────╮"
echo "│ emporia-monitor — deploy                     │"
echo "├─────────────────────────────────────────────┤"
printf "│ Target:     %-32s │\n" "$DEPLOY_HOST"
printf "│ Path:       %-32s │\n" "$DEPLOY_DIR"
printf "│ Port:       %-32s │\n" "$DEPLOY_PORT"
printf "│ Service:    %-32s │\n" "$DEPLOY_SERVICE_NAME"
echo "╰─────────────────────────────────────────────╯"

# ─── 1. Connectivity ─────────────────────────────────────────────────────────
step "[1/6] Verifying connectivity"
ssh_pi "echo connected as \$(whoami) on \$(hostname)" || { echo "❌ SSH failed"; exit 1; }
ok "SSH OK"

# ─── 2. Self-contained Node.js ───────────────────────────────────────────────
step "[2/6] Ensuring Node.js v$DEPLOY_NODE_VERSION (sandboxed in $DEPLOY_DIR/.node)"
ssh_pi "mkdir -p '$DEPLOY_DIR'"
NODE_BIN="$DEPLOY_DIR/.node/bin/node"

if ssh_pi "test -x '$NODE_BIN' && '$NODE_BIN' -v 2>/dev/null | grep -q 'v$DEPLOY_NODE_VERSION'"; then
  ok "Node v$DEPLOY_NODE_VERSION already installed"
else
  warn "Downloading Node.js v$DEPLOY_NODE_VERSION (arm64)..."
  ssh_pi "
    set -e
    cd /tmp
    curl -fsSL --retry 3 -o '$NODE_TARBALL' '$NODE_URL'
    tar -xJf '$NODE_TARBALL'
    rm -rf '$DEPLOY_DIR/.node'
    mv 'node-v${DEPLOY_NODE_VERSION}-linux-arm64' '$DEPLOY_DIR/.node'
    rm '$NODE_TARBALL'
  "
  ok "Installed: $(ssh_pi $NODE_BIN -v)"
fi

# ─── 3. Sync source ──────────────────────────────────────────────────────────
step "[3/6] Syncing source files"
rsync_pi -az \
  --include='package.json' \
  --include='package-lock.json' \
  --include='bin/' --include='bin/**' \
  --include='src/' --include='src/**' \
  --include='public/' --include='public/**' \
  --exclude='*' \
  ./ "$DEPLOY_HOST:$DEPLOY_DIR/"
ok "Source synced"

# Push .env (filtered: only the keys the runtime needs).
# DATA_DIR is forced inside the app dir because systemd hardening (ProtectHome=tmpfs)
# blocks the default ~/.local/share/ location.
TMPENV=$(mktemp); trap 'rm -f $TMPENV' EXIT
{
  grep -E '^(EMPORIA_|PLUGIN|HOST|LOG_LEVEL)' .env 2>/dev/null || true
  echo "PORT=$DEPLOY_PORT"
  echo "DATA_DIR=$DEPLOY_DIR/data"
} > "$TMPENV"
scp_pi "$TMPENV" "$DEPLOY_HOST:$DEPLOY_DIR/.env"
ssh_pi "chmod 600 '$DEPLOY_DIR/.env' && mkdir -p '$DEPLOY_DIR/data'"
ok "Runtime config installed"

# ─── 4. npm install ─────────────────────────────────────────────────────────
step "[4/6] Installing dependencies (in app dir, not system)"
ssh_pi "cd '$DEPLOY_DIR' && PATH='$DEPLOY_DIR/.node/bin':\$PATH npm install --omit=dev --no-audit --no-fund --silent 2>&1 | tail -3"
ok "Dependencies installed"

# ─── 5. systemd service ──────────────────────────────────────────────────────
step "[5/6] Installing systemd unit"
SVC_USER="${DEPLOY_HOST%%@*}"
TMPSVC=$(mktemp)
sed -e "s|@APP_DIR@|$DEPLOY_DIR|g" \
    -e "s|@USER@|$SVC_USER|g" \
    -e "s|@PORT@|$DEPLOY_PORT|g" \
    deploy/emporia-monitor.service.tmpl > "$TMPSVC"

scp_pi "$TMPSVC" "$DEPLOY_HOST:/tmp/${DEPLOY_SERVICE_NAME}.service.new"
rm -f "$TMPSVC"

if ssh_pi "! cmp -s /tmp/${DEPLOY_SERVICE_NAME}.service.new /etc/systemd/system/${DEPLOY_SERVICE_NAME}.service 2>/dev/null"; then
  ssh_pi "
    sudo mv /tmp/${DEPLOY_SERVICE_NAME}.service.new /etc/systemd/system/${DEPLOY_SERVICE_NAME}.service
    sudo chmod 644 /etc/systemd/system/${DEPLOY_SERVICE_NAME}.service
    sudo systemctl daemon-reload
    sudo systemctl enable ${DEPLOY_SERVICE_NAME} >/dev/null 2>&1
  "
  ok "Service file updated"
else
  ssh_pi "rm -f /tmp/${DEPLOY_SERVICE_NAME}.service.new"
  ok "Service file unchanged"
fi
ssh_pi "sudo systemctl restart ${DEPLOY_SERVICE_NAME}"
ok "Service restarted"

# ─── 6. Verify ───────────────────────────────────────────────────────────────
step "[6/6] Verifying"
sleep 4
ACTIVE=$(ssh_pi "sudo systemctl is-active ${DEPLOY_SERVICE_NAME}" || echo "failed")
if [ "$ACTIVE" != "active" ]; then
  echo ""
  echo "❌ Service failed to start. Recent logs:"
  ssh_pi "sudo journalctl -u ${DEPLOY_SERVICE_NAME} -n 30 --no-pager"
  exit 1
fi
ok "Service active"

API=$(ssh_pi "curl -sf -m 10 http://localhost:$DEPLOY_PORT/api/health" || echo "")
[ -n "$API" ] && ok "API responding" || warn "API not yet responding (auth may still be establishing)"

MEM=$(ssh_pi "sudo systemctl show ${DEPLOY_SERVICE_NAME} --property=MemoryCurrent --value" | awk '{printf "%.1f MB", $1/1048576}')
ok "Memory: $MEM (limit 256 MB)"

HOSTNAME_ONLY="${DEPLOY_HOST#*@}"
echo ""
echo "╭─────────────────────────────────────────────╮"
echo "│ ✓ Deployed                                   │"
echo "├─────────────────────────────────────────────┤"
printf "│ Dashboard:  http://%s:%s\n" "$HOSTNAME_ONLY" "$DEPLOY_PORT"
printf "│ Logs:       ssh %s 'sudo journalctl -u %s -f'\n" "$DEPLOY_HOST" "$DEPLOY_SERVICE_NAME"
printf "│ Status:     ssh %s 'sudo systemctl status %s'\n" "$DEPLOY_HOST" "$DEPLOY_SERVICE_NAME"
printf "│ Stop:       ssh %s 'sudo systemctl stop %s'\n" "$DEPLOY_HOST" "$DEPLOY_SERVICE_NAME"
echo "│ Uninstall:  ./deploy/uninstall.sh           │"
echo "╰─────────────────────────────────────────────╯"
