# OCapN-Noise Network

| | |
|---|---|
| **Created** | 2026-02-14 |
| **Updated** | 2026-08-28 |
| **Author** | Kris Kowal (prompted) |
| **Status** | **Complete** |

## Status

**Complete** (shipped 2026-05-07 via PR #137 / merge commit
`6a5aecd01` on `llm`; the merge was authored 2026-05-07 and the
README's "merged 2026-05-08" reflects the GitHub merge-event timestamp
in a later timezone).

Shipped on `llm` via PR
[#137](https://github.com/endojs/endo-but-for-bots/pull/137), which
consolidated the previously stacked PRs #111 (CBOR codec +
NonceLocator), #112 (Noise IK netlayer), and #113 (integration +
transport tests) into a single landing of the Noise IK netlayer for
OCapN.

### Roadmap calibration (per `git blame` on `llm`)

- Active development: 2025-09-16 → 2026-05-07 (~233 days, calendar;
  the work spans upstream cryptography work, design ratification, and
  bot-fork consolidation, with long unattended gaps).
- Design phase: 2026-02-14 → 2026-02-28 (15 days, calendar). Design
  doc first add `840c2e422` 2026-02-14; later edits `52bc71d6e`
  2026-02-24 and `0ee0cbb3c` 2026-02-28.
- Implementation phase:
  - Upstream cryptography precursor: 2025-09-16 (`e7c0ab850`,
    "Initial cryptography for an OCapN Noise Protocol netlayer") →
    2025-09-25 (`81fe90018`).
  - Bot-fork consolidation: 2026-05-07 (`9403bfa84` codec injection,
    `1874c9002` browser-portable netlayer, `f0677cf85` integration
    tests, all under PR #59; merged into `llm` via PR #137 /
    `6a5aecd01` the same day).

> **See also**: [ocapn-noise-session-reconnect](ocapn-noise-session-reconnect.md)
> amends this design with a meta-TCP session layer (heartbeat, transparent
> reconnect, Noise sequence continuity across TCP instances) per the
> 2026-05-14 maintainer directive relaying erights' framing.

## What is the Problem Being Solved?

The `@endo/ocapn-noise` package (v0.1.0) currently provides Noise Protocol
cryptographic bindings (`packages/ocapn-noise/src/bindings.js`) but does not
implement a full OCapN network. It provides the handshake primitives
(`asInitiator`, `asResponder`, `initiatorWriteSyn`, `responderReadSynWriteSynack`,
etc.) and encryption/decryption functions, but:

1. There is no `OcapnNetwork` implementation that plugs into the OCapN client.
2. There is no transport layer abstraction — no WebSocket or TCP transport that
   carries the Noise handshake bytes.
3. The handshake is tightly coupled to raw byte arrays with no transport framing.
4. Connection hints don't encode transport selection.

OCapN-Noise needs to become a proper network, designated by `"np"`, that accepts
pluggable transports and integrates with the OCapN client via the `OcapnNetwork`
interface (from the network-transport-separation work item).

## Description of the Design

### Network Identifier

OCapN-Noise is designated by `"np"` in locators. Connection hints are
`@`-delimited path components of the form
`<transport>+<codec>:<host>:<port>[<path>]` — **not** query parameters.
The query string is reserved for alleged attributes such as `type`. The
hints are a **priority-ordered list**, most-preferred first, and a node
may advertise **several hints per transport-and-codec pair** — one per
link-layer address it is reachable on — so a peer can dial whichever it
can reach (the hints are shown wrapped across lines here for clarity):

```
endo://<designator>.np/
  @wss+cbor:gateway.example.com:443/ocapn-cbor-np
  @wss+syrup:gateway.example.com:443/ocapn-cbor-np
  @tcp+cbor:[2001:db8::1]:3469
  @tcp+cbor:198.51.100.7:3469
  @tcp+syrup:[2001:db8::1]:8920
```

The URL scheme shown here is the illustrative `endo:` scheme, **not**
`ocapn:` — we do not front-run consensus on a registered `ocapn:` URL
scheme. The protocol family is still OCapN and the network is still
designated `np`; only the example locator's scheme is `endo:`. Note the
**two** `tcp+cbor` hints above: an IPv6 and an IPv4 address for the same
transport-and-codec pair, IPv6 first (§ Transport Hint Format).

