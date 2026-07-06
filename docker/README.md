# Self-hosting the Endo daemon with Docker

Run an Endo daemon as an always-on server — the setup where you rent a VPS,
deploy a container, and control your daemon remotely over an authenticated,
TLS-terminated connection.

This directory holds:

| File | Purpose |
|---|---|
| `Dockerfile` | Two-stage image: builds the Familiar bundles, then ships a slim runtime that runs the daemon in the foreground. |
| `docker-entrypoint.sh` | Derives the daemon's state/socket paths from the XDG environment and execs the daemon as PID 1. |
| `endo-cli-wrapper.sh` | Installed as `endo` so `docker exec <container> endo <verb>` reaches the bundled CLI. |
| `docker-compose.yml` | Example deployment with a Caddy TLS reverse proxy. |
| `Caddyfile` | Example Caddy config that terminates TLS and forwards to the daemon. |

## Build

Build from the repository root so the whole workspace is in the build context:

```sh
docker build -f docker/Dockerfile -t endojs/daemon:latest .
```

## Run

```sh
docker run -d \
  --name endo \
  -v endo-state:/data \
  -p 8920:8920 \
  endojs/daemon:latest
```

Or with Compose (includes a Caddy TLS proxy):

```sh
cd docker && docker compose up -d
```

## State persistence

The daemon keeps its formula store, agent keys, and message logs under `/data`,
exposed as a volume. A named volume (`endo-state`) survives `docker rm`/recreate;
a bind mount (`-v /srv/endo:/data`) gives you direct filesystem access for
backup. The daemon self-initializes an empty `/data` on first launch.

Layout under `/data` (resolved by `@endo/where` from the image's XDG variables):

- `state/endo/` — formula store (`endo.sqlite`), the root agent, pet names,
  message logs, per-worker logs, and the `root` / `gateway` marker files.
- `cache/endo/` — content-addressed cache.

## Network exposure

The daemon binds the gateway to `0.0.0.0:8920` inside the container
(`ENDO_ADDR`). Map the port to your host, or place a reverse proxy in front.

**TLS is terminated externally.** The daemon speaks plain HTTP/WebSocket; put a
reverse proxy (Caddy, nginx, Traefik, or a cloud load balancer) in front for
HTTPS. Bearer tokens travel over the WebSocket, so remote access without TLS
exposes them to network observers — the gateway logs a warning at startup when
remote mode is active.

## Remote authentication

By default the gateway admits only localhost connections. The image sets
`ENDO_GATEWAY=remote`, which admits authenticated connections from any client
IP — deploying this container is itself the opt-in to remote access. Two knobs
control it (see `packages/daemon/README.md` § Remote access):

- `ENDO_GATEWAY=remote` — admit any reachable client IP. Authentication is the
  CapTP bearer token (the agent's 256-bit formula identifier).
- `ENDO_GATEWAY_ALLOWED_CIDRS=10.0.0.0/8,100.64.0.0/10` — admit localhost plus
  the listed ranges only (for VPN/LAN deployments). Unset `ENDO_GATEWAY` (or set
  it to `local`) to combine this with a localhost-only default.

Find your root agent's identifier — the bearer token — after first launch:

```sh
docker exec endo cat /data/state/endo/root
```

Then open `https://my-daemon.example.com/#agent=<id>` in a browser. The URL
fragment is never sent to the server; the Chat client reads it from
`window.location.hash` and authenticates over the gateway WebSocket. Treat the
URL as a secret — knowing the identifier grants full control of that agent.

## Using the CLI

```sh
docker exec endo endo list        # inventory
docker exec endo endo --help
```

The CLI resolves the same socket and state directory the daemon uses, so it
attaches to the running daemon inside the container.

## Known limitations

- **Chat UI static hosting is not included.** The gateway serves the CapTP
  WebSocket, not the Chat UI static assets; host the Chat build separately (any
  static host) and point it at `wss://my-daemon.example.com/`. Serving the Chat
  bundle from the gateway is tracked as follow-on work.
- **Trusted-shim workers** (`worker-node-with-shims`) are not bundled into the
  image; a guest program that requests trusted shims will not spawn. The base
  daemon and ordinary workers are unaffected.
- **Bundled agents** (Lal/Fae) are not included in this image.
