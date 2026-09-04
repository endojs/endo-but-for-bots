# `@endo/ocapn`

A tentative implementation of the [OCapN][] (Object Capability Network)
protocol for Hardened JavaScript.
The OCapN specification remains a moving target and this package provides few
guarantees of future compatibility.
This is a testbed for building specification consensus and early discovery
of specification questions.

## Overview

OCapN is a protocol for secure distributed object programming.
It enables networked programming with the convenience of calling methods on
remote objects, much like local asynchronous programming.

This package provides:

- **CapTP**: The Capability Transport Protocol, the core message-passing
  layer of OCapN.
  See also the related [`@endo/captp`](../captp/README.md) package for a
  minimal CapTP implementation.
- **Wire codecs**: Two interchangeable encodings for OCapN messages,
  [Syrup][] and CBOR (per RFC 8949).
  The OCapN standards group has not yet settled on a single encoding;
  a client selects one at construction time and both peers must agree
  out-of-band (there is no on-the-wire negotiation).
  See [`docs/codec-usage.md`](./docs/codec-usage.md) for details.
- **Netlayer interface**: An abstraction for transport layers, allowing CapTP
  to operate over various network protocols.
- **Third-party handoffs**: Cryptographic mechanisms for securely transferring
  object references between peers.

For more information about the protocol, see [ocapn.org][OCapN].

## Quick start

```js
import { makeOcapn } from '@endo/ocapn';
import { syrupCodec } from '@endo/ocapn/syrup';
// or: import { cborCodec } from '@endo/ocapn/cbor';
import { makeOcapnNoiseNetwork } from '@endo/ocapn-noise';

// `locator` is the caller-owned table of locally-held capabilities.
// A plain `Map` works; anything implementing
// `get(secret) → value | Promise<value> | undefined` does too.
const locator = new Map();

const network = makeOcapnNoiseNetwork({ codec: syrupCodec });
// Add at least one signing key + transport before calling
// `provideSession` or accepting peer connections.

const ocapn = await makeOcapn({
  codec: syrupCodec,
  network,
  locator,
});
```

Both `codec` and `network` are required: the codec choice is not negotiated
on the wire (both peers must agree out-of-band), and the network is the
single concrete pluggable that `makeOcapn` runs against. Import
`syrupCodec` from `@endo/ocapn/syrup` or `cborCodec` from `@endo/ocapn/cbor`,
and pair it with a network whose `codec` matches.

### Per-session locators

By default every session shares the one injected `locator`. To scope a
peer's incoming `bootstrap.fetch` resolution to that authenticated peer —
so miss counters or rate limits cannot leak across peers — pass an
optional `makeLocatorForSession` factory alongside `locator`:

```js
const ocapn = await makeOcapn({
  codec: syrupCodec,
  network,
  locator, // still used for the daemon's own outgoing SturdyRef resolution
  makeLocatorForSession: ({ remoteDesignator, abortSession }) => {
    // Return a fresh `NonceLocator` for this session. `remoteDesignator`
    // is the peer's *claimed* designator; it is transport-authenticated
    // only when the netlayer supplies `verifyPeerLocation` (e.g. iroh's
    // QUIC-verified EndpointId), and is otherwise self-asserted and
    // therefore spoofable — so durable per-peer accounting should key on
    // the session's verified public key (`getPeerPublicKeyForSessionId`),
    // not on `remoteDesignator`. `abortSession()` severs this session — a
    // locator that has seen too many misses can call it to enforce a
    // per-session bound without revealing which presentation crossed it.
    return makeMyPerSessionLocator({ remoteDesignator, abortSession });
  },
});
```

`@endo/daemon`'s `makeFormulaNonceLocator` (from
`@endo/daemon/formula-nonce-locator.js`) is a ready-made pairing: the object
it returns is itself a `NonceLocator` (pass it as the shared `locator`), and
its `makeLocatorForSession` supplies this hook, bounding each session's failed
presentations against a formula-identifier oracle.

## Status

This package is a work in progress and is not yet published to npm.
The API is subject to change.

## Wire codecs

OCapN messages are carried on the wire in a canonical binary encoding.
This package ships two complete, interchangeable codecs behind a common
`OcapnCodec` interface:

- [Syrup][] (`@endo/ocapn/syrup`): text-delimited canonical format, OCapN's
  original wire form. See the [Syrup codec README](./src/syrup/README.md) for
  the supported type table and implementation notes.
- CBOR (`@endo/ocapn/cbor`): RFC 8949 canonical CBOR with OCapN-specific
  tags. See the [CBOR codec README](./src/cbor/README.md) and
  [`docs/cbor-encoding.md`](./docs/cbor-encoding.md).

The codec you pass to `makeOcapn` determines the wire format for every byte
that crosses the session: handshake frames, operation messages, and the
canonical bytes signed by handoff/location signatures. Two peers that chose
different codecs cannot interoperate; codec choice is not negotiated.
See [`docs/codec-usage.md`](./docs/codec-usage.md) for the full injection
pattern and the `OcapnCodec` interface.

## Architecture

The package is organized in layers, from high to low:

1. **Client** (`src/client/`): Session management, handoffs, sturdy references
2. **CapTP** (`src/captp/`): Message dispatch and slot management
3. **Codecs** (`src/codecs/`): Syrup encoding, descriptors, and operations
4. **Netlayer** (`src/netlayers/`): Network and transport abstraction

## Related Packages

- [`@endo/captp`](../captp/README.md): A minimal CapTP implementation using
  JSON encoding, suitable for simpler use cases.
- [`@endo/marshal`](../marshal/README.md): Serialization of passable objects.
- [`@endo/eventual-send`](../eventual-send/README.md): The `E()` proxy for
  asynchronous message passing.
- [`@endo/ocapn-noise`](../ocapn-noise/README.md): Cryptographic utilities
  for an OCapN network based on [Noise Protocol][].

## License

[Apache-2.0](./LICENSE)

[OCapN]: https://ocapn.org
[Syrup]: https://github.com/ocapn/syrup
[Noise Protocol]: https://noiseprotocol.org/
