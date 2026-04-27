# `@endo/ocapn-noise`

Provides a [Noise Protocol](https://noiseprotocol.org/) netlayer for
`@endo/ocapn`.

The particular Noise Protocol variant is XX-x25519-ChaCha20Poly1305-Blake2 with
Ed25519 signature verification. Each party signs their ephemeral X25519 encryption
public key with their Ed25519 signing key during the handshake, providing
cryptographic proof of ownership of both key pairs.

The implementation of the cryptography is Rust compiled to Web Assembly.
The Rust crate is in the Endo project's repository at `rust/ocapn_noise`.

## Handshake Protocol

The OCapN Noise Protocol uses a 3-message handshake (SYN, SYNACK, ACK) based on
the Noise XX pattern with the following enhancements:

1. **Key Generation**: Each party generates:
   - An ephemeral X25519 key pair for encryption
   - An Ed25519 key pair for signing and verification

2. **Prefixed SYN Message**: The initiator sends:
   - **Cleartext prefix**: The intended responder's Ed25519 public verifying key (32 bytes)
   - **Encrypted payload**:
     - Their Ed25519 public verifying key
     - A signature of their X25519 ephemeral public key using their Ed25519 private key
     - Supported encoding versions

   The cleartext prefix enables relay/hub routing: a relay can read the intended
   recipient and forward the message without being able to decrypt its contents.
   The responder verifies this prefix matches their own public key.

3. **SYNACK Message**: The responder sends:
   - Their Ed25519 public verifying key  
   - A signature of their X25519 ephemeral public key using their Ed25519 private key
   - The negotiated encoding version

4. **ACK Message**: The initiator sends:
   - A final message to conclude the Noise Protocol handshake.

Each party verifies the other's signature to ensure they control both the
ephemeral encryption key and the static signing key, providing strong
authentication and preventing key substitution attacks.

# Aspirational Design

The OCapN JavaScript netlayer interface is intended to be as near to platform-
neutral as possible and makes extensive use of language level utilities like
promises and async iterators in order to avoid coupling to platform-specific
features like event emitters or event targets.

This OCapN Noise Protocol netlayer is also intended to stand atop multiple
transport layers, but particularly WebSocket.
Having a single cryptography over multiple transport protocols allows this
OCapN netlayer to preserve the identities of message targets regardless of what
transport capabilities are available on various platforms, such that client,
server, cloud, edge, and any other kind of peer can join the network.

# Using the `np` network

`makeOcapnNoiseNetwork` starts empty: add signing keys and transports at
any point during the network's lifetime. One network can carry many
Ed25519 identities concurrently and route inbound sessions to whichever
local key the initiator's SYN is addressed to.

Everything below the API uses `@endo/stream` `Reader<Uint8Array>` and
`Writer<Uint8Array>` — transports, session bytes, and the internal
Noise handshake machinery. The Noise WASM module is loaded through a
platform-conditional export (`./platform`), so callers don't pass it in.

The `np` locator's `designator` is the hex-encoded raw Ed25519 public
key (64 chars). An initiator learns the peer's identity up front from
the locator itself — no extra hint, no out-of-band step.

Transport plugins:

- `@endo/ocapn-noise/transport/mock` — in-process pair for tests.
- `@endo/ocapn-noise/transport/tcp` — Node `net` via `@endo/stream-node`.
- `@endo/ocapn-noise/transport/ws` — `WebSocket`; resolves to a Node
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
// `ocapn://<keyId>.np?tcp:host=…&tcp:port=…`.
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
