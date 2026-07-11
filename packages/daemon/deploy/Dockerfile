# Reproducible image for the full Endo Pet Daemon serving OCapN-Noise over
# WebSocket (the `@nets/ocapn` transport, WS variant).
#
# Build context is the REPOSITORY ROOT (the yarn workspace root), because the
# daemon package is one workspace among many and `yarn install` needs the whole
# monorepo:
#
#   docker build -f packages/daemon/deploy/Dockerfile -t endo-pet-daemon:ocapn-ws .
#
# Base: node:22-bookworm (glibc, not Alpine) — `better-sqlite3` and
# `@ipshipyard/node-datachannel` (a libp2p transitive native dep) are the only
# `built: true` packages; they ship arm64/glibc prebuilds, and the toolchain
# below is the compile fallback. The Noise crypto ships as prebuilt WASM in-tree
# (`packages/ocapn-noise/gen/`), so there is NO Rust build.
FROM node:22-bookworm

# Native-dependency build toolchain (the whole point of containerizing: the
# host stays clean while these live only inside the image). `python3` +
# `build-essential` cover node-gyp for `better-sqlite3`; `cmake` + `pkg-config`
# cover `@ipshipyard/node-datachannel` if its prebuild is unavailable.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       build-essential python3 cmake pkg-config ca-certificates git \
  && rm -rf /var/lib/apt/lists/*

# Yarn 4 (pinned by the repo's `packageManager` field) via corepack.
RUN corepack enable

WORKDIR /app

# Copy the whole workspace and install. Copying the full tree (rather than just
# manifests first) keeps the image build a single reproducible step off a clean
# shallow clone; the deploy script provides a context with no node_modules.
COPY . .

# `enableScripts: false` globally; only the `built: true` packages
# (better-sqlite3, node-datachannel) compile. `--immutable` asserts the
# committed yarn.lock is authoritative, so the install is reproducible.
RUN corepack yarn install --immutable

# Daemon data (state, cache, run dir, control socket, and the written OCapN
# location) live here. Mount a volume to persist the daemon's identity across
# container restarts; unmounted, each boot is a fresh ephemeral daemon.
ENV ENDO_DATA_DIR=/data \
    OCAPN_WS_LISTEN=0.0.0.0:8930 \
    OCAPN_LOCATION_OUT=/data/ocapn-daemon-location.json \
    ENDO_ADDR=127.0.0.1:8920
RUN mkdir -p /data
VOLUME ["/data"]

# The daemon's OCapN-Noise WebSocket listener.
EXPOSE 8930

WORKDIR /app/packages/daemon
ENTRYPOINT ["node", "deploy/daemon-ocapn-ws-boot.mjs"]
