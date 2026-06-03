# Endo Gateway container image.
#
# Multi-stage build:
#   - `builder` stage: full Node + yarn toolchain. Installs workspace
#     dependencies and prunes to the gateway's production tree.
#   - `runtime` stage: slim Node base. Carries only the gateway's
#     payload and the production node_modules.
#
# The container is its own service manager (per the design's
# "Cross-platform service shape" in designs/gateway-package.md
# § Feature 10). The container runtime's restart policy
# (`--restart unless-stopped` on Docker, the equivalent on Podman or
# Kubernetes) takes the place of systemd's Restart=on-failure.
#
# Run as the unprivileged endo:endo user (uid 1001, gid 1001).
# Bind 3469 inside the container; the operator publishes whatever
# external port they want.

# ----------------------------------------------------------------------
# Stage 1: build
# ----------------------------------------------------------------------
FROM node:22-bookworm-slim AS builder

# Build dependencies. corepack is bundled with node:22; we still want
# git for any vendored fetch and ca-certificates for HTTPS.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build

# Copy the workspace's package manifests first so the install layer
# caches well across source-only changes.
COPY package.json yarn.lock .yarnrc.yml ./
COPY .yarn/ ./.yarn/
COPY packages/ ./packages/

# corepack enables yarn 4 per the workspace's packageManager pin.
RUN corepack enable && corepack prepare yarn@4.13.0 --activate

# Install with the lockfile honored. The workspace's policy is to
# never let install drift the lockfile.
RUN yarn install --immutable

# Build the gateway's dependent packages. The gateway's own `build`
# script is `exit 0` (pure JS); the dependent packages may run tsc.
RUN yarn workspaces foreach --all --topological run build || true

# ----------------------------------------------------------------------
# Stage 2: runtime
# ----------------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime

LABEL org.opencontainers.image.title="Endo Gateway"
LABEL org.opencontainers.image.description="HTTP/WebSocket + virtual hosting + OCapN bridge for the Endo daemon."
LABEL org.opencontainers.image.source="https://github.com/endojs/endo"
LABEL org.opencontainers.image.licenses="Apache-2.0"

# Create the endo:endo service account.
RUN groupadd --system --gid 1001 endo \
    && useradd --system \
        --uid 1001 --gid endo \
        --home-dir /var/lib/endo-gateway \
        --shell /usr/sbin/nologin \
        --comment "Endo Gateway service account" \
        endo

# Managed directories. The container runtime does not have systemd's
# RuntimeDirectory / StateDirectory directives, so we create the
# paths here and the operator mounts volumes over them at run time.
RUN install -d -o endo -g endo -m 0750 /var/lib/endo-gateway \
    && install -d -o endo -g endo -m 0750 /run/endo-gateway \
    && install -d -o endo -g endo -m 0750 /var/log/endo-gateway \
    && install -d -o endo -g endo -m 0750 /var/cache/endo-gateway \
    && install -d -m 0755 /etc/endo-gateway

# Copy the workspace payload from the builder. We carry the full
# monorepo because the gateway's exports reference sibling packages
# via workspace:^ specifiers; a hoisted node_modules at the workspace
# root resolves them.
COPY --from=builder --chown=endo:endo /build /opt/endo

# Default environment matches the system-service deployment paths so
# the container behaves the same way a packaged install would.
ENV ENDO_HTTP_ADDR=0.0.0.0:3469
ENV ENDO_GATEWAY_RUNTIME_DIR=/run/endo-gateway
ENV ENDO_GATEWAY_STATE_DIR=/var/lib/endo-gateway
ENV ENDO_GATEWAY_CACHE_DIR=/var/cache/endo-gateway
ENV ENDO_GATEWAY_LOG_DIR=/var/log/endo-gateway
ENV ENDO_GATEWAY_CONFIG_FILE=/etc/endo-gateway/config.toml

# The HTTP / WebSocket port.
EXPOSE 3469

# Volume mounts let the operator persist state across container
# restarts.
VOLUME ["/var/lib/endo-gateway"]
VOLUME ["/var/log/endo-gateway"]
VOLUME ["/run/endo-gateway"]

USER endo
WORKDIR /var/lib/endo-gateway

# Container is PID 1. `endo gateway run` is the foreground form (no
# detach, no pid file); the container runtime supervises restarts.
# The --system flag is implicit when geteuid() != 0 inside a container
# without INVOCATION_ID, but we pass it for clarity.
ENTRYPOINT ["node", "/opt/endo/packages/cli/src/endo.js", "gateway", "run", "--system"]
