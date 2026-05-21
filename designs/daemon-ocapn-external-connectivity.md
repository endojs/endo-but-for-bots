# Daemon OCapN External Connectivity

| | |
|---|---|
| **Created** | 2026-05-21 |
| **Updated** | 2026-05-21 |
| **Author** | Aaron Kumavis (prompted) |
| **Status** | In Progress |

## Status

A first increment has landed: the OCapN-Noise peer transport exists
and is installable, so daemon-to-daemon connections can be carried by
OCapN instead of CapTP.

Built:

- `packages/daemon/src/networks/ocapn.js` — an OCapN-Noise transport
  that conforms to the existing `EndoNetwork` interface (`addresses`,
  `supports`, `connect`). It embeds an `@endo/ocapn` client over an
  `@endo/ocapn-noise` network with a TCP transport, publishes the
  daemon's `EndoGreeter` through the OCapN locator, and dials peers by
  fetching their greeter over an OCapN session and running the
  existing `hello` handshake.
- `packages/daemon/src/networks/setup-ocapn.js` — the unconfined-caplet
  installer that registers the transport at `@nets/ocapn`, mirroring
  `setup-libp2p.js`.
- `@endo/ocapn` and `@endo/ocapn-noise` added to `packages/daemon`
  dependencies.
- `MULTIPLAYER.md` documents the OCapN-Noise transport.

Deviations from the design as first written, and why:

- **The transport-module approach was used instead of removing the
  bespoke peer spine.** Because `networks/ocapn.js` conforms to the
  `EndoNetwork` contract, the daemon's `EndoGreeter`, `EndoGateway`,
  `RemoteControl`, and `peer`-formula machinery are reused unchanged:
  the peer application protocol (`hello`/`provide`/`followRetentionSet`)
  rides on OCapN exactly as it rode on CapTP. This makes the migration
  a localized, low-risk transport swap rather than a daemon-core
  rewrite. `connection.js`/`@endo/captp` is now untouched on the peer
  path; it remains only for worker, CLI, and web-gateway edges.
- **`RemoteControl` and `EndoGreeter` are retained, not deleted.** They
  are the protocol-agnostic *application* layer (crossed-hello policy
  and the peer handshake), not the transport. Replacing them with
  OCapN's own session manager is a deeper refactor that depends on
  `ocapn-network-transport-separation` landing and on runtime
  verification; deleting working code on speculation was not done.
- **`tcp-netstring.js` is retained, not removed.** See the blocker
  below — until the OCapN identity is bound to the daemon keypair,
  removing the CapTP transport would regress cross-daemon identity.

Known blocker — per-agent keys (`daemon-agent-network-identity`):

- The OCapN-Noise network needs the raw Ed25519 private key bytes for
  its handshake. The daemon's `@keypair` is a capability that
  deliberately does not expose raw key bytes, and the only key
  material a network caplet can read today is the *public* node id
  from `getPeerInfo()`. So `networks/ocapn.js` currently mints a fresh
  per-network signing key; the OCapN session identity is therefore not
  yet the daemon node number. The connection hint carries the full
  OCapN location so dialing still works, but binding the OCapN
  identity to the agent keypair is exactly the
  [`daemon-agent-network-identity`](daemon-agent-network-identity.md)
  design and must land before the OCapN transport can replace the
  CapTP one outright.

Remaining (Phases 2-3): bind the OCapN identity to the agent keypair,
make `@nets/ocapn` the default transport, route `endo://` locators
through OCapN sturdyrefs, retire `tcp-netstring.js`, and add the
forked-daemon integration test from the Test Plan below.

## What is the Problem Being Solved?

The Endo daemon uses CapTP for *every* connection it makes.
A daemon talks to its workers with CapTP, to the CLI with CapTP, to
browser-hosted weblets with CapTP, and to *other daemons* with CapTP.
The first three are local, trusted, already-authenticated channels.
The last one — daemon-to-daemon — is a wide-area connection between
mutually distrusting hosts, and CapTP is the wrong layer for it.

To make CapTP serve as the peer protocol, the daemon has grown a
bespoke reimplementation of the things [OCapN][] already specifies:

- a peer handshake (`EndoGreeter.hello`),
- crossed-hello reconciliation (`remote-control.js`),
- a nonce-locator (`EndoGateway.provide` plus the `endo://` locator),
- and a transport-plugin abstraction (the `EndoNetwork` formula).

Each of these is a narrower, less-rigorous version of a construct that
`@endo/ocapn` provides as a first-class, specification-aligned API.
The bespoke stack also lacks properties the peer edge actually needs:

