# office-agent — self-contained image with Paperclip + Claw3D + bridge + team.
#
# Build:  docker build -t office-agent .
# Run:    see docker-compose.yml (recommended) or:
#   docker run -p 3000:3000 -p 3100:3100 \
#     -v office_data:/root/.paperclip \
#     -v $HOME/.claude:/root/.claude:ro \
#     office-agent
#
# The build clones + installs Paperclip and Claw3D and compiles native modules,
# so the image is large (~2-3 GB) but boots into a ready stack.
FROM node:22-bookworm

# Native build deps for cpu-features / ssh2 / sqlite3 / embedded-postgres.
RUN apt-get update && apt-get install -y --no-install-recommends \
    git python3 make g++ ca-certificates curl bash \
    && rm -rf /var/lib/apt/lists/*

ENV PNPM_VERSION=9.15.4
RUN corepack enable && corepack prepare "pnpm@${PNPM_VERSION}" --activate

WORKDIR /app
COPY . /app

# Clone + install upstream + wire the bridge (setup.sh is idempotent & non-Windows here).
RUN chmod +x scripts/*.sh docker/*.sh && ./scripts/setup.sh

EXPOSE 3000 3100 18789

# Paperclip stores its embedded Postgres under $HOME/.paperclip — persist via volume.
VOLUME ["/root/.paperclip"]

ENTRYPOINT ["/app/docker/entrypoint.sh"]
