# Full Endo Pet Daemon on minion.town — OCapN-Noise over WebSocket (Docker)

A **reproducible container image** for the **full** Endo Pet Daemon
(`@endo/daemon`) serving **OCapN over WebSocket + Noise + CBOR** via the
in-tree `@nets/ocapn` netlayer (`packages/daemon/src/networks/ocapn.js`), plus
the scripts that deploy it onto **minion.town** and a captured transcript of a
peer reaching the daemon's bootstrap over `wss://minion.town/ocapn-daemon`.

This is the graduation of the standalone
[`demo/minion-town`](../demo/minion-town/README.md) OCapN-Noise-WS *service*
(which avoided the native SQLite dep) to the **real Pet Daemon**: the pet store,
agent, gateway, and lifecycle, with `@nets/ocapn` installed exactly as
`test/_multiplayer-suite.js` installs it. The standalone demo
(`endo-ocapn-daemon.service`, `wss://minion.town/ocapn`) is left running
untouched; this adds an independent second endpoint.

## What proves what

The captured transcript
([`transcripts/minion-ocapn-daemon-bootstrap.log`](transcripts/minion-ocapn-daemon-bootstrap.log))
is a real run of `ocapn-bootstrap-client.mjs` reaching the deployed daemon's
`EndoOcapnBootstrap` at swissnum **`endo-bootstrap`** over
**`wss://minion.town/ocapn-daemon`**:

```
[peer] enlivened 'endo-bootstrap' (EndoOcapnBootstrap); invoking...
[peer] getNodeId() = 5e304bc1d35a104544a961675b8f452577b5c94070aa13a13089edf87aa4c5bc
[peer] getAgentBinding().agentPublicKey = 5e304bc1…
[peer] getGreeter() -> EndoGreeter present
RESULT {"ok":true,"swissnum":"endo-bootstrap","nodeId":"5e304bc1…","hasGreeter":true}
```

That exercises the whole path: **Caddy TLS on 443** → the container's published
loopback port → the daemon's OCapN-Noise **WS** listener → **Noise IK** mutual
auth on the location designator → **CBOR** framing → **sturdyref** →
`EndoOcapnBootstrap`, which reports the node id, returns the signed
**agent-binding** attestation, and hands back the live **`EndoGreeter`** (the
entry to the daemon-to-daemon peer protocol — `hello`, `provide`).

## The pieces

| File | Role |
| --- | --- |
| `Dockerfile` | Builds the image. `node:22-bookworm` (glibc arm64), the native toolchain (`build-essential python3 cmake pkg-config`) so `better-sqlite3` / `node-datachannel` compile if no prebuild, `corepack yarn install --immutable`. Build context is the **repo root** (the yarn workspace). |
| `.dockerignore` | Keeps the build context lean (excludes `node_modules`, `.git`, …). Copied to the context root by the deploy script (Docker only honors a root `.dockerignore`). |
| `daemon-ocapn-ws-boot.mjs` | Container entrypoint. Boots the real `@endo/daemon`, installs `src/networks/ocapn.js` as `@nets/ocapn` gated on `ws-listen-addr`, extracts the advertised `ocapn+noise+ws://…?loc=…` address, and writes its `OcapnLocation` to `/data/…-location.json`. Idempotent across restarts (see below). Holds PID 1 alive; SIGTERM stops the daemon cleanly. |
| `ocapn-bootstrap-client.mjs` | The **local peer**. Reads the location JSON, rewrites its `ws:url` hint to the public `wss://` endpoint (`WS_URL_OVERRIDE`), opens a Noise session, fetches swissnum `endo-bootstrap`, and invokes the bootstrap. Prints a machine-readable `RESULT` line. |
| `deploy.sh` | Phased, idempotent host deploy (via SSM): `install` a runtime, `fetch` the branch, `build` the image, `run` the container, `location` (wait for the advertised location), `caddy` (add the route); `all` chains them. |
| `ocapn-daemon.caddy` | The `wss://minion.town/ocapn-daemon` route as folded into `minion-town.caddy`. |

## Deployed configuration (as of 2026-07-11)

- **Image:** `endo-pet-daemon:ocapn-ws` (built from this branch's HEAD on the
  host; ~3.2 GB on disk, ~666 MB content).