1. **No confidentiality or proven identity.** `networks/tcp-netstring.js`
   carries JSON CapTP in cleartext. The remote node id arrives as a
   *string argument* to `EndoGreeter.hello` — asserted, not proven.
2. **No spec-aligned wire format.** The daemon speaks JSON CapTP, not
   the Syrup/CBOR OCapN encodings, so it cannot interoperate with any
   other OCapN implementation.
3. **No durable references.** A reference to a remote value survives
   only as an `endo://` string that must be re-resolved through
   `provide`; there is no sturdyref.

Meanwhile `@endo/ocapn` is in this repository and `@endo/ocapn-noise`
— a Noise-Protocol network that gives exactly the encryption and
proven-identity properties the peer edge is missing — is **Complete**
(see [`ocapn-noise-network`](ocapn-noise-network.md)).

This design proposes that the daemon adopt `@endo/ocapn` for the
daemon-to-daemon edge, and *only* that edge.
CapTP stays where it belongs: on the local, trusted connections.

## Background: How Connectivity Works Today

Every connection the daemon makes is a CapTP session.
`packages/daemon/src/connection.js` provides the two factories that
build them — `makeMessageCapTP` (line 90) and `makeNetstringCapTP`
(line 276) — both thin wrappers over `makeCapTP` from `@endo/captp`
(imported at line 4).

Four kinds of edge use those factories:

| Edge | Where | Carrier |
|------|-------|---------|
| daemon ↔ worker | `worker.js:243`, `bus-worker-node-raw.js:48` | CapTP over the worker process pipe |
| daemon ↔ CLI | `client.js:38` | CapTP over the daemon's Unix-domain socket |
| browser ↔ daemon web gateway | `ws-gateway.js` | CapTP over a WebSocket, for Chat and weblets |
| daemon ↔ daemon (peer) | `networks/*.js` + `daemon.js` | CapTP over an `EndoNetwork` transport module |

The first three are local: the OS already authenticated the worker
process, the Unix socket is gated by filesystem permissions, and the
web gateway terminates browser sessions whose authority is a bearer
token ([`gateway-bearer-token-auth`](gateway-bearer-token-auth.md)).

The fourth — the peer edge — is the bespoke stack:

- **`EndoNetwork` transport modules.** A network is an unconfined
  caplet registered in an agent's `NETS` directory. Each implements
  `{ supports(protocol), addresses(), connect(address, context) }`
  (`types.d.ts` line ~876). `networks/tcp-netstring.js` is the TCP
  transport, `networks/libp2p.js` the libp2p transport, and
  `networks/loopback.js` a same-process shortcut that just returns the
  local gateway directly.
- **The handshake.** `connect()` dials, builds a CapTP session, takes
  the remote `EndoGreeter` as the bootstrap object, and calls
  `E(greeter).hello(localNodeId, localGateway, cancel, cancelled)`
  (`tcp-netstring.js:192`). The remote returns its `EndoGateway`.
- **`localGateway`** (`daemon.js:1178`) is the daemon's nonce-locator:
  `provide(id)` returns a local formula, rejecting any non-local id
  with `"Gateway can only provide local values"` (lines 1182-1189).
  It also carries `followRetentionSet` for cross-peer GC.
- **`localGreeter`** (`daemon.js:1226`) accepts inbound connections and
  feeds the remote gateway into the connection state machine.
- **`RemoteControl`** (`remote-control.js`) is a `start`/`accepted`/
  `connected` state machine that reconciles crossed-hellos — two
  daemons dialing each other at once — by comparing node ids and
  letting the larger id's outbound connection win.
- **`makePeer`** (`daemon.js:4763`) is the peer formula's maker: given
  a foreign node number and a list of `at=` addresses, it iterates
  registered networks, finds one that `supports` the address protocol,
  dials, and returns a `ResilientPeerGateway`.
- **`endo://` locators** (`locator.js`) encode `node`, formula
  `number`, formula `type`, and one or more `at=` connection-hint
  addresses. A `provide(id)` for a foreign node resolves the peer
  formula, dials, and calls `E(remoteGateway).provide(id)`.

Every item in that list has a direct OCapN counterpart.
The peer stack is a parallel, in-daemon reimplementation of OCapN.

## Description of the Design

### The Boundary: CapTP Local, OCapN Remote

The single organizing principle of this design is the edge boundary:

| Edge | Today | After this design |
|------|-------|-------------------|
| daemon ↔ worker | CapTP | **CapTP — unchanged** |
| daemon ↔ CLI | CapTP | **CapTP — unchanged** |
| browser ↔ web gateway | CapTP | **CapTP — unchanged** |
| daemon ↔ daemon (peer) | CapTP over `EndoNetwork` | **OCapN over OCapN-Noise** |

