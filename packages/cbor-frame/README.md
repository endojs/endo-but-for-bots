# cbor-frame

This package implements asynchronous streams framed as a sequence of
CBOR byte strings, each wrapped in the [CBOR tag 24][rfc8949-tag24]
(Encoded CBOR data item).
A frame is the two-byte tag-24 prefix `d8 18`, followed by a
[CBOR major-type-2 (byte string) head][rfc8949] naming the
payload length, followed by the payload bytes themselves.
For example, the frame `d8 18 45 68 65 6c 6c 6f` (hex) corresponds to
the message `hello`, where `d8 18` is "tag 24", `0x45` is "byte string
of length 5", and `68 65 6c 6c 6f` is the payload.

The package is deliberately **not** a CBOR codec.
It implements only the major-type-2 head grammar wrapped in
CBOR tag 24 ("Encoded CBOR data item") so that a stream of
length-prefixed binary payloads can be carried over a byte transport
in a self-describing, audit-friendly framing.
Consumers that want to carry structured CBOR encode or decode the
payload bytes themselves with whatever CBOR codec they prefer.

`@endo/cbor-frame` is a sibling to `@endo/netstring` (Bernstein
netstrings), `@endo/lp32` (32-bit host-byte-order length-prefixed
framing, used by WebExtension Native Messaging), and the proposed
`@endo/syrup-frame` (Syrup byte-string framing).
Each names a different on-the-wire grammar for length-prefixed byte
strings.
The four are peers: taking a dependency on one of them does not
entrain a dependency on any of the others.

## Usage

```js
import { makeCborFrameReader, makeCborFrameWriter } from '@endo/cbor-frame';
import { makePipe } from '@endo/stream';

const [input, output] = makePipe();
const writer = makeCborFrameWriter(output);
const reader = makeCborFrameReader(input);

const enc = new TextEncoder();
await writer.next(enc.encode('hello'));
await writer.next(enc.encode('A'));
await writer.return();

const dec = new TextDecoder();
for await (const bytes of reader) {
  console.error(dec.decode(bytes));
}
// hello
// A
```

## Wire format

The wire is a concatenation of tag-24-wrapped CBOR byte strings.
Each frame is:

- **Tag-24-wrapped byte string.**
  Major type 6 (tagged) with argument 24 (Encoded CBOR data item;
  [RFC 8949 § 3.4.5.1][rfc8949-tag24]), encoded as the two bytes
  `0xd8 0x18`, followed by a plain CBOR byte string: major type 2
  with an argument naming the payload length, then the payload bytes.
  The argument follows CBOR's standard short forms: 0 through 23
  inline in the initial byte; 24/25/26/27 followed by 1, 2, 4, or 8
  length bytes (big-endian).

The tag-24 wrapper is mandatory.
At a fixed two-byte per-frame cost it makes each frame's *boundary*
self-describing: a generic CBOR-aware analyzer reads the tag-24
byte-string head and can therefore locate each frame and its length
without knowing this framing.
The payload itself is opaque: tag 24 is used here only as a framing
marker, not as a promise that the payload is a well-formed encoded
CBOR data item (it often is not — for example a Syrup-encoded OCapN
message), so an analyzer must not assume it can descend into the
payload and continue parsing.
The reader rejects any initial byte other than the tag-24 prefix, any
major type other than 2 inside the wrapper, any tag other than 24,
any reserved additional-info value (28-30), and any indefinite-length
form.
This is intentional: a stricter reader catches misframed input earlier
and gives a clearer error than a permissive one.
The reader does, however, accept a non-canonical (overlong) length
encoding, so a given payload length has more than one valid wire head.
That is harmless for pure framing but means the wire bytes must not be
treated as a canonical digest of the message; canonicalize before
hashing or comparing raw frame bytes.

## Streams

This implementation relies particularly on a pure JavaScript notion
of a stream, using async iterators of `Uint8Array`s.
By convention, these may be ranges of a ring buffer, so a stream owns
a byte range it receives from `next` until the next time it calls
`next`.

[rfc8949]: https://www.rfc-editor.org/rfc/rfc8949.html
[rfc8949-tag24]: https://www.rfc-editor.org/rfc/rfc8949.html#section-3.4.5.1
