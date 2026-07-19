#!/usr/bin/env bash
# Start the whole stack and provision the agent team.
# Order: Paperclip (brain) -> wait for API -> Claw3D (office) -> provision team
#        -> bridge (Paperclip -> office). Logs in ./logs, PIDs in ./run.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENDOR="$ROOT/vendor"
LOGS="$ROOT/logs"; RUN="$ROOT/run"
mkdir -p "$LOGS" "$RUN"
cd "$ROOT"
[ -f "$ROOT/.env" ] && { set -a; . "$ROOT/.env"; set +a; }

PAPERCLIP_PORT="${PAPERCLIP_PORT:-3100}"
CLAW3D_PORT="${CLAW3D_PORT:-3000}"
GATEWAY_PORT="${GATEWAY_PORT:-18789}"
PAPERCLIP_API="http://127.0.0.1:$PAPERCLIP_PORT/api"

say() { printf "\n\033[1;36m==> %s\033[0m\n" "$*"; }
start_bg() { # name cmd... (cwd via subshell)
  local name="$1"; shift
  if [ -f "$RUN/$name.pid" ] && kill -0 "$(cat "$RUN/$name.pid")" 2>/dev/null; then
    echo "$name already running (pid $(cat "$RUN/$name.pid"))"; return
  fi
  nohup "$@" >"$LOGS/$name.log" 2>&1 &
  echo $! > "$RUN/$name.pid"
  echo "$name started (pid $!) -> logs/$name.log"
}

[ -d "$VENDOR/paperclip" ] || { echo "Run ./scripts/setup.sh first."; exit 1; }

say "Starting Paperclip (brain, :$PAPERCLIP_PORT)"
( cd "$VENDOR/paperclip" && start_bg paperclip pnpm dev )

say "Starting Claw3D (3D office, :$CLAW3D_PORT)"
( cd "$VENDOR/claw3d" && start_bg claw3d node server/index.js --dev )

say "Waiting for Paperclip API…"
for i in $(seq 1 90); do
  code="$(curl -s -o /dev/null -w '%{http_code}' "$PAPERCLIP_API/health" --max-time 3 2>/dev/null || true)"
  [ "$code" = "200" ] && { echo "Paperclip is up."; break; }
  sleep 2
  [ "$i" = "90" ] && { echo "Paperclip did not come up — see logs/paperclip.log"; exit 1; }
done

say "Provisioning the IT-firm team"
PAPERCLIP_API="$PAPERCLIP_API" COMPANY="${COMPANY:-}" node "$ROOT/scripts/provision.mjs"

say "Starting the Paperclip↔Claw3D bridge (:$GATEWAY_PORT)"
PAPERCLIP_API="$PAPERCLIP_API" COMPANY="${COMPANY:-}" DEMO_ADAPTER_PORT="$GATEWAY_PORT" \
  start_bg bridge node "$VENDOR/claw3d/server/paperclip-gateway-adapter.js"

if [ "${AUTOSCALE:-0}" = "1" ]; then
  say "Starting the autoscaler (dynamic worker pool)"
  PAPERCLIP_API="$PAPERCLIP_API" COMPANY="${COMPANY:-}" \
    AUTOSCALE_MIN="${AUTOSCALE_MIN:-0}" AUTOSCALE_MAX="${AUTOSCALE_MAX:-5}" \
    AUTOSCALE_PER_AGENT="${AUTOSCALE_PER_AGENT:-3}" AUTOSCALE_INTERVAL_MS="${AUTOSCALE_INTERVAL_MS:-20000}" \
    start_bg autoscaler node "$ROOT/scripts/autoscaler.mjs"
fi

cat <<EOF

\033[1;32mAll systems go.\033[0m
  Office (3D)   : http://localhost:$CLAW3D_PORT
  Dashboard     : http://localhost:$PAPERCLIP_PORT
  Gateway (WS)  : ws://localhost:$GATEWAY_PORT

Open the office, click Connect (OpenClaw backend, URL is pre-filled), and your
team appears. Chat any agent to file a real task; agents loop via heartbeats.
Stop everything with ./scripts/stop.sh
EOF