CapTP is the right protocol for a connection that is local, trusted,
and already authenticated by the surrounding system.
OCapN is the right protocol for a connection that is wide-area,
between mutually distrusting peers, and must be encrypted and
mutually authenticated on its own merits.

`connection.js`, `worker.js`, `bus-worker-*.js`, `client.js`, and
`ws-gateway.js` are **out of scope** and keep importing `@endo/captp`.
The `@endo/captp` dependency stays in `packages/daemon`.
The browser ↔ web-gateway edge stays CapTP deliberately: a browser
cannot run a Noise handshake without shipping the netlayer into the
page, and the [`endo-gateway`](endo-gateway.md) design already treats
the browser-facing path as plain HTTP/WebSocket CapTP terminating at
the gateway. Only the daemon-to-daemon edge migrates.

### 1. Embed One OCapN Client per Daemon

The daemon constructs a single OCapN client at startup:

```js
import { makeOcapn } from '@endo/ocapn';
import { syrupCodec } from '@endo/ocapn/syrup';
import { makeOcapnNoiseNetwork } from '@endo/ocapn-noise';

const network = makeOcapnNoiseNetwork({ codec: syrupCodec });
const ocapn = await makeOcapn({ codec: syrupCodec, network, locator });
```

One client per **daemon process**, not one per agent.
The OCapN-Noise network supports multiple signing keys on one network
via `addSigningKeys`, so every agent's Ed25519 keypair (from
[`daemon-256-bit-identifiers`](daemon-256-bit-identifiers.md)) is
registered with the one network.
This matches [`daemon-agent-network-identity`](daemon-agent-network-identity.md)'s
"register agent keys with the network" flow and keeps a single
listening socket per host.

### 2. The Daemon's `locator` Replaces `EndoGateway.provide`

OCapN's `locator` argument is a `NonceLocator`: a table with
`get(secret) → value` that a remote peer reaches through the session
bootstrap's `fetch(secret)`.
This is exactly what `localGateway.provide(id)` is today.

The daemon implements `locator.get(swissnum)` to:

1. decode the swissnum to a formula identifier,
2. assert it is a *local* id — the surviving form of the
   `"Gateway can only provide local values"` guard, and
3. return `provide(id)`.

A formula identifier is already an unguessable 256-bit capability, so
using it as the OCapN swissnum preserves the capability-secrecy
property with no new entropy requirement.
`followRetentionSet` for cross-peer GC becomes a method on the exo the
locator returns for a well-known bootstrap swissnum; the retention
accumulator, the SQLite `retention` table, and the
[`daemon-cross-peer-gc`](daemon-cross-peer-gc.md) logic are unchanged
— only the transport beneath them changes.

### 3. `endo://` Locators Become OCapN Locations and Sturdyrefs

Today an `endo://` URL is a query string the daemon parses itself.
OCapN already has the two constructs it conflates:

- `OcapnLocation` (`{ type: 'ocapn-peer', designator, network, hints }`)
  designates *a peer on a network*. The `designator` is the agent's
  Ed25519 public key; `network` is the OCapN-Noise network identifier;
  `hints` carry the connection addresses that `at=` carries today.
- `makeSturdyRef(location, secret)` / `enlivenSturdyRef` bind a
  location to a swissnum to form a *durable reference to a specific
  remote value*.

`locator.js` keeps its role as the locator boundary but emits and
parses OCapN locations and sturdyrefs instead of the bespoke
`endo://` query string.
Whether the user-facing string still spells `endo://` (a thin skin
over a sturdyref) or adopts the OCapN URI form is left to
[`daemon-locator-terminology`](daemon-locator-terminology.md); this
design only requires that the *internal* representation be an OCapN
sturdyref.

### 4. `EndoGreeter.hello` Becomes the OCapN Session Handshake

The bespoke `hello(remoteNodeId, remoteGateway, …)` exchange is
replaced by OCapN session establishment.
The crucial gain: under OCapN-Noise the peer's identity — its Ed25519
public key — is *proven by the Noise handshake*, not asserted as a
string argument the way `remoteNodeId` is today.

Outbound, the daemon calls `ocapn.provideSession(location)` and reads
the remote bootstrap with `session.getBootstrap()`; the bootstrap's
`fetch(swissnum)` replaces `E(remoteGateway).provide(id)`.
Inbound, the daemon consumes `network.inboundSessions` instead of
running an `EndoGreeter` exo.

### 5. `RemoteControl` Is Deleted

