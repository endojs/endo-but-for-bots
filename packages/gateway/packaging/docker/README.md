# Docker packaging for endo-gateway

This directory holds the `Dockerfile` for the Endo Gateway.
The container is the gateway's PID 1; the container runtime takes
the place of systemd's service manager.

## Layout

```
packages/gateway/packaging/docker/
  Dockerfile        Multi-stage build (builder + runtime).
  .dockerignore     Excludes node_modules, build artifacts, etc.
  README.md         This file.
```

## Build

The `Dockerfile` expects the **monorepo root** as the build
context because the gateway's workspace dependencies are siblings
under `packages/`.
Build from the monorepo root:

```sh
docker build \
    -f packages/gateway/packaging/docker/Dockerfile \
    -t endo-gateway:0.1.0 \
    .
```

## Run

```sh
docker run -d \
    --name endo-gateway \
    --restart unless-stopped \
    -p 3469:3469 \
    -v endo-gateway-state:/var/lib/endo-gateway \
    -v endo-gateway-log:/var/log/endo-gateway \
    endo-gateway:0.1.0
```

For a host-network deployment (lets the gateway see the original
client IP without an X-Forwarded-* parser path):

```sh
docker run -d \
    --name endo-gateway \
    --restart unless-stopped \
    --network host \
    -v endo-gateway-state:/var/lib/endo-gateway \
    endo-gateway:0.1.0
```

## Service mode

The container's process detects system mode without
`INVOCATION_ID` because the entrypoint passes `--system`
explicitly.
The container runtime's `--restart` policy replaces systemd's
`Restart=on-failure`.

## Volumes

- `/var/lib/endo-gateway`: durable state (the CapTP graph).
  **Must** be a volume; losing it loses the gateway's persistent
  identifiers.
- `/var/log/endo-gateway`: log file.
  Optional volume; `docker logs` also captures stdout/stderr.
- `/run/endo-gateway`: UDS bootstrap and admin sockets.
  Mount as a shared volume only if a sidecar container needs the
  bootstrap sock (the design's Feature 4); otherwise leave
  un-mounted.
- `/etc/endo-gateway`: config directory.
  Mount read-only when shipping `config.toml` from the host.

## Multi-stage rationale

The `builder` stage carries the full workspace toolchain
(yarn 4 + corepack + git) and the dependent packages' build
outputs.
The `runtime` stage carries only the resulting payload, dropping
the build-time dependencies.
The two stages share a base image (`node:22-bookworm-slim`) so
the kernel ABI and glibc surface match.

## Cross-references

- The systemd unit body lives at
  `packages/gateway/systemd/endo-gateway.service`; the container's
  environment variables mirror the unit's `Environment=` lines so
  a deployment that moves between systemd and Docker stays
  configuration-compatible.
- The runtime documentation (path layout, security considerations,
  log tailing) lives at `packages/gateway/docs/system-service.md`.
- The cross-platform upgrade workflow lives at
  `packages/gateway/docs/packaging.md`.
