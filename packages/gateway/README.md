# `@endo/gateway`

`@endo/gateway` is the HTTP gateway package for Endo hosts. It
terminates the public HTTP surface, routes `Host` headers to
weblets, and provides the package boundary shared by these five
deployment shapes from `designs/gateway-package.md`:

1. A per-user developer install (today's shape).
2. A per-host system service that virtual-hosts many users on one
   address and registers from a local bootstrap sock.
3. A public web service reachable from the internet, serving Chat,
   Git-over-HTTP, OCapN over a Noise-encrypted WebSocket, and
   per-tenant weblets.
4. A Familiar-bundled fallback the Electron shell can stand up on
   an OS-assigned port for exactly one user.
5. A CapTP relay-as-a-service.

The five deployments share HTTP framing, virtual hosting, the
Noise-over-WebSocket OCapN endpoint, and the content-addressed
static-asset cache. They differ in configuration and supervision,
so the package exposes a small factory plus feature toggles instead
of baking one daemon mode into the implementation.

## Status

This is the **phase-4 slice**, building on phase 3's admin daemon,
phase 2's sock bootstrap registrar (Feature 4), and the phase-1
skeleton's package shape. Phase 3 split the admin facet onto a
separate local sock (`admin.sock`) so that registration authority
(any local user daemon with the bootstrap sock) and admin authority
(only the OS account that owns the admin sock) live on independent
capability paths; the admin facet remains reachable in-process via
`gateway.getAdmin()`, is **never** exposed on the public HTTP / WS
surface, and is **never** reached through the bootstrap sock. Phase
4 adds Feature 8 (the `OcapnWebSocketHandler` semantic core for
`/ocapn-cbor-np` WebSocket termination). The handler is reachable
in-process via `gateway.getOcapnHandler()`; an embedder that owns
an HTTP server feeds it upgraded WebSocket connections, and the
handler looks up the intended-responder public key in the
bootstrap's registration table and hands the byte stream off to
the registered daemon's `handleOcapnSession`. The gateway does
**not** terminate Noise itself; Noise's encryption and peer
authentication run end-to-end between the dialing peer and the
registered daemon.

Implemented:

- `makeGateway({ config, powers })` factory returning a hardened
  gateway exo with `start`, `stop`, `getBindAddress`, `getApps`,
  `getConfig`, `getBootstrap`, `getAdmin`, and (phase-4)
  `getOcapnHandler`.
- `ENDO_HTTP_ADDR` parsing with the OS-assigned-port (`:0`)
  convention; defaults to `0.0.0.0:8920`, preserving the existing
  daemon HTTP port and reserving `3469` for a future CBOR-frame
  transport.
- In-memory `AppsNameHub` exo with `bind`, `unbind`, `list`,
  `lookup` (phase 1, Feature 2).
- Per-feature configuration toggles validated at `make` time.
- `GatewayBootstrap` exo with `challenge`, `register`,
  `registerRelay`, `getBindAddress`, `getApps`;
  `Registration` handle with `publishWeblet`, `unpublishWeblet`,
  `addPublicKey`, `deregister`, `listWeblets`, `listPublicKeys`
  (phase 2, Feature 4).
- `GatewayAdmin` exo (phase 3, Feature 7) with `listRegistrations`,
  `deregisterRelay`, `listVirtualHosts`, `getResourceBalances`,
  `getCounters`. Reachable only via the in-process accessor and
  the admin sock; refused when `adminDaemon` is off. The admin
  daemon's toggle is independent of `sockBootstrap`; a deployment
  may offer admin reads without exposing the bootstrap sock and
  vice versa.
- `OcapnWebSocketHandler` exo (phase 4, Feature 8) with
  `handleConnection({ reader, writer })`. The handler reads the
  first WebSocket binary frame, extracts the 32-byte
  intended-responder Ed25519 public key from the prefixed-SYN's
  cleartext prefix, looks up the registration that owns the key,
  and hands the stream pair off to the registered daemon's
  `handleOcapnSession`. The gateway pumps no bytes itself after the
  handoff; Noise's confidentiality and authentication run
  end-to-end. Path constants (`OCAPN_WEBSOCKET_PATH`,
  `OCAPN_WEBSOCKET_LEGACY_PATH`) and a path matcher
  (`isOcapnWebSocketPath`) ship alongside the handler for
  embedders to use in their HTTP-server upgrade routing.
- Proof-of-possession nonce registry with domain-separated
  challenge hashing (`endo-gateway:registrar:nonce`), 30-second
  TTL, single-use semantics, constant-time signature comparison
  helper, and a Node-backed `CryptoPowers` adapter
  (`src/node-crypto-powers.js`).
- Bootstrap and admin sock path resolvers
  (`src/sock-paths.js`) covering `/run/endo-gateway/bootstrap.sock`
  and `/run/endo-gateway/admin.sock` (system service),
  `${XDG_RUNTIME_DIR}/endo-gateway/...` (user Linux), the macOS
  `Library/Application Support` variant, the `${TMPDIR}/...`
  fallback, and the `ENDO_GATEWAY_BOOTSTRAP_SOCK` /
  `ENDO_GATEWAY_ADMIN_SOCK` operator overrides. The two socks are
  always distinct file paths; deployment is responsible for the
  admin sock's stricter parent-directory mode (`0700`) so only the
  administrator OS account can `connect(2)` to it.

Deferred to follow-on PRs:

- Feature 1 (Chat hosting + payment-token enhancement). The
  `ResourceLedger` is the Feature 1 surface; phase 3 ships the
  admin facet that reads through it, and the ledger implementation
  itself lands with Chat-hosting. Until then,
  `getResourceBalances` returns an empty list when no ledger is
  supplied.
- Feature 3 (Git over HTTP).
- Feature 4 follow-on: the actual sock listener and
  CapTP-over-netstring server that serves the bootstrap exo to
  incoming connections.
- Feature 5 (Familiar-bundled fallback).
- Feature 6 (public CapTP relay).
- Feature 8 follow-on: the actual HTTP listener that performs the
  WebSocket upgrade on `/ocapn-cbor-np` and feeds the per-connection
  byte-stream pair into the handler. The Node-bound listener
  (`http.createServer` + `WebSocketServer.handleUpgrade`) lands in
  the same follow-on PR as the Feature 4 sock listener; until then,
  embedders that already own an HTTP server (the daemon's
  `ws-gateway.js`, a future `@endo/gateway-daemon` wrapper) feed
  the handler directly.
- Feature 9 (HTTPS-terminating-proxy `X-Forwarded-*` parser).
- Feature 10 (OS packaging: rpm / deb / PKGBUILD / Dockerfile).

The design's `## Capability Surface` section names the exos
introduced in each phase; this README is the package-side index
into the same surface.

## Install

```sh
npm install @endo/gateway
```

## Usage

The gateway is intended to be embedded in a host that provides
the powers (filesystem, net, crypto, time):

```js
import { makeGateway } from '@endo/gateway';

const gateway = await makeGateway({
  powers, // filesystem, net, crypto, time
  config: {
    bindAddress: '127.0.0.1:0',
    enableFeatures: {
      virtualHosting: true,
      ocapnWebSocket: false,
      sockBootstrap: false,
      chatHosting: false,
      gitHttp: false,
      captpRelay: false,
      adminDaemon: false,
    },
  },
});
await E(gateway).start();
const bindAddress = await E(gateway).getBindAddress();
// ...
await E(gateway).stop();
```

The configurable feature toggles are documented in
`src/config.js`; the design has the long form at
`designs/gateway-package.md` § Configuration Model.

## Configuration

The gateway reads configuration in three layers (later wins):

1. Built-in defaults: encoded in `src/config.js`.
2. The `config` argument to `makeGateway({ ... })`.
3. Environment variables (`ENDO_HTTP_ADDR` for the bind address,
   future `ENDO_GATEWAY_*` for the rest).

### `ENDO_HTTP_ADDR`

The bind address is a `host:port` pair. IPv6 uses bracket
notation. Port `0` requests an OS-assigned port. Examples:

```sh
ENDO_HTTP_ADDR=0.0.0.0:8920 endo-gateway       # default
ENDO_HTTP_ADDR=127.0.0.1:8920 endo-gateway     # private bind
ENDO_HTTP_ADDR=[::1]:8920 endo-gateway         # IPv6 loopback
ENDO_HTTP_ADDR=127.0.0.1:0 endo-gateway        # OS-assigned port
```

`ENDO_HTTP_ADDR` is distinct from `ENDO_ADDR` (the per-user
daemon's existing web-server bind, also defaulting to
`127.0.0.1:8920`). During the transition, an embedder runs one HTTP
gateway for a given host/port and chooses which package owns that
listener.

### Feature toggles

Each of the ten features in the design is gated by a
configuration flag; the defaults match the system-service
deployment. See `src/config.js` for the canonical list of flags
and their defaults.

## Capability surface

See `designs/gateway-package.md` § Capability Surface for the full
inventory. The phase-1 through phase-3 slices expose:

- `Gateway`: `start`, `stop`, `getBindAddress`, `getApps`,
  `getConfig`, `getBootstrap`, `getAdmin`, `getOcapnHandler`.
- `AppsNameHub`: `bind`, `unbind`, `list`, `lookup`, `has`.
- `GatewayBootstrap`: `challenge`, `register`, `registerRelay`,
  `getBindAddress`, `getApps`. The bootstrap channel carries the
  registrar exo only; it does **not** expose the admin facet.
- `Registration`: `publishWeblet`, `unpublishWeblet`,
  `addPublicKey`, `deregister`, `listWeblets`, `listPublicKeys`.
- `GatewayAdmin`: `listRegistrations`, `deregisterRelay`,
  `listVirtualHosts`, `getResourceBalances`, `getCounters`. The
  admin facet is reachable only via `gateway.getAdmin()`
  in-process and over the admin sock (`admin.sock`); the public
  HTTP / WS surface does not expose it, and the bootstrap sock
  does not expose it.
- `OcapnWebSocketHandler`: `handleConnection`. The handler accepts
  an upgraded `/ocapn-cbor-np` WebSocket as a `{ reader, writer }`
  pair, routes by the first frame's intended-responder Ed25519
  public key prefix, and hands the stream pair off to the
  registered daemon's `handleOcapnSession` exo. Refused when the
  `ocapnWebSocket` feature toggle is off; depends on
  `sockBootstrap` for the registration table the handler routes
  through.

### Bootstrap challenge-response

The bootstrap channel gates which-public-keys-may-register via a
proof-of-possession step. The flow:

```js
import { makeGateway } from '@endo/gateway';
import { makeNodeCryptoPowers } from '@endo/gateway/src/node-crypto-powers.js';

const gateway = makeGateway({
  powers: { crypto: makeNodeCryptoPowers(), clock: { now: () => Date.now() } },
});
const bootstrap = await E(gateway).getBootstrap();

// 1. Caller asks for a challenge.
const { nonce, hashedNonce } = await E(bootstrap).challenge();

// 2. Caller signs the *hashed* nonce with the Ed25519 private key
//    corresponding to the public key it wants to register.
const signature = keypair.sign(hashedNonce);

// 3. Caller submits the unhashed nonce + signature + public key.
const registration = await E(bootstrap).register({
  publicKey: keypair.publicKey,
  nonce,
  signature,
});

// 4. Registration handle publishes weblets, can be deregistered.
await E(registration).publishWeblet({
  webletId: 'weblet-abc',
  contentTreeRoot: 'a'.repeat(64),
  hasWebSocket: true,
});
```

Byte fields on the wire are immutable `ArrayBuffer` per the
`@endo/bytes` convention. Typed arrays cannot be frozen and so are
not passable; immutable `ArrayBuffer` is the canonical cross-realm
byte shape.

## Tests

```sh
yarn test                          # full ava run
npx ava test/config.test.js        # config-shape unit tests
npx ava test/vhost.test.js         # virtual-host NameHub tests
```

## Design

See `designs/gateway-package.md` for the overarching design
covering ten configurable feature subsystems, the capability
surface, the configuration model, and the phased rollout.