`remote-control.js` exists only because two daemons can dial each
other simultaneously and the daemon must pick one connection.
OCapN already specifies crossed-hello resolution (compare session
public keys bytewise, keep the greater — `ocapn/src/client/handshake.js`),
and the OCapN session manager is idempotent per peer location.
[`ocapn-network-transport-separation`](ocapn-network-transport-separation.md)
further moves crossed-hello handling *into the network*, which is
where it belongs.

So `remote-control.js`, the `provideRemoteControl` wiring
(`daemon.js:1174`), and the `accept`/`connect` state machine are
removed; `ocapn.provideSession` subsumes them.

### 6. `EndoNetwork` Formulas Become OCapN Networks

Today a transport is an unconfined caplet in `NETS/` implementing
`{ supports, addresses, connect }`.
After this design the daemon's OCapN-Noise network owns its
transports internally (`addTransport` for TCP and WebSocket).
The `NETS/` directory and the per-agent NETS concept from
[`daemon-agent-network-identity`](daemon-agent-network-identity.md)
keep their role — governing *which addresses an agent advertises in
its locators* and which transports are active — but the objects
registered there describe OCapN network and transport configuration,
not CapTP-dialing caplets.

`networks/loopback.js` is a same-process shortcut that never touches a
wire; it stays as a direct-gateway fast path.
`networks/tcp-netstring.js` is retired.
`networks/libp2p.js` either becomes an OCapN transport or is dropped
in favour of Noise-over-WebSocket relays — see Open Questions.

### 7. Foreign-Id `provide` Routes Through OCapN Sessions

The `provide(foreignId)` flow changes only in its transport segment:

```
provide(foreignId)
  → parse foreignId; node component is a remote agent public key
  → build OcapnLocation { designator: publicKey, network, hints }
  → ocapn.provideSession(location)            // was: makePeer + dial
  → E(session.getBootstrap()).fetch(swissnum) // was: E(gateway).provide(id)
```

The peer formula's role — a cached, resilient handle to a remote
daemon — maps onto an OCapN session, which the session manager
already caches and re-establishes
([`ocapn-noise-session-reconnect`](ocapn-noise-session-reconnect.md)).
Persistent formula-graph entries, pet-store entries, and message
records remain strings and survive reconnection exactly as the
`MULTIPLAYER.md` "Reconnection" section describes today.

## Phased Implementation

**Phase 1 — Embed, dark.**
Add `@endo/ocapn` and `@endo/ocapn-noise` as `packages/daemon`
dependencies. Construct the OCapN client and Noise network at daemon
startup behind a feature flag. Wire `locator.get` to `provide`.
Register every agent keypair with the network.
No peer traffic flows over OCapN yet; the `EndoNetwork` path is
untouched. Exit: a unit test connects two daemons' OCapN clients
directly and fetches a formula by swissnum.

**Phase 2 — Route peer traffic.**
Outbound `provide` for a foreign id goes through `ocapn.provideSession`;
inbound peer sessions are consumed from `network.inboundSessions`.
`locator.js` emits and parses OCapN sturdyrefs.
`endo://` invitations carry an `OcapnLocation`.
The `EndoNetwork`/`tcp-netstring` path remains as a fallback selected
by the Phase 1 flag. Exit: the `MULTIPLAYER.md` invite/accept/send/
adopt/resolve flow passes end-to-end over OCapN-Noise.

**Phase 3 — Retire the bespoke stack.**
Delete `remote-control.js`, `EndoGreeter`, the peer half of
`EndoGateway`, `networks/tcp-netstring.js`, and (pending the Open
Question) `networks/libp2p.js`.
Remove the Phase 1 flag.
Update `MULTIPLAYER.md`, `DEBUGGING.md`, and the `/network`,
`/invite`, `/accept` Chat and CLI commands.
Exit: no peer code path imports `@endo/captp`; the worker, CLI, and
web-gateway edges are demonstrably unaffected.

## Design Decisions

1. **One OCapN client per daemon process, not per agent.** The
   OCapN-Noise network registers many signing keys, so a single
   client serves every agent and binds one socket per host. A
   per-agent client would multiply listening sockets for no gain.
2. **Worker, CLI, and web-gateway edges keep CapTP.** They are local
   and already authenticated; OCapN's handshake and encryption would
   be cost without benefit, and the browser cannot run Noise in-page.
3. **The formula identifier is the swissnum.** Formula ids are already
   256-bit unguessable capabilities; reusing them as swissnums avoids
   inventing a second secret space and a mapping table.
4. **`RemoteControl` is deleted, not ported.** Crossed-hello
   resolution is an OCapN responsibility; keeping a second
   implementation in the daemon would be a divergence risk.