The `designator` is derived from the node's Ed25519 public key (as it is
today — double-SHA256 hash of the serialized public key descriptor).

### Transport Plugin Architecture

A transport plugin provides a way to establish a bidirectional byte stream.
The network uses that byte stream to run the Noise Protocol handshake and
subsequent encrypted messaging.

```js
/**
 * @typedef {object} OcapnNoiseTransport
 * @property {string} scheme - Transport scheme (e.g., 'ws', 'tcp'),
 *   matched against a dial URL's scheme to select this transport.
 * @property {(hint: string) => Promise<ByteStream>} connect
 *   Open an outgoing byte stream, given a single self-describing dial-URL
 *   hint (one entry from a peer's ordered hint list, already matched to
 *   this transport's scheme).
 * @property {(handler) => Promise<TransportListener>} listen
 *   Start listening for incoming byte stream connections. The returned
 *   `TransportListener.hints` is a **priority-ordered list** of
 *   self-describing dial-URL strings (empty = advertise nothing).
 * @property {() => void} shutdown
 */

/**
 * @typedef {object} ByteStream
 * @property {(bytes: Uint8Array) => void} write
 * @property {() => void} end
 * @property {AsyncIterable<Uint8Array>} incoming
 */
```

### Transport Hint Format

Each connection hint is an `@`-delimited path component of the form
`<transport>+<codec>:<host>:<port>[<path>]` — **not** a query parameter (the
query string is reserved for alleged attributes such as `type`). The
`<transport>+<codec>` **prefix** encodes both the transport protocol and the
message codec, joined with `+`, and the `<host>:<port>` authority to dial (with
an optional trailing `<path>` for endpoints that need one — see WebSocket
below) follows the first `:` separator. `<transport>` names a byte-stream
carrier (`wss`, `ws`, `tcp`) and `<codec>` the OCapN message serialization
(`cbor`, `syrup`), so a peer can pick both a transport it can dial and a codec
it can speak:

| Hint | Example | Meaning |
|------|---------|---------|
| `wss+cbor:<host>:<port><path>` | `wss+cbor:gateway.example.com:443/ocapn-cbor-np` | WebSocket-Secure endpoint at `<path>`, CBOR-framed messages |
| `wss+syrup:<host>:<port><path>` | `wss+syrup:gateway.example.com:443/ocapn-cbor-np` | WebSocket-Secure endpoint at `<path>`, Syrup-framed messages |
| `tcp+cbor:<host>:<port>` | `tcp+cbor:[2001:db8::1]:3469` | TCP endpoint, CBOR-framed messages |
| `tcp+syrup:<host>:<port>` | `tcp+syrup:198.51.100.7:8920` | TCP endpoint, Syrup-framed messages |

**WebSocket hints carry a path.** A WebSocket endpoint is
`wss://host:port/<path>`, so the `wss`/`ws` hint forms include a trailing
`<path>` component after the authority. The canonical path is
**`/ocapn-cbor-np`** — the OCapN-over-CBOR-on-`np` endpoint the gateway serves
(`designs/gateway-package.md` § Feature 8), so a `*.minion.town` weblet
gateway and a directly-advertised node speak the same URL. IPv6 literals in a
hint are bracketed (`[2001:db8::1]`) so the dial URL round-trips through
`new URL()`.

The same endpoint may appear under several codecs (as `wss+cbor` and
`wss+syrup` do above); the transport carries whichever codec both peers
support. **Multiple hints per protocol are allowed:** one host may advertise a
`tcp+cbor` for each of its link-layer addresses (an IPv6 *and* an IPv4). When
connecting, the network walks the advertised hints **in priority order**,
skipping any whose transport it cannot dial or codec it cannot speak, and
connects with the first it can — trying the next if that one fails.

#### Why a location carries multiple hints

A location advertises **multiple hints**, for two independent reasons:

1. **One hint per transport-and-codec combination** (a `wss+cbor` *and* a
   `tcp+cbor`, for example) so a connecting daemon can **filter the list down
   to the transports it can actually implement on its platform** (and the
   codecs it can speak). These are not redundant addresses for the same door;
   they are distinct doors, and different peers can open different ones.
2. **Several hints for the same transport-and-codec pair**, one per **link-layer
   address** the node is reachable on. A host with both an IPv6 and an IPv4
   address advertises a `tcp+cbor` hint for each, **IPv6 first**: a global IPv6
   address is unlikely to collide across networks and is relay-free on a
   partitioned LAN, so it is preferred, with the IPv4 address as a fallback for
   peers that cannot route IPv6.

**Prefer omitting a hint to advertising loopback.** A node bound to a wildcard
address (`0.0.0.0` / `::`) enumerates its **routable** interface addresses
(non-internal), advertises them IPv6-first, and — if it has none — advertises
**nothing** for that transport rather than a `127.0.0.1` / `::1` address a peer
cannot dial. A node bound to a specific host advertises that host as chosen.

**Public-IP discovery is pluggable.** The default advertised set is interface
enumeration as above; a node behind NAT can inject a discovery seam (e.g. a
STUN probe or a reflector) whose results are folded into the priority list.
The transports ship only the plug point, not any discovery mechanism.

The web platform is the motivating constraint for reason (1):

- It **cannot** open a direct TCP connection — the lightest of the transports,
  with the least redundant cryptography (the Noise handshake already
  authenticates and encrypts, so a raw TCP hint carries no TLS overhead).
- It **cannot** open a raw HTTP WebSocket; it needs the secured (`wss:`) path.
- For TLS it depends on **both** DNS **and** a certificate authority.
- A raw IPv6 literal is **not viable** from the web at all.

By contrast, a raw IPv6 TCP hint is valuable to peers that *can* dial it: it
**does not require a relay** when the two peers are on the same LAN, **even if
that LAN is partitioned from the internet**. Advertising it alongside a
web-reachable hint lets a LAN-local peer take the direct, relay-free path while
a browser peer falls back to a transport it supports.

We expect to introduce **relay hints** as a further transport kind, so that
transports can **race to connect** — speculative connection, opening several
candidate paths at once and keeping whichever completes first.

### Concrete Transport Implementations

#### `ocapn-noise-websocket`

- Uses the WebSocket API (browser-compatible).
- Noise handshake bytes are sent as binary WebSocket messages.
- Each encrypted OCapN message is a single WebSocket binary frame.
- No additional framing needed — WebSocket provides message boundaries.

#### `ocapn-noise-tcp`

- Uses Node.js `net` module.
- Noise handshake bytes are sent as raw TCP.
- Encrypted OCapN messages are framed with **netstrings**
  (`@endo/netstring`) to provide message boundaries over the TCP byte stream.
- The handshake phase uses fixed-length messages (SYN: 164 bytes, SYNACK: 193
  bytes, ACK: 64 bytes per `packages/ocapn-noise/src/bindings.js`) so netstring
  framing is only needed for the post-handshake encrypted message phase.

### Network Implementation

```js
const makeOcapnNoiseNetwork = async ({ signingKeys, transports, handlers }) => {
  // 1. Generate or accept Ed25519 signing keys
  // 2. Register transport plugins
  // 3. Start listeners on all transports
  // 4. Return OcapnNetwork interface

  return harden({
    identifier: 'np',
    location: { type: 'ocapn-peer', network: 'np', designator, hints },

    async connect(remoteLocation) {
      // a. Select transport from remote hints
      // b. Open byte stream via transport.connect(hints)
      // c. Run Noise XX handshake as initiator:
      //    - Write SYN (prefixed with intended responder key)
      //    - Read SYNACK, validate responder identity
      //    - Write ACK
      // d. Obtain encrypt/decrypt functions from completed handshake
      // e. Return NetworkSession with encrypted write/read
    },

    shutdown() { /* close all listeners and connections */ },
  });
};
```

### Session Establishment

The Noise handshake replaces `op:start-session` entirely:

1. **Initiator** opens a byte stream via the selected transport.
2. **Initiator** writes the SYN message (164 bytes): intended responder's
   Ed25519 public key (32 bytes) + Noise XX first message (132 bytes).
