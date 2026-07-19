#!/usr/bin/env bash
# One-command setup for the office-agent stack.
# Clones + installs Paperclip and Claw3D, wires in the bridge, and (on Windows)
# applies the local-agent spawn patch. Idempotent — safe to re-run.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENDOR="$ROOT/vendor"
cd "$ROOT"
[ -f "$ROOT/.env" ] && { set -a; . "$ROOT/.env"; set +a; }

# Pinned, known-good commits (override with env to track upstream).
PAPERCLIP_REPO="${PAPERCLIP_REPO:-https://github.com/paperclipai/paperclip.git}"
PAPERCLIP_REF="${PAPERCLIP_REF:-f12bb27bcd1b36148090d6922a85bf1611d327e0}"
CLAW3D_REPO="${CLAW3D_REPO:-https://github.com/iamlukethedev/claw3d.git}"
CLAW3D_REF="${CLAW3D_REF:-70ba84c1b13322eb660a6f7f5c53e36e7067c412}"
PNPM_VERSION="${PNPM_VERSION:-9.15.4}"
GATEWAY_PORT="${GATEWAY_PORT:-18789}"

say() { printf "\n\033[1;36m==> %s\033[0m\n" "$*"; }

say "Checking Node.js"
command -v node >/dev/null || { echo "Node.js 20+ is required."; exit 1; }
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || { echo "Node.js >= 20 required (found $(node -v))."; exit 1; }
echo "Node $(node -v) OK"

say "Ensuring pnpm@$PNPM_VERSION"
if ! command -v pnpm >/dev/null || [ "$(pnpm -v 2>/dev/null)" != "$PNPM_VERSION" ]; then
  if command -v corepack >/dev/null; then
    corepack enable || true
    corepack prepare "pnpm@$PNPM_VERSION" --activate
  else
    npm install -g "pnpm@$PNPM_VERSION"
  fi
fi
echo "pnpm $(pnpm -v)"

mkdir -p "$VENDOR"

clone_at() { # repo ref dir
  local repo="$1" ref="$2" dir="$3"
  if [ -d "$dir/.git" ]; then
    echo "exists: $dir (fetching $ref)"
    git -C "$dir" fetch --depth 1 origin "$ref" 2>/dev/null || git -C "$dir" fetch origin
    git -C "$dir" checkout -q "$ref"
  else
    git clone "$repo" "$dir"
    git -C "$dir" checkout -q "$ref"
  fi
}

say "Fetching Paperclip @ ${PAPERCLIP_REF:0:8}"
clone_at "$PAPERCLIP_REPO" "$PAPERCLIP_REF" "$VENDOR/paperclip"

say "Fetching Claw3D @ ${CLAW3D_REF:0:8}"
clone_at "$CLAW3D_REPO" "$CLAW3D_REF" "$VENDOR/claw3d"

say "Installing the Paperclip↔Claw3D bridge"
cp "$ROOT/bridge/paperclip-gateway-adapter.js" "$VENDOR/claw3d/server/paperclip-gateway-adapter.js"

say "Writing Claw3D .env (gateway -> bridge on :$GATEWAY_PORT)"
cat > "$VENDOR/claw3d/.env" <<EOF
NEXT_PUBLIC_GATEWAY_URL=ws://localhost:$GATEWAY_PORT
CLAW3D_GATEWAY_URL=ws://localhost:$GATEWAY_PORT
CLAW3D_GATEWAY_ADAPTER_TYPE=openclaw
PORT=3000
HOST=127.0.0.1
DEMO_ADAPTER_PORT=$GATEWAY_PORT
EOF

say "Applying Windows agent-spawn patch (no-op on Linux/macOS)"
node "$ROOT/scripts/apply-windows-patch.mjs" "$VENDOR/paperclip" || true

say "Installing Paperclip dependencies (this can take a few minutes)"
( cd "$VENDOR/paperclip" && pnpm install )

say "Installing Claw3D dependencies"
( cd "$VENDOR/claw3d" && npm install )

say "Setup complete."
echo "Next:  ./scripts/start.sh    (starts everything + provisions the team)"