5. **Codec choice is deferred to the Noise network.** Syrup and CBOR
   are not negotiated on the wire; the daemon adopts whichever codec
   [`ocapn-noise-network`](ocapn-noise-network.md) standardizes so
   both peers agree out of band.

## Dependencies

| Design | Relationship |
|--------|-------------|
| [ocapn-noise-network](ocapn-noise-network.md) | Provides the Noise network this design embeds; **Complete**. |
| [ocapn-network-transport-separation](ocapn-network-transport-separation.md) | Provides the `OcapnNetwork` interface and moves crossed-hello handling into the network. |
| [ocapn-noise-session-reconnect](ocapn-noise-session-reconnect.md) | Session liveness and reconnect; replaces `RemoteControl`'s reconnection role. |
| [daemon-agent-network-identity](daemon-agent-network-identity.md) | Per-agent keys registered with the network; agent public key as the locator node component. |
| [daemon-256-bit-identifiers](daemon-256-bit-identifiers.md) | Provides the Ed25519 keypairs used as OCapN node identities; **Complete**. |
| [daemon-locator-terminology](daemon-locator-terminology.md) | Decides whether the user-facing locator string stays `endo://` over an OCapN sturdyref. |
| [daemon-cross-peer-gc](daemon-cross-peer-gc.md) | Retention-set sync rides the new OCapN transport unchanged; **Complete**. |
| [endo-gateway](endo-gateway.md) | The host gateway terminates the same OCapN-Noise endpoint at `ws://<host>/ocapn`; this design and that one share the OCapN external surface. |

## Security Considerations

- **Net improvement.** The peer edge moves from plaintext JSON CapTP
  with an *asserted* node id to Noise-encrypted OCapN with a *proven*
  Ed25519 peer identity.
- **The locality guard must survive.** `locator.get` must reject any
  swissnum that does not decode to a *local* formula id, exactly as
  `localGateway.provide` rejects non-local ids today. A locator that
  served arbitrary ids would turn the daemon into an open relay.
- **Swissnum entropy.** Formula ids are 256-bit; they have ample
  entropy to act as unguessable swissnums.
- **No new trust on the local edges.** Because the worker, CLI, and
  web-gateway edges are untouched, their existing trust model
  (OS process identity, socket permissions, bearer token) is unchanged.

## Compatibility Considerations

- The peer wire format changes from JSON CapTP to OCapN
  (Syrup or CBOR). A pre-migration daemon and a post-migration daemon
  cannot peer. The daemon is unreleased and developed in a single
  tree, so a flag day is acceptable; Phase 2's fallback flag gives a
  transition window for developers running mixed checkouts.
- `endo://` locators minted by a pre-migration daemon will not resolve
  on a post-migration daemon. Phase 2 keeps the old `locator.js`
  parser available behind the flag; pet-store repair on startup can
  rewrite stored locators, mirroring the local-key repair already done
  for [`daemon-agent-network-identity`](daemon-agent-network-identity.md).

## Test Plan

- **OCapN peer integration test.** A new `test/ocapn-peer.test.js`
  forks two daemons, enables OCapN networking on both, and runs the
  `MULTIPLAYER.md` flow: invite, accept, send a value, adopt it,
  request, resolve. `test.serial`, with `t.teardown` for both daemons.
- **Reconnect test.** Drop the transport mid-session and assert the
  session re-establishes and a subsequent `provide` succeeds, guarding
  the [`ocapn-noise-session-reconnect`](ocapn-noise-session-reconnect.md)
  contract. `t.timeout` set so a reconnect hang fails fast.
- **Worker-bus regression.** Assert the daemon ↔ worker edge still
  uses CapTP and that `connection.js`/`worker.js` are unmodified —
  the existing `test/endo.test.js` suite must pass untouched.
- **Locality guard.** Assert `locator.get` rejects a swissnum for a
  non-local formula id with the migrated guard error.

## Known Gaps and TODOs

- [ ] Decide the fate of `networks/libp2p.js`: port it to an OCapN
  transport, or drop it in favour of Noise-over-WebSocket relays.
- [ ] Confirm the codec (`syrupCodec` vs `cborCodec`) with
  `ocapn-noise-network`.
- [ ] Specify how a per-agent NETS directory configures OCapN
  transports rather than `EndoNetwork` caplets.
- [ ] Coordinate the user-facing locator string format with
  `daemon-locator-terminology`.

## Prompt

> Plan replacing endo daemon external connectivity with ocapn.
> Talking to workers can still use captp, but remote connections
> should use ocapn.

[OCapN]: https://ocapn.org
