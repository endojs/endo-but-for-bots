# Self-hosting the Endo daemon with Docker

This directory packages the Endo daemon, its bundled worker, and the CLI into a
container image so the daemon can run headless and always-on, the way you would
deploy it on a rented server rather than a desktop.

## What this image is

The image builds the monorepo and runs `packages/daemon/src/daemon-node.js` in
the foreground. The daemon's state (the formula store, agent keypairs, and
cache) lives under a mounted volume so it survives container restarts and
recreation.

The CLI is present in the same image. Because the control socket path is passed
through `ENDO_SOCK`, a CLI invocation inside the container reaches the running
daemon:

```sh
docker compose exec endo endo <command>
```

## Build and run

With Compose:

```sh
cd docker
docker compose up -d
docker compose exec endo endo who   # example: talk to the daemon
```

Or by hand:

```sh
# Build from the repository root (the build context is the whole workspace).
docker build -f docker/Dockerfile -t endojs/daemon:latest .

# Run with a named volume for persistent state.
docker run -d --name endo -v endo-state:/data/endo endojs/daemon:latest

# Drive the daemon.
docker exec endo endo <command>
```

## State persistence

The daemon writes to three trees, rooted under `ENDO_STATE` (default
`/data/endo`, declared as a volume):

| Path                | Contents                                            |
| ------------------- | --------------------------------------------------- |
| `/data/endo/state`  | formula store: formula graphs, pet names, mail logs |
| `/data/endo/cache`  | content-addressed cache                             |

The control socket and pid file live under `ENDO_RUNTIME` (default `/run/endo`),
which is ephemeral and recreated on each start.

Mount either a named volume (survives container recreation) or a host bind mount
(gives you direct filesystem access for backup) at `/data/endo`.

Environment overrides, honored by both the entrypoint and the CLI:

| Variable      | Default                    | Purpose                          |
| ------------- | -------------------------- | -------------------------------- |
| `ENDO_STATE`  | `/data/endo`               | persisted state root             |
| `ENDO_RUNTIME`| `/run/endo`                | ephemeral runtime dir            |
| `ENDO_SOCK`   | `/run/endo/captp0.sock`    | control socket (CLI reads it too)|

## Remote access

The `daemon-docker-selfhost` design calls for authenticated remote
(non-localhost) access so a self-hosted daemon can be controlled from a
different machine, over HTTP/WebSocket, gated by a bearer token, with TLS
terminated by a reverse proxy.

**That path is not yet available.** It depends on the `gateway-bearer-token-auth`
design, which is not implemented in this repository: there is no HTTP/WebSocket
gateway, no `GatewayBootstrap.fetch(token)` authentication gate, and no
`ENDO_GATEWAY=remote` mode in the daemon today. The daemon accepts control over
a UNIX domain socket only.

This image therefore ships **local control only** and deliberately does **not**
publish a network port. Reaching the control socket is equivalent to full
control of the daemon, so it must not be exposed to a network interface without
the authentication layer in front of it. Bridging the raw socket to TCP (for
example with `socat`) would hand unauthenticated remote control to anyone who
can reach the port; do not do this.

When `gateway-bearer-token-auth` lands, this image gains a published gateway
port, an `ENDO_GATEWAY=remote` toggle, and a documented reverse-proxy + TLS
recipe. Until then, remote operators can reach the daemon through an
already-authenticated channel such as an SSH tunnel to the container host, or by
running the CLI inside the container with `docker exec`.

## Known follow-ups

- **Authenticated remote gateway.** Blocked on `gateway-bearer-token-auth`
  (HTTP/WebSocket gateway, bearer-token auth, `ENDO_GATEWAY=remote`, per-IP rate
  limiting). This unblocks the published port, the reverse-proxy TLS recipe, and
  serving the Chat UI from the container.
- **Slim runtime image.** The current image carries the full workspace install
  tree. A bundle-based image (a single daemon bundle plus the worker) awaits a
  daemon bundle pipeline.
- **SIGTERM handling.** The daemon handles `SIGINT`; the Dockerfile maps
  `docker stop` onto `SIGINT` via `STOPSIGNAL`. Teaching the daemon to also
  cancel on `SIGTERM` would let it shut down gracefully under orchestrators that
  send `SIGTERM` unconditionally.
