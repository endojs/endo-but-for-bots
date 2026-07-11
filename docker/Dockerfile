# syntax=docker/dockerfile:1

# Endo daemon self-hosting image.
#
# Builds the daemon, its worker, and the CLI from the monorepo source and runs
# the daemon in the foreground with its state persisted to a mounted volume.
# This is the headless counterpart to the desktop shell: a container you can
# deploy on a VPS so the daemon is available 24/7.
#
# Network surface: the daemon starts a WebSocket gateway (the same one the Chat
# app uses) bound to ENDO_ADDR. The gateway authenticates every client by
# bearer token and, independently, gates by remote address: it admits only
# localhost until an operator opts in with ENDO_GATEWAY_REMOTE=true or an
# ENDO_GATEWAY_ALLOWED_CIDRS allowlist. See README.md for the remote-access
# recipe (published port, reverse proxy, TLS). The daemon's other control
# surface, a UNIX domain socket, grants full unauthenticated control and must
# stay inside the container.

FROM node:22-bookworm-slim

# Corepack ships with Node and provisions the exact Yarn named in the root
# package.json "packageManager" field.
RUN corepack enable

WORKDIR /opt/endo

# Copy the whole workspace. The pnpm-style node-modules linker the repo uses
# resolves symlinks into an install tree that the runtime needs intact, so a
# slim runtime stage that copies only a subset is not straightforward; a
# bundle-based slim image is a follow-up once a daemon bundle pipeline exists.
COPY . .

# enableScripts is false in .yarnrc.yml, so no package build scripts run during
# install. The daemon and worker execute directly from source (type: module);
# there is no compile step.
RUN yarn install --immutable

# The `endo` CLI bin is linked into the workspace node_modules/.bin; put it on
# PATH so `docker exec <ctr> endo ...` (and `docker compose exec endo endo ...`)
# resolve it.
ENV PATH="/opt/endo/node_modules/.bin:${PATH}"

# State (formula store, keypairs, cache) persists here across restarts.
VOLUME /data/endo

ENV ENDO_STATE=/data/endo \
    ENDO_RUNTIME=/run/endo \
    ENDO_SOCK=/run/endo/captp0.sock \
    ENDO_ADDR=0.0.0.0:8920

# The WebSocket gateway listens on this port (matches ENDO_ADDR above). Publish
# it with `docker run -p` or Compose `ports:` to reach the daemon remotely.
EXPOSE 8920

# `docker stop` sends SIGTERM by default; the daemon cancels gracefully on both
# SIGTERM and SIGINT (see packages/daemon/src/daemon-node.js), so no STOPSIGNAL
# override is needed.

COPY docker/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENTRYPOINT ["docker-entrypoint.sh"]
