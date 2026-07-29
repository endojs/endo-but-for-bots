# OCapN-Noise-WS demo on minion.town (M3 + M4)

A **working demonstration**: an Endo OCapN-Noise service running on
**minion.town** (EC2 `i-0380cd68b90020fad`, us-west-1, aarch64, node v22),
serving **OCapN over WebSocket + Noise + CBOR**, dialed by a **local peer** from
a garden container over `wss://minion.town/ocapn`, round-tripping a capability.

The transcript of a real run is in
[`transcripts/minion-ocapn-ws-roundtrip.log`](transcripts/minion-ocapn-ws-roundtrip.log):

```
[client] rewrote ws:url hint -> wss://minion.town/ocapn
[client] enlivened 'greeter'; invoking...
[client] getNodeId() = 810b996c1a52092ac852a687a64f6ebcd77526cf3339d8ff8f4cd8e915bca426
[client] hello(the local peer) = Hello, the local peer! — greetings over OCapN-Noise-WS from the minion.town host.
RESULT {"ok":true,"swissnum":"greeter","nodeId":"810b996c…","reply":"Hello, the local peer! …"}
```

## What proves what

The demo exercises the **exact session layer the Pet Daemon's
`src/networks/ocapn.js` uses** over WebSocket:

- `@endo/ocapn-noise` WS transport (`transport/ws`, the `makeWebSocketTransport`
  added by this branch's `feat(daemon): serve and dial OCapN-Noise over
  WebSocket`),
- Noise **IK** mutual authentication keyed on the location **designator**,
- `@endo/ocapn` CBOR framing, locator, swissnum, sturdyref -> capability
  invocation,
- carried on a WebSocket through **Caddy TLS on 443**, terminating at a
  **loopback** listener (the box's security group originally allowed only
  80/443 inbound, which is why WS+Caddy was the first transport; a dedicated
  port for the raw-TCP variant below was opened later, under maintainer
  authorization).

## The pieces

| File | Role |
| --- | --- |
| `ocapn-ws-server.mjs` | Standalone OCapN-Noise-WS service. Publishes a `Greeter` exo (`hello`, `getNodeId`) in an OCapN locator under swissnum `greeter`, listens on a loopback WS port, and writes its `OcapnLocation` (designator + `ws:url` hint) as JSON. This is the **daemon** in the demo. |
| `ocapn-ws-client.mjs` | The **local peer**. Reads the location JSON, rewrites the `ws:url` hint to a public `wss://` endpoint (`WS_URL_OVERRIDE`), opens a Noise session, fetches a swissnum, and invokes the capability. |
| `endo-ocapn-daemon.service` | The systemd unit as deployed on the host. |
| `ocapn-demo.caddy` | The `/ocapn` route as folded into `minion-town.caddy`. |
| `run-demo.sh` | Repeatable end-to-end runner (fetch location via SSM -> rewrite hint -> dial). |
| `ssm.sh` | Thin `aws ssm send-command` wrapper (garden AWS creds). |
| `ocapn-tcp-server.mjs` | The **TCP+CBOR** sibling of `ocapn-ws-server.mjs`: same Greeter, listening on a raw TCP port with netstring-framed CBOR, advertising public `tcp:host`/`tcp:port` hints (`DEMO_PUBLIC_HOST`/`DEMO_PUBLIC_PORT`). |
| `ocapn-tcp-client.mjs` | The TCP **local peer**: dial-only `makeTcpTransport`, optional `TCP_HOST_OVERRIDE`/`TCP_PORT_OVERRIDE` hint rewrites. |
| `endo-ocapn-tcp-demo.service` | The systemd unit for the TCP service as deployed on the host. |

## TCP+CBOR variant (cross-host, public port 8929)

The same proof over the **second required transport**: raw TCP with
netstring-framed CBOR, no Caddy, no TLS — the Noise IK handshake is the whole
security layer. A raw TCP listener cannot ride the HTTPS port, so this variant
needed a **security-group change**: inbound `tcp/8929` on `sg-0f2cf8d86744b7293`
(rule `sgr-0d9fc044a33568003`, opened 2026-07-29 under the maintainer's
authorization on PR #683's demo report). `endo-ocapn-tcp-demo.service` runs
container `endo-ocapn-tcp-toy` from the same image, binding `0.0.0.0:8929`
(docker-published) and advertising `tcp:host=minion.town tcp:port=8929` in the
location JSON at `/opt/ocapn-demo/ocapn-tcp-location.json` — directly dialable,
no client-side rewrite needed. The image predates `ocapn-tcp-server.mjs`, so the
unit bind-mounts the script from `/opt/ocapn-demo/` over its in-tree path
(which also gives it the in-image `node_modules` resolution).

Live cross-host transcript (garden container → `minion.town:8929`):
[`transcript-tcp-cross-host.txt`](transcript-tcp-cross-host.txt).
With this, the cross-host capability round-trip is proven over **both** OCapN.md
transports — WebSocket/HTTP (through Caddy TLS) and TCP+CBOR (direct).

## How the daemon reached the host

The toy service runs from the same `endo-pet-daemon:ocapn-ws` docker image that
serves the full Pet Daemon on the host (built from this stack's branch; deps and
the prebuilt Noise WASM ship in-image, so the aarch64 host needs no native
build or checkout). `endo-ocapn-daemon.service` is a `docker run` wrapper:
container `endo-ocapn-toy` runs `demo/minion-town/ocapn-ws-server.mjs`, publishes
loopback `127.0.0.1:8930`, and writes its `OcapnLocation` JSON to the
bind-mounted `/opt/ocapn-demo/ocapn-demo-location.json`. (An earlier iteration
ran from a `/opt/endo` git checkout; that clone is gone and nothing depends on
it anymore — the docker unit is self-contained.)

## The Caddy route

`wss://minion.town/ocapn` was added by folding a `handle /ocapn*` block into the
existing `minion.town, www.minion.town { ... }` site in
`/etc/caddy/conf.d/minion-town.caddy` (see `ocapn-demo.caddy`) — a `handle`, not
a second site block, because Caddy rejects duplicate site addresses. It is
**not** behind the oauth2-proxy `forward_auth` gate (OCapN-over-Noise
self-authenticates). The `/ocapn*` routes now live durably in the
`kriscendobot/minion.town` repo's Caddyfile (its CD renders `deploy/aws/caddy/`
onto the box wholesale, so any box-local route would be clobbered on the next
push to main). `caddy` / `oauth2-proxy` / `minion-mcp` were untouched.

## Reproduce

```sh
# From an installed endo checkout of this branch, HOME pointing at garden AWS creds:
GARDEN_AWS_HOME=/home/<bot>/garden \
  packages/daemon/demo/minion-town/run-demo.sh
```

## Tentative choices (documented per "prefer tentative progress over delay")

- **Standalone OCapN-Noise-WS service, not the full Pet Daemon bootstrap.** The
  delivered `endo-ocapn-daemon.service` runs `ocapn-ws-server.mjs` — the same
  `@endo/ocapn-noise` + `@endo/ocapn` session/locator machinery the daemon's
  `src/networks/ocapn.js` uses, minus the pet-store/agent/gateway lifecycle. This
  was the smallest reasonable default that proves the whole transport path
  (Caddy 443 -> loopback WS -> Noise IK -> CBOR -> sturdyref -> capability invoke)
  end to end without the daemon-lifecycle plumbing (background `endo` daemon,
  unix socket, `@nets/ocapn` install, live-address extraction). **To promote to
  the real Pet Daemon's bootstrap** (swissnum `endo-bootstrap`, methods
  `getNodeId`/`getGreeter`/`getAgentBinding`), on the host: start the daemon,
  `E(host).storeValue('127.0.0.1:8930','ws-listen-addr')`, install
  `src/networks/ocapn.js` as `@nets/ocapn` (`makeUnconfined` + `move` per
  `test/_multiplayer-suite.js`), then extract its advertised
  `ocapn+noise+ws://...?loc=...` address and feed the same client (the `loc` already
  carries the designator; only the `ws:url` hint needs the same rewrite). The
  Caddy route and client are unchanged.
- **The `ws:url` rewrite.** The daemon advertises its loopback bind
  (`ws://127.0.0.1:8930`); the peer reaches it only at `wss://minion.town/ocapn`.
  The Noise handshake authenticates the location **designator** (the server's
  static Noise key), which is independent of the transport URL, so the client
  overwrites just the `ws:url` transport hint and the handshake still binds to
  the right server. Validated locally: with a deliberately-wrong hint and no
  override the dial fails; with the override it succeeds.
- **Loopback port 8930**, swissnum `greeter`. The Caddy route started as a
  box-local file and has since been landed durably in the
  `kriscendobot/minion.town` repo (its CD would clobber a box-local route).
