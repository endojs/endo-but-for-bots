# M4/M5 roadmap — from the `ocapn-noise-daemon-survey` board job (2026-07-11)

## State of the daemon integration

- On `endojs/endo-but-for-bots@llm` the Pet Daemon does **NOT** speak OCapN-over-Noise.
  Its remote edge is the legacy `@endo/captp` netlayer stack under
  `packages/daemon/src/networks/` (`tcp-netstring`, `ws-relay`, `iroh`, `loopback`),
  registered as formulas under the `@nets` directory. Contract:
  `EndoNetwork = { supports, addresses, connect }`.
- The OCapN-Noise netlayer + CBOR codec + TCP and WS transports **are landed** as
  sibling packages (`@endo/ocapn-noise`, `@endo/ocapn/cbor`) via merged PR **#137**.
  `ws-node.js` already has a full **listener** (`makeWebSocketTransport` with
  `WebSocketServer`), advertising `hints:{ url:'ws://host:port' }`.

## The integration lives in draft PR #340 (not merged)

- Branch `claude/endo-daemon-ocapn-FkmHO` (base `llm`). Adds
  `packages/daemon/src/networks/ocapn.js` — an `EndoNetwork` over
  `makeOcapn`+`makeOcapnNoiseNetwork({codec: cborCodec})`, address protocol
  `ocapn+noise+tcp`, publishing an `EndoOcapnBootstrap` exo at swissnum
  `endo-bootstrap`. `setup-ocapn.js` installs it at `@nets/ocapn`.
- **TCP only.** Serving works (makeOcapn inbound path + TCP `listen`).
- Ships an in-process `_multiplayer-suite.js` + `invite-retention-ocapn.test.js`
  running **invite/accept/value-exchange/partition/restart/three-party over
  Noise+TCP+CBOR** — so invite/accept over Noise is already prototyped/tested
  in-process.

## Invite/accept wire format (landed)

`endo://{peerKey}/{formulaNumber}@{hint}@{hint}?type=invitation&from={h}&fromNode={n}`
- `peerKey` = 64-hex Ed25519 NodeNumber; hints are opaque transport-prefixed URL
  strings (`ConnectionHint = string`), today `tcp+netstring+json+captp0://host:port`.
- CLI `invite` prints locator to stdout; `accept` reads from stdin (copy/paste
  pairing). Both sides call `addPeerInfo({node, addresses})` — a two-way exchange.
- Distance from `OcapnLocation` ({type,designator,network,hints{}}): moderate; no
  parser splits an opaque hint string into `{network, hints{}}` today (routing is
  by `network.supports(addressString)` prefix match). Cheapest path keeps the
  opaque `ocapn+noise+…` hint (PR #340's approach).

## Milestone plan

**M4 — minion.town Pet Daemon serves OCapN over WS+Noise, local peer connects:**
1. Base work on PR #340's branch.
2. Wire `makeWebSocketTransport` into `networks/ocapn.js`: inject `WebSocketServer`/
   `WebSocket` powers, `network.addTransport(wsTransport)`, add a `ws-listen-addr`
   parallel to the TCP `ocapn-listen-addr`, and an `ocapn+noise+ws` address/hint
   encoding (`{ 'ws:url': 'ws://…' }`).
3. Deploy the daemon on **minion.town via systemd** (maintainer's job on the board).
4. Expose it through Caddy: add `conf.d/ocapn-demo.caddy` reverse-proxying
   `wss://minion.town/<path>` → the daemon's loopback WS port, **bypassing
   oauth2-proxy** (OCapN-over-Noise self-authenticates; the web login gate is for
   humans, not the netlayer). Per-file conf.d discipline avoids clobbering.
5. Dial from a local peer over `wss://minion.town/<path>`.

**M5 — two Pet Daemons via invite/accept over Noise, both transports:**
1. Route `endo://` peer dials through `@nets/ocapn` (advertise ocapn+noise hints in
   `getPeerInfo`/`locate`), and add a **forked two-daemon** invite/accept
   integration test parameterized over `ocapn+noise+tcp` AND `ocapn+noise+ws`.
2. Decide whether to close the `daemon-agent-network-identity` keypair binding
   (Noise session key ↔ daemon NodeNumber/designator) for true mutual auth, or
   defer it as PR #340 does (stopgap: cross-checked node-id report).

## Caddy / oauth facts (from SSM recon)

- Root `/etc/caddy/Caddyfile` is thin: global options + `import conf.d/*.caddy`.
  One `.caddy` file per site (concurrency-safe). Source of truth is the
  `kriscendobot/minion.town` repo; `deploy/aws/scripts/deploy-caddy.sh` renders via
  SSM — a durable route should land there, but a demo route can be dropped on the
  box directly.
- oauth2-proxy (`127.0.0.1:4180`) is the human web-login gate (Cognito OIDC
  forward_auth). The OCapN route must **not** sit behind it.
- Host: aarch64, node v22.23.1. No Endo daemon deployed yet.