3. **Responder** reads SYN, verifies it's intended for them, writes SYNACK
   (193 bytes): contains responder's Ed25519 public key, encoding negotiation,
   signature.
4. **Initiator** reads SYNACK, verifies responder identity and signature,
   writes ACK (64 bytes).
5. Both sides now have `encrypt` and `decrypt` functions (ChaCha20-Poly1305).
6. The `NetworkSession` is delivered to OCapN core. All subsequent CapTP
   messages are encrypted.

No `op:start-session` is sent. The Noise handshake provides:
- Mutual authentication (both parties prove possession of their Ed25519 keys).
- Key agreement (ephemeral x25519 keys negotiated by Noise).
- Encryption (ChaCha20-Poly1305 from the Noise session).
- Encoding negotiation (piggybacked on SYNACK per current implementation).

### Package Structure

```
packages/
  ocapn-noise/          # Existing: Noise Protocol bindings (WASM + JS)
    src/bindings.js     # Handshake state machine, encrypt/decrypt
  ocapn-noise-network/  # New: OCapN-Noise network implementation
    src/
      network.js        # makeOcapnNoiseNetwork
      transport.js      # Transport plugin interface
  ocapn-noise-ws/       # New: WebSocket transport plugin
    src/index.js
  ocapn-noise-tcp/      # New: TCP + netstring transport plugin
    src/index.js
```

Alternatively, the transport plugins could be subdirectories of
`ocapn-noise-network` if separate packages feel like over-modularization.

### Affected Packages

- `packages/ocapn-noise` — no changes (bindings are consumed as-is)
- `packages/ocapn-noise-network` (new) — network implementation
- `packages/ocapn-noise-ws` (new) — WebSocket transport
- `packages/ocapn-noise-tcp` (new) — TCP transport using `@endo/netstring`
- `packages/ocapn` — must support the `OcapnNetwork` interface (from
  network-transport-separation work item)

### Dependencies

- **ocapn-network-transport-separation** — provides the `OcapnNetwork` interface
  and registration mechanism.
- **ocapn-tcp-for-test-extraction** — moves `op:start-session` out of core so
  OCapN-Noise doesn't inherit it.

## Security Considerations

- The Noise Protocol (XX pattern) provides strong forward secrecy and mutual
  authentication. This is a significant security improvement over tcp-for-test.
- Encrypted messages have a max size of 65535 - 16 = 65519 bytes (ChaCha20-Poly1305
  with 16-byte auth tag). Larger OCapN messages must be chunked. This limit
  should be documented.
- Transport-level security (e.g., WSS/TLS for WebSocket) is defense-in-depth
  but not required — Noise provides its own encryption layer.
- The intended-responder-key prefix on SYN prevents misdirected connections.

## Scaling Considerations

- Each transport listener is a separate server socket. Running multiple
  transports multiplies the number of listening ports.
- The Noise handshake adds 3 round-trips (SYN, SYNACK, ACK) before CapTP
  messages can flow. This is comparable to TLS.
- Encryption/decryption overhead is minimal (ChaCha20-Poly1305 is fast).

## Test Plan

- Unit test: `makeOcapnNoiseNetwork` with a mock transport completes the
  handshake and returns encrypted sessions.
- Integration test: two OCapN-Noise peers connect over TCP transport, exchange
  CapTP messages.
- Integration test: two OCapN-Noise peers connect over WebSocket transport.
- Integration test: peer with both transports connects to peer with only one.
- Cross-network test: OCapN-Noise peer cannot connect to tcp-for-test peer
  (different network identifiers, incompatible handshakes).

## Compatibility Considerations

- This is a new network. No existing wire compatibility to maintain.
- The `"np"` network identifier must be registered with the OCapN spec group.
- The Noise handshake byte format is already defined in
  `packages/ocapn-noise/src/bindings.js` and should be stable.

## Upgrade Considerations

- The daemon will need a new formula type or configuration to enable the
  OCapN-Noise network alongside or instead of the existing loopback/test
  networks.
- Peers using tcp-for-test cannot communicate with peers using OCapN-Noise.
  Migration requires both sides to upgrade.
