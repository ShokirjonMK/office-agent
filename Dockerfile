# office-agent — self-contained image with Paperclip + Claw3D + bridge + team.
#
# Build:  docker build -t office-agent .
# Run:    see docker-compose.yml (recommended) or:
#   docker run -p 3000:8000 -p 3100:8100 \
#     -v office_data:/home/node/.paperclip \
#     -v $HOME/.claude:/home/node/.claude:ro \
#     office-agent
#
# Services bind container-loopback (Paperclip's trusted mode REQUIRES loopback);
# socat re-exposes them on 0.0.0.0:8000/8100 so Docker port publishing works.
#
# The build clones + installs Paperclip and Claw3D and compiles native modules,
# so the image is large (~7 GB) but boots into a ready stack.
#
# NOTE: runs as the non-root `node` user — embedded Postgres refuses to run as root.
FROM node:22-bookworm

# Native build deps for cpu-features / ssh2 / sqlite3 / embedded-postgres.
RUN apt-get update && apt-get install -y --no-install-recommends \
    git python3 make g++ ca-certificates curl bash socat \
    && rm -rf /var/lib/apt/lists/*

# Global pnpm (world-readable) so the non-root runtime user can use it too.
RUN npm install -g pnpm@9.15.4

WORKDIR /app
COPY . /app

# Clone + install upstream + wire the bridge (setup.sh is idempotent; the
# Windows patch is a no-op on Linux).
RUN chmod +x scripts/*.sh docker/*.sh && ./scripts/setup.sh

# Hand everything to the unprivileged `node` user (uid 1000, provided by the base
# image) and run as it — Postgres won't run as root.
ENV HOME=/home/node
RUN mkdir -p /home/node/.paperclip && chown -R node:node /app /home/node
USER node

# socat proxy ports (0.0.0.0) — Claw3D=8000, Paperclip=8100. Bridge (18789)
# stays container-internal (Claw3D reaches it over loopback).
EXPOSE 8000 8100

# Paperclip stores its embedded Postgres under $HOME/.paperclip — persist via volume.
VOLUME ["/home/node/.paperclip"]

ENTRYPOINT ["/app/docker/entrypoint.sh"]
