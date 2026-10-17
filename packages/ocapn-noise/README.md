# `@endo/ocapn-noise`

Provides a [Noise Protocol](https://noiseprotocol.org/) netlayer for
`@endo/ocapn`.

The particular Noise Protocol variant is
**`Noise_IK_25519_ChaChaPoly_BLAKE2s`**.
Each peer publishes a single Ed25519 long-term identity; the X25519
keypair Noise needs is derived deterministically from the Ed25519 seed
via the Edwards-to-Montgomery birational map (the libsodium / age /
wireguard-tools convention).
A successful Noise DH against the published Ed25519 identity already
proves control of the corresponding signing key, so no per-message
Ed25519 signature appears inside the handshake.

The implementation of the cryptography is Rust compiled to Web
Assembly.
The Rust crate is in the Endo project's repository at
`rust/ocapn_noise`.

## Handshake Protocol

Noise IK is a two-message handshake.
The initiator already knows the responder's static public key
(its Ed25519 identity, converted to X25519), which exactly matches
OCapN's dial-by-identity model.
The responder learns the initiator's static through the encrypted
first message.

1. **Prefixed SYN (initiator to responder)**:
   - **Cleartext prefix**: the intended responder's Ed25519 verifying
     key (32 bytes).
     This enables relay and hub routing: a relay can read the intended
     recipient and forward the message without being able to decrypt
     its contents.
     The responder verifies the prefix matches its own published key.
   - **Noise IK message 1**: ephemeral X25519 public key, encrypted
     initiator static, and an encrypted payload carrying the
     initiator's Ed25519 verifying key and the supported encoding
     versions.
     Identity hiding (Noise §7.8 property 4): the initiator's static
     is encrypted on the wire under the responder's static, without
     forward secrecy.
     The verifying key in the payload is only a claim, so the
     responder rejects the SYN unless that key converts to the static
     X25519 key the initiator actually used in the handshake, and has
     no small-order component.
     Without this check, an initiator holding any keypair could claim
     any identity.
     The Edwards-to-Montgomery conversion drops the sign of x, so the
     holder of key A can also claim -A: a second identity for the same
     key holder, not an impersonation.
     Message 1 carries no freshness (Noise §7.7 destination property
     2), so anyone who has seen a genuine SYN can replay it.
     A replay never becomes a session, because it cannot produce the
     channel-bound `op:start-session` below.
     Displacing the named peer's existing (unclaimed) session is deferred
     until `op:start-session` verifies, so a replay cannot close it.
     A replay can still occupy a crossed-hello settlement slot for the
     peer — that slot is needed so two genuine simultaneous dials
     converge on one session — but once no local dial to the peer is in
     flight and either a handshake has proven or a caller is waiting,
     settlement waits at most one more handshake timeout for the rest.
     A sustained replay can therefore delay a dial by at most that much,
     and cannot keep a failed dial's caller waiting.
     The same bound means a genuine crossed hello whose second direction
     takes longer than a handshake timeout to prove is settled without
     it, which can leave the two sides on different sessions.
     Total pre-`op:start-session` work is bounded by a cap on concurrent
     inbound handshakes per local (responder) identity
     (`maxInProgressPerLocalKey`).
     When the cap is full, a new SYN evicts the oldest unproven handshake
     rather than being dropped, so a flood of stalled handshakes cannot
     lock a genuine peer out.
     The costs are that every SYN in a flood is now decrypted (one
     X25519 operation each) before it evicts another, and that a flood
     fast enough to cycle the whole cap within one round trip can still
     starve a dial.

2. **SYNACK (responder to initiator)**:
   - **Noise IK message 2**: responder ephemeral, encrypted payload
     carrying the negotiated encoding version.
     Reading SYNACK finalizes the handshake on the initiator side and
     exposes the transcript hash for channel binding.
     There is no message 3 (ACK).

### Prologue

Both peers feed the same prologue bytes into Noise's symmetric state
before any wire message is exchanged:

```
prologue = b"OCapN/np/1\0" || INTENDED_RESPONDER_KEY (32B Ed25519)
```

The prologue commits the handshake to the OCapN protocol identifier
plus the responder's published Ed25519 verifying key, so an attacker
cannot replay a handshake payload across protocols or against a
different responder.
A successful handshake binds the channel to the responder identity
the initiator dialed.

### Channel-bound location signature

Once the handshake completes, each peer exchanges its
`op:start-session` over the encrypted tunnel.
The location signature in `op:start-session` carries the Noise
transcript hash as a channel-binding value, so it cannot be replayed
across sessions even though it is signed only once per identity.

## Wire contract

This section is the contract a second implementation of `np/1` must
match.
The rationale is in the project's
`designs/ocapn-noise-cryptographic-review.md`.
"Must" and "must not" are normative.

### Protocol and keys

- The Noise protocol name is `Noise_IK_25519_ChaChaPoly_BLAKE2s`.
- The prologue is the 10 ASCII bytes `OCapN/np/1`, one zero byte, and
  the intended responder's 32-byte Ed25519 verifying key.
- Each peer's static X25519 private key is the clamped first half of
  `SHA-512(seed)`, where `seed` is its 32-byte Ed25519 seed (the scalar
  Ed25519 signs with).
  Its static X25519 public key is the Montgomery form of its Ed25519
  verifying key, `u = (1 + y) / (1 - y)`.
  There is no separate bonding signature between the two keys.

### Message layouts

Each message below is one transport frame.
Lengths are in bytes, and multi-byte integers are big-endian.

| Message | Layout | Length |
|---|---|---|
| Prefixed SYN | responder Ed25519 key (32, cleartext) \|\| Noise message 1 (132) | 164 |
| Noise message 1 | `e` (32) \|\| encrypted `s` (32 + 16 tag) \|\| encrypted SYN payload (36 + 16 tag) | 132 |
| SYN payload | initiator Ed25519 key (32) \|\| first encoding (2) \|\| further-encodings mask (2) | 36 |
| SYNACK (Noise message 2) | `e` (32) \|\| encrypted SYNACK payload (1 + 16 tag) | 49 |
| SYNACK payload | accepted encoding (1) | 1 |
| Transport message | ChaCha20-Poly1305 ciphertext of at most 65519 plaintext bytes, plus a 16-byte tag | at most 65535 |

In the encoding offer, bit `i` of the mask means the initiator also
supports encoding `first + i + 1`.
The responder accepts the highest encoding both sides support.
Transport messages use the Noise `CipherState` nonces, counting up from
zero in each direction.
The handshake has no third message.
The whole handshake is 213 bytes and one round trip.

### Key checks

- An initiator must reject a responder key that is small-order or
  carries a torsion component before it sends anything.
  A weak responder static zeroes the `es` and `ss` Diffie-Hellman
  results.
- A responder must drop a SYN whose cleartext prefix is not one of its
  own keys.
- A responder must reject a SYN whose claimed initiator Ed25519 key is
  small-order, carries a torsion component, or does not convert to the
  static X25519 key Noise authenticated (`rs`).
- The conversion to Montgomery form drops the sign of x.
  The holder of key `A` can therefore also present `-A`, and sign as
  `-A`, because signing needs only the scalar.
  `A` and `-A` are two designators for one key holder.
  Neither lets anyone impersonate a key they do not hold, but an
  implementation must not assume that one key holder has only one
  designator.

### Handshake hash and channel binding

The handshake hash is the 32-byte Noise `h` after message 2.
Each peer's `op:start-session` location signature covers

```text
"ocapn-location-v1\0" || uint32(len(h)) || h || my-location
```

where `my-location` is the codec-serialized `my-location` record.
On `np/1` the binding is always the 32-byte `h`; it must never be
empty.

### Key confirmation

Noise IK message 1 authenticates its sender only weakly (Noise §7.7
source property 1).
Anyone who holds the responder's private key can forge a SYN that
claims any initiator (key-compromise impersonation), and anyone who
has seen a SYN can replay it.
Neither can compute the transport keys, because both lack the claimed
initiator's private key.

- A responder **must not** treat an initiator as authenticated until it
  has decrypted and verified that initiator's `op:start-session`, the
  first transport message.
  Until then it must not hand out a session, resolve crossed hellos in
  that peer's favor, or displace an existing session with that peer.
- An initiator **must not** send application data in message 1.
  The SYN payload carries only the initiator's key and the encoding
  offer: it can be forged by a holder of the responder's key, it can be
  replayed, and it loses its secrecy if the responder's key later
  leaks.
  There is no 0-RTT `op:start-session`.

# Aspirational Design

The OCapN JavaScript netlayer interface is intended to be as near to
platform-neutral as possible and makes extensive use of language
level utilities like promises and async iterators in order to avoid
coupling to platform-specific features like event emitters or event
targets.

This OCapN Noise Protocol netlayer is also intended to stand atop
multiple transport layers, but particularly WebSocket.
Having a single cryptography over multiple transport protocols
allows this OCapN netlayer to preserve the identities of message
targets regardless of what transport capabilities are available on
various platforms, such that client, server, cloud, edge, and any
other kind of peer can join the network.

# Using the `np` network

`makeOcapnNoiseNetwork` starts empty: add signing keys and transports
at any point during the network's lifetime.
One network can carry many Ed25519 identities concurrently and route
inbound sessions to whichever local key the initiator's SYN is
addressed to.

Everything below the API uses `@endo/stream` `Reader<Uint8Array>` and
`Writer<Uint8Array>` (transports, session bytes, and the internal
Noise handshake machinery).
The Noise WASM module is loaded through a platform-conditional export
(`./platform`), so callers don't pass it in.

The `np` locator's `designator` is the hex-encoded raw Ed25519 public
key (64 chars).
An initiator learns the peer's identity up front from the locator
itself: no extra hint, no out-of-band step.
`provideSession` requires the designator to be canonical lowercase hex
(`/^[0-9a-f]{64}$/`) and rejects a weak (small-order or torsion-carrying)
key: a weak responder static zeroes the `es`/`ss` Diffie-Hellman results,
which would forfeit identity hiding and let a party holding no keys
complete the handshake.

Transport plugins:

- `@endo/ocapn-noise/transport/mock`: in-process pair for tests.
- `@endo/ocapn-noise/transport/tcp`: Node `net` via
  `@endo/stream-node`.
- `@endo/ocapn-noise/transport/ws`: `WebSocket`; resolves to a Node
  variant today, with a browser variant planned via the same subpath.

```js
import { cborCodec } from '@endo/ocapn/cbor';
import { makeOcapnNoiseNetwork } from '@endo/ocapn-noise';
import { makeTcpTransport } from '@endo/ocapn-noise/transport/tcp';

const network = makeOcapnNoiseNetwork({ codec: cborCodec });

// Mint and register an identity.
const keys = network.generateSigningKeys();
const keyId = network.addSigningKeys(keys);

// Register one or more transports. Adding a transport that supports
// `listen` immediately starts accepting inbound sessions.
await network.addTransport(makeTcpTransport());

// Hand peers our location; they reach us at
// `ocapn://<keyId>.np?tcp:host=...&tcp:port=...`.
const myLocation = network.locationFor(keyId);

// Initiate on behalf of a specific identity.
const session = await network.provideSession(peerLocation, {
  localKeyId: keyId,
});
await session.writer.next(new TextEncoder().encode('hello'));
```

Both peers must share the same OCapN wire codec; the Noise handshake
provides mutual Ed25519 authentication but leaves codec selection to
the embedding application.