- **Runtime:** Docker `29.1.3` on minion.town (EC2 `i-0380cd68b90020fad`,
  aarch64, Ubuntu 24.04, SSM-only). Docker was already present; `deploy.sh
  install` installs `docker.io` + `docker-buildx` on a clean host.
- **Container:** `endo-pet-daemon`, `--restart unless-stopped`, publishing
  `127.0.0.1:8931 -> 8930` (the daemon's in-container OCapN-Noise WS listener on
  `0.0.0.0:8930`), with a named volume `endo-daemon-data:/data` persisting the
  daemon identity, pet store, and control socket.
- **Caddy route:** `wss://minion.town/ocapn-daemon` → `reverse_proxy
  127.0.0.1:8931`, added as a `handle` block in
  `/etc/caddy/conf.d/minion-town.caddy` (ungated — OCapN-over-Noise
  self-authenticates, so the oauth2-proxy login gate does not apply).
  `caddy validate` gates every `systemctl reload caddy`; rollback restores the
  `.bak-ocapn-daemon` backup.

## Reproduce

```sh
# On the host (root, via SSM), from a fresh clone of this branch:
packages/daemon/deploy/deploy.sh all         # install → fetch → build → run → location → caddy

# Prove a peer reaches the bootstrap over the public WS endpoint. Run from
# inside the running container (its node_modules already resolve every import):
docker exec -e WS_URL_OVERRIDE=wss://minion.town/ocapn-daemon endo-pet-daemon \
  sh -c 'cd /app/packages/daemon &&
         node deploy/ocapn-bootstrap-client.mjs /data/ocapn-daemon-location.json endo-bootstrap'
```

## Tentative choices (per "prefer tentative progress over delay")

- **Base image `node:22-bookworm` (glibc, not Alpine).** `better-sqlite3` and
  the libp2p transitive `@ipshipyard/node-datachannel` are the only `built:
  true` native packages; they ship arm64/glibc prebuilds, and the toolchain in
  the image is the compile fallback. Alpine (musl) would force a source build of
  both. The Noise crypto ships as prebuilt WASM in-tree, so there is **no Rust
  build** either way.
- **Runtime = Docker** (already installed on the host). Podman would work
  equally; the deploy script installs `docker.io` if absent. The whole point of
  containerizing is that the native toolchain lives only inside the image — the
  host stays clean, no imperative host `apt-get`.
- **Loopback publish `127.0.0.1:8931`** (not `8930`, which the standalone demo
  already holds) → **container `8930`**. The daemon binds `0.0.0.0:8930` inside
  the container; only Caddy on 443 reaches it from outside (the box's security
  group allows only 80/443 inbound).
- **Persistent named volume `endo-daemon-data`.** Keeps the daemon's identity,
  pet store, and `@nets/ocapn` install across restarts. Remove the volume for a
  fresh ephemeral daemon (a fresh boot mints a new node id + Noise designator).
- **The `ws:url` rewrite.** The daemon advertises its loopback bind
  (`ws://127.0.0.1:8930`); the peer reaches it only at
  `wss://minion.town/ocapn-daemon`. Noise IK authenticates the location
  **designator** (independent of the transport URL), so the peer overwrites just
  the `ws:url` transport hint and the handshake still binds to the right daemon.
- **Restart idempotency.** `--restart unless-stopped` on a persisted volume
  means a host reboot re-runs the entrypoint against a pet store that already
  holds `@nets/ocapn`. Re-running the from-scratch install (`storeValue` +
  `makeUnconfined` + `move`) against that state **hangs** on pet-store name
  collisions — the symptom that stalled the first deploy attempt. The entrypoint
  now **looks `@nets/ocapn` up first** and reuses it (re-instantiating the
  persisted formula re-binds the WS listener with a fresh session designator);
  only a truly fresh volume installs from scratch. It also unlinks any stale
  location file at boot so the `location` phase never reads a prior boot's
  designator.
- **Box-local Caddy edit.** The route is added directly to
  `/etc/caddy/conf.d/minion-town.caddy` on the host (durable capture into the
  `kriscendobot/minion.town` repo deferred, matching the standalone demo).
