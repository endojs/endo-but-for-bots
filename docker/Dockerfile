# Endo daemon — self-hosting container image.
#
# Two stages:
#   1. `builder` installs the workspace and runs the Familiar bundle pipeline
#      (`yarn workspace @endo/familiar step:bundle`), producing self-contained
#      ESM bundles for the daemon, its worker, and the CLI. `yarn install`
#      fetches better-sqlite3's prebuilt native addon for the build platform.
#   2. the runtime stage is a slim Node image that carries only the bundles plus
#      the one native artifact the daemon loads at runtime (better-sqlite3's
#      `.node` addon), and runs the daemon in the foreground as PID 1.
#
# Build from the repository root so the whole workspace is in the build context:
#   docker build -f docker/Dockerfile -t endojs/daemon:latest .

# ---------------------------------------------------------------------------
# Stage 1 — build the bundles
# ---------------------------------------------------------------------------
FROM node:22-bookworm AS builder

WORKDIR /build

# Copy the whole workspace. `.dockerignore` keeps node_modules and .git out.
COPY . .

# Corepack pins yarn@4 (see the root package.json `packageManager` field).
RUN corepack enable && yarn install --immutable

# Produce endo-daemon.mjs, worker-node.mjs, endo-cli.mjs (and friends) in
# packages/familiar/bundles/.
RUN yarn workspace @endo/familiar step:bundle

# Stage better-sqlite3's compiled addon at a fixed path so the runtime stage can
# copy it without depending on the pnpm store layout. The bundled daemon loads
# it through `bindings("better_sqlite3.node")`, which searches build/Release
# relative to the bundle's module root — so the runtime stage drops it there.
#
# better-sqlite3 is a dependency of @endo/daemon, not of the workspace root, and
# the pnpm linker keeps each workspace's deps under that workspace — so resolve
# it from packages/daemon rather than from /build, where it is not visible.
RUN node -e "const fs=require('fs'),path=require('path');let d=path.dirname(require.resolve('better-sqlite3',{paths:['/build/packages/daemon']}));while(d!=='/'){const c=path.join(d,'build','Release','better_sqlite3.node');if(fs.existsSync(c)){fs.copyFileSync(c,'/build/better_sqlite3.node');console.log('staged addon from',c);process.exit(0)}d=path.dirname(d)}throw new Error('better_sqlite3.node not found — did yarn install fetch the prebuilt addon?')"

# ---------------------------------------------------------------------------
# Stage 2 — runtime
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime

WORKDIR /opt/endo

# The self-contained bundles: endo-daemon.mjs, worker-node.mjs, endo-cli.mjs.
COPY --from=builder /build/packages/familiar/bundles/ ./bundles/

# The daemon's one runtime-native dependency. `bindings` resolves the addon from
# the nearest ancestor of the calling bundle that contains a package.json, then
# looks under build/Release — so both markers live in the bundles directory.
COPY --from=builder /build/better_sqlite3.node ./bundles/build/Release/better_sqlite3.node
RUN printf '{\n  "name": "endo-bundles",\n  "private": true\n}\n' > ./bundles/package.json

# Entrypoint and the `endo` CLI convenience wrapper (for `docker exec`).
COPY docker/docker-entrypoint.sh ./docker-entrypoint.sh
COPY docker/endo-cli-wrapper.sh /usr/local/bin/endo
RUN chmod +x ./docker-entrypoint.sh /usr/local/bin/endo

# State layout follows @endo/where's XDG resolution so the daemon (launched by
# the entrypoint with explicit paths) and the CLI (which resolves paths from
# these same env vars) agree on the socket and state directory.
#   state   -> $XDG_STATE_HOME/endo   (persisted)
#   cache   -> $XDG_CACHE_HOME/endo   (persisted)
#   runtime -> $XDG_RUNTIME_DIR/endo  (ephemeral: pid files, unix socket)
ENV XDG_STATE_HOME=/data/state \
    XDG_CACHE_HOME=/data/cache \
    XDG_RUNTIME_DIR=/run/endo \
    ENDO_ADDR=0.0.0.0:8920 \
    ENDO_GATEWAY=remote \
    ENDO_WORKER_SUBPROCESS_PATH=/opt/endo/bundles/worker-node.mjs

# Persist the formula store, agent keys, and message logs across restarts.
VOLUME /data

# Gateway HTTP/WebSocket port.
EXPOSE 8920

ENTRYPOINT ["./docker-entrypoint.sh"]
