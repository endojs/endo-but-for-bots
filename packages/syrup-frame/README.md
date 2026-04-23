# @endo/syrup-frame

`@endo/syrup-frame` implements an async-iterator protocol for framing
binary messages as a length-prefix followed by a payload, with **no
trailing separator**.

It is a sibling of [`@endo/netstring`][netstring] whose only difference
is the absence of the trailing `,` separator.
The grammar is:

```
frame   = length ":" payload
length  = 1*DIGIT
payload = length * OCTET
```

A framed message on the wire is therefore literally a Syrup byte-string
record — identical to Syrup's `<length>:<bytes>` grammar.
This is the whole motivation for the package: OCapN transports that
carry Syrup-encoded messages can share a single length-prefixed
primitive with the payload format itself, eliminating a redundant
delimiter byte per message and giving "a frame" and "a Syrup byte
string" the same on-the-wire encoding.

## Why not `@endo/netstring`?

[DJB's netstring][djb] specification is explicit that a netstring
carries a trailing `,`.
A netstring without the separator is **not** a netstring; conflating
the two by adding an option to `@endo/netstring` would blur the
identity of that package.
`@endo/syrup-frame` is a deliberate departure, named for its purpose.

## Scope

This package is an Endo-internal variant intended for use under a
distinct OCapN network identifier (e.g., `tcp+syrup-frame`).
The existing `@endo/netstring` package remains the canonical netstring
implementation and continues to serve the Endo daemon's
`tcp+netstring+json+captp0` transport and any other caller that wants
strict netstring compliance.

## API

```js
import {
  makeSyrupFrameReader,
  makeSyrupFrameWriter,
} from '@endo/syrup-frame';
```

### `makeSyrupFrameReader(input, opts?) -> Reader<Uint8Array, undefined>`

Wraps an iterable/async-iterable of byte chunks into an async iterator
of whole frames.
Handles arbitrary chunk boundaries (length prefix split across chunks,
payload split across chunks).

Options:

- `name` — identifier embedded in error messages.
- `maxMessageLength` — upper bound on any single payload, default
  `999999999` (same as `@endo/netstring`).

### `makeSyrupFrameWriter(output, opts?) -> Writer<Uint8Array | Uint8Array[]>`

Wraps an output byte writer into a frame writer.

Options:

- `chunked` — when true, emit the prefix and each payload chunk as
  separate writes.  Required for zero-copy writers.  Identical to
  `@endo/netstring`'s `chunked` option minus the separator write.

## Design

See [`designs/ocapn-tcp-syrup-framing.md`](../../designs/ocapn-tcp-syrup-framing.md)
in the repository root.

[netstring]: ../netstring/
[djb]: https://cr.yp.to/proto/netstrings.txt
