#!/usr/bin/env bash
# Container entrypoint: run the whole stack in the foreground so the container
# stays alive and `docker logs` shows everything. Provisions the team on boot.
set -uo pipefail

ROOT=/app
cd "$ROOT"
[ -f "$ROOT/.env" ] && { set -a; . "$ROOT/.env"; set +a; }

PAPERCLIP_PORT="${PAPERCLIP_PORT:-3100}"
CLAW3D_PORT="${CLAW3D_PORT:-3000}"
GATEWAY_PORT="${GATEWAY_PORT:-18789}"
PAPERCLIP_API="http://127.0.0.1:${PAPERCLIP_PORT}/api"
export PAPERCLIP_API COMPANY="${COMPANY:-}"

log() { printf "\n\033[1;36m[office-agent] %s\033[0m\n" "$*"; }

log "Starting Paperclip (:$PAPERCLIP_PORT)"
( cd vendor/paperclip && exec pnpm dev ) & PID_PC=$!

log "Starting Claw3D (:$CLAW3D_PORT)"
( cd vendor/claw3d && exec node server/index.js --dev ) & PID_C3=$!

log "Waiting for Paperclip API…"
for i in $(seq 1 120); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' "$PAPERCLIP_API/health" --max-time 3 2>/dev/null || true)" = "200" ] && { log "Paperclip up"; break; }
  sleep 2
done

log "Provisioning the team"
node scripts/provision.mjs || echo "[office-agent] provision failed (continuing)"

log "Starting bridge (:$GATEWAY_PORT)"
DEMO_ADAPTER_PORT="$GATEWAY_PORT" node vendor/claw3d/server/paperclip-gateway-adapter.js & PID_BR=$!

if [ "${AUTOSCALE:-0}" = "1" ]; then
  log "Starting autoscaler"
  node scripts/autoscaler.mjs & PID_AS=$!
fi

log "Ready — office http://localhost:$CLAW3D_PORT · dashboard http://localhost:$PAPERCLIP_PORT"

# Exit (and let the container restart) if any core service dies.
wait -n "$PID_PC" "$PID_C3" "$PID_BR"
log "A core service exited — shutting down."
kill "$PID_PC" "$PID_C3" "$PID_BR" ${PID_AS:-} 2>/dev/null || true
