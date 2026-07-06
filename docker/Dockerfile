# syntax=docker/dockerfile:1

# Endo daemon self-hosting image.
#
# Builds the daemon, its worker, and the CLI from the monorepo source and runs
# the daemon in the foreground with its state persisted to a mounted volume.
# This is the headless counterpart to the desktop shell: a container you can
# deploy on a VPS so the daemon is available 24/7.
#
# Scope note: the daemon starts no network service by default; the only
# always-on control surface is a UNIX domain socket. Authenticated remote
# (non-localhost) HTTP/WebSocket access described in the daemon-docker-selfhost
# design depends on the gateway-bearer-token-auth design, which is not yet
# implemented in this repository. See README.md for the current remote-access
# story and the deliberate omission.

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
    ENDO_SOCK=/run/endo/captp0.sock

# The daemon handles SIGINT for graceful shutdown; map `docker stop` onto it.
STOPSIGNAL SIGINT

COPY docker/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENTRYPOINT ["docker-entrypoint.sh"]
