# `@endo/gateway`

`@endo/gateway` is the package shape extracted from the per-user
daemon's built-in HTTP+WebSocket server, generalized to serve the
five deployment shapes named in `designs/gateway-package.md`:

1. A per-user developer install (today's shape).
2. A per-host system service that virtual-hosts many users on one
   address and registers from a UNIX-domain bootstrap socket.
3. A public web service reachable from the internet, serving Chat,
   Git-over-HTTP, OCapN over a Noise-encrypted WebSocket, and
   per-tenant weblets.
4. A Familiar-bundled fallback the Electron shell can stand up on
   an OS-assigned port for exactly one user.
5. A CapTP relay-as-a-service.

The five deployments share most of their machinery (HTTP framing,
virtual hosting, the Noise-over-WebSocket OCapN endpoint, the
content-addressed static-asset cache); they differ in configuration.
A single binary configuration cannot serve all of them without
re-introducing the forks the design corpus has been working around
one PR at a time, so the gateway is extracted into its own package.

## Status

This is the **phase-2 slice**, building on the phase-1 skeleton's
package shape. Phase 2 adds Feature 4 (UDS bootstrap for local
CapTP relay registration). The semantic core of the bootstrap (the
`GatewayBootstrap` exo, the proof-of-possession nonce registry,
the registration table) lands here; the actual UDS / named-pipe
listener that serves the bootstrap to incoming CapTP connections
is a follow-on PR, alongside CapTP-over-netstring framing reuse
from `packages/daemon/src/connection.js`. Embedders that already
speak CapTP (the Familiar bundle holding a process-local handle,
tests that connect in-realm) can hold the exo directly via
`E(gateway).getBootstrap()`.

Implemented:

- `makeGateway({ config, powers })` factory returning a hardened
  gateway exo with `start`, `stop`, `getBindAddress`, `getApps`,
  `getConfig`, and (phase-2) `getBootstrap`.
- `ENDO_HTTP_ADDR` parsing with the OS-assigned-port (`:0`)
  convention; defaults to `0.0.0.0:3469`.
- In-memory `AppsNameHub` exo with `bind`, `unbind`, `list`,
  `lookup` (phase 1, Feature 2).
- Per-feature configuration toggles validated at `make` time.
- `GatewayBootstrap` exo with `challenge`, `register`,
  `registerRelay`, `getBindAddress`, `getApps`; `Registration`
  handle with `publishWeblet`, `unpublishWeblet`, `addPublicKey`,
  `deregister`, `listWeblets`, `listPublicKeys` (phase 2,
  Feature 4).
- Proof-of-possession nonce registry with domain-separated
  challenge hashing (`endo-gateway:registrar:nonce`), 30-second
  TTL, single-use semantics, constant-time signature comparison
  helper, and a Node-backed `CryptoPowers` adapter
  (`src/node-crypto-powers.js`).
- Bootstrap UDS / named-pipe path resolver
  (`src/uds-paths.js`) covering `/run/endo-gateway/bootstrap.sock`
  (system service), `${XDG_RUNTIME_DIR}/endo-gateway/...` (user
  Linux), the macOS `Library/Application Support` variant, the
  Windows named-pipe `\\.\pipe\endo-gateway`, the `${TMPDIR}/...`
  fallback, and `ENDO_GATEWAY_BOOTSTRAP_SOCK` operator override.

Deferred to follow-on PRs:

- Feature 1 (Chat hosting + payment-token enhancement).
- Feature 3 (Git over HTTP).
- Feature 4 follow-on: the actual UDS / named-pipe listener and
  CapTP-over-netstring server that serves the bootstrap exo to
  incoming connections.
- Feature 5 (Familiar-bundled fallback).
- Feature 6 (public CapTP relay).
- Feature 7 (admin daemon; the `GatewayAdmin` exo extends the
  bootstrap).
- Feature 8 (`/ocapn-cbor-np` WebSocket; the network surface lands
  once `@endo/ocapn-noise` exposes the netlayer the gateway
  embeds).
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
      udsBootstrap: false,
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
ENDO_HTTP_ADDR=0.0.0.0:3469 endo-gateway       # default
ENDO_HTTP_ADDR=127.0.0.1:3469 endo-gateway     # private bind
ENDO_HTTP_ADDR=[::1]:3469 endo-gateway         # IPv6 loopback
ENDO_HTTP_ADDR=127.0.0.1:0 endo-gateway        # OS-assigned port
```

`ENDO_HTTP_ADDR` is distinct from `ENDO_ADDR` (the per-user
daemon's existing web-server bind, default `127.0.0.1:8920`); the
two coexist during the transition out of the in-daemon gateway.

### Feature toggles

Each of the ten features in the design is gated by a
configuration flag; the defaults match the system-service
deployment. See `src/config.js` for the canonical list of flags
and their defaults.

## Capability surface

See `designs/gateway-package.md` § Capability Surface for the full
inventory. The phase-1 and phase-2 slices expose:

- `Gateway`: `start`, `stop`, `getBindAddress`, `getApps`,
  `getConfig`, `getBootstrap`.
- `AppsNameHub`: `bind`, `unbind`, `list`, `lookup`, `has`.
- `GatewayBootstrap`: `challenge`, `register`, `registerRelay`,
  `getBindAddress`, `getApps`.
- `Registration`: `publishWeblet`, `unpublishWeblet`,
  `addPublicKey`, `deregister`, `listWeblets`, `listPublicKeys`.

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
surface, the configuration model, and the phased rollout. The
prior `designs/endo-gateway.md` is superseded by the package
design; its decisions carry forward unless explicitly revised.
