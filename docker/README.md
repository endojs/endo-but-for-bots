# Self-hosting the Endo daemon with Docker

This directory packages the Endo daemon, its worker, and the CLI into a
container image so the daemon can run headless and always-on, the way you would
deploy it on a rented server rather than a desktop.

## What this image is

The image builds the monorepo and runs `packages/daemon/src/daemon-node.js` in
the foreground. The daemon's state (the formula store, agent keypairs, and
cache) lives under a mounted volume so it survives container restarts and
recreation.

The daemon exposes two control surfaces:

- A **UNIX domain socket** for local CLI control. Because the socket path is
  passed through `ENDO_SOCK`, a CLI invocation inside the container reaches the
  running daemon:

  ```sh
  docker compose exec endo endo <command>
  ```

  This socket grants full unauthenticated control and must stay inside the
  container. Never bridge it to a network interface or bind-mount it to a host
  path an untrusted user can read.

- A **WebSocket gateway** (the same one the Chat app uses) bound to `ENDO_ADDR`.
  This is the authenticated, network-facing surface, described under
  [Remote access](#remote-access) below.

## Build and run

With Compose:

```sh
cd docker
docker compose up -d
docker compose exec endo endo list   # example: talk to the daemon
```

Or by hand:

```sh
# Build from the repository root (the build context is the whole workspace).
docker build -f docker/Dockerfile -t endojs/daemon:latest .

# Run with a named volume for persistent state. --init reaps the worker
# subprocesses the daemon forks (Compose sets this via `init: true`).
# ENDO_GATEWAY_REMOTE=true admits every remote address (the bearer token is
# still required). For a real deployment, prefer ENDO_GATEWAY_ALLOWED_CIDRS
# scoped to your management network behind a TLS proxy; see "Remote access".
docker run -d --init --name endo \
  -v endo-state:/data/endo \
  -p 8920:8920 \
  -e ENDO_GATEWAY_REMOTE=true \
  endojs/daemon:latest

# Drive the daemon locally over its control socket.
docker exec endo endo <command>
```

## State persistence

The daemon writes two persistent trees, rooted under `ENDO_STATE` (default
`/data/endo`, declared as a volume):

| Path                | Contents                                            |
| ------------------- | --------------------------------------------------- |
| `/data/endo/state`  | formula store: formula graphs, pet names, mail logs |
| `/data/endo/cache`  | content-addressed cache                             |

The control socket and pid file live under `ENDO_RUNTIME` (default `/run/endo`),
which is ephemeral and recreated on each start.

Mount either a named volume (survives container recreation) or a host bind mount
(gives you direct filesystem access for backup) at `/data/endo`.

## Environment

| Variable                     | Default (this image) | Purpose                                             |
| ---------------------------- | -------------------- | --------------------------------------------------- |
| `ENDO_STATE`                 | `/data/endo`         | persisted state root                                |
| `ENDO_RUNTIME`               | `/run/endo`          | ephemeral runtime dir                               |
| `ENDO_SOCK`                  | `/run/endo/captp0.sock` | control socket (CLI reads it too)                |
| `ENDO_ADDR`                  | `0.0.0.0:8920`       | WebSocket gateway bind `host:port`                  |
| `ENDO_GATEWAY_REMOTE`        | unset (localhost only) | when `true`/`1`, the gateway admits any remote address (bearer-token auth still applies) |
| `ENDO_GATEWAY_ALLOWED_CIDRS` | unset                | comma-separated CIDR allowlist; localhost is always admitted |

The defaults above are what this image sets, not the daemon's own defaults. In
particular the image binds `ENDO_ADDR=0.0.0.0:8920` (via the Dockerfile) to
publish the port; the daemon on its own defaults to `127.0.0.1:8920`. Binding to
`0.0.0.0` only publishes the port; it does not admit remote callers. The address
gate still rejects them until you set `ENDO_GATEWAY_REMOTE` or
`ENDO_GATEWAY_ALLOWED_CIDRS`.

`ENDO_STATE`, `ENDO_RUNTIME`, and `ENDO_SOCK` are honored by both the entrypoint
and the CLI. `ENDO_ADDR`, `ENDO_GATEWAY_REMOTE`, and `ENDO_GATEWAY_ALLOWED_CIDRS`
are read by the daemon when it starts the gateway.

## Remote access

The gateway is a WebSocket endpoint that browser clients (the Chat app) and
other CapTP clients use to reach the daemon. It has two independent gates:

1. **Address gate.** The gateway admits only localhost by default, even when
   bound to `0.0.0.0`. Set `ENDO_GATEWAY_REMOTE=true` to admit any remote
   address, or `ENDO_GATEWAY_ALLOWED_CIDRS=<cidr,cidr>` to admit only listed
   networks (localhost is always admitted). This is why a freshly published port
   with no opt-in rejects callers: traffic forwarded from the host arrives from
   the Docker bridge network, not `127.0.0.1`.
2. **Bearer-token authentication.** After the WebSocket and CapTP handshake, a
   client calls `fetch(<token>)` where the token is the formula identifier of
   the agent it wants to control (a 256-bit capability, for example the value
   the daemon writes to `/data/endo/state/root`). The gateway resolves the token to
   that agent's capability; a caller without a valid token gets nothing. Failed
   attempts are rate-limited per source address.

### TLS

The gateway speaks plain HTTP/WebSocket inside the container. Terminate TLS at a
reverse proxy in front (nginx, Caddy, Traefik, or a cloud load balancer), which
also handles certificate renewal. The Compose file carries a commented `caddy`
service as a starting point:

```
my-daemon.example.com {
  reverse_proxy endo:8920
}
```

A browser then reaches the Chat app over `wss://my-daemon.example.com/` and
supplies the agent token to authenticate.

### Recommended posture

- Publish the port only behind a TLS-terminating reverse proxy.
- Prefer `ENDO_GATEWAY_ALLOWED_CIDRS` scoped to your management network over the
  blanket `ENDO_GATEWAY_REMOTE=true` when the set of callers is known.
- Understand what the address gate sees behind a proxy. It keys on the immediate
  TCP peer address, not a forwarded client address (it deliberately does not
  trust `X-Forwarded-For`, which a client can spoof). When a reverse proxy
  terminates the connection, every request reaches the gateway from the proxy's
  own address, so the address gate can only distinguish the proxy, not the end
  clients behind it: allowlisting the proxy admits everything the proxy forwards,
  and the bearer token becomes the sole per-client gate at that point. Scope the
  CIDR allowlist to callers that connect to the gateway directly.
- Keep the UNIX domain socket inside the container. It is unauthenticated and
  equivalent to root over the daemon.

## Known follow-ups

- **Chat UI hosting from the container.** The gateway authenticates and relays
  CapTP but does not yet serve the Chat static bundle over HTTP; hosting the
  Chat app from the same origin is a follow-up (it awaits the gateway-package
  static-hosting work).
- **Slim runtime image.** The current image carries the full workspace install
  tree. A bundle-based image (a single daemon bundle plus the worker) awaits a
  daemon bundle pipeline.
