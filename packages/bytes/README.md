# `@endo/bytes`

`@endo/bytes` provides a minimal set of portable `Uint8Array` helpers
for cross-realm byte handling.
Endo runs in three byte-handling realms:
Node (where `Buffer` is ambient),
XS (no `Buffer`),
and SES-locked compartments
(where `Uint8Array` is the only portable byte container).
This package is the canonical home for the `Uint8Array` helpers that
those realms share.

See `designs/endo-bytes.md` for the audit of pre-existing duplicates
and the rationale for the API surface.

## Install

```sh
npm install @endo/bytes
```

## Usage

```js
import { concatBytes } from '@endo/bytes/concat.js';
import { bytesEqual } from '@endo/bytes/equals.js';
// The immutable byte utilities live in @endo/immutable-arraybuffer.
import { frozenBytes, thawedBytes } from '@endo/immutable-arraybuffer';

const greeting = concatBytes([
  new Uint8Array([72, 101, 108, 108, 111, 44]),
  new Uint8Array([32, 119, 111, 114, 108, 100, 33]),
]);

bytesEqual(greeting, greeting.slice()); // true

// Wrap a Uint8Array as a passable, frozen Uint8Array backed by an
// immutable ArrayBuffer.
const passable = frozenBytes(greeting);
// Recover a working mutable Uint8Array from a passable received over a
// vat boundary.
thawedBytes(passable); // mutable copy of `greeting`
```

The package is exported as per-symbol subpath modules so that callers
import qualified names without needing a namespace import.

## API

### `concatBytes(chunks) -> Uint8Array`

Concatenates a list of `Uint8Array` chunks into a single contiguous
`Uint8Array`.
Empty input yields an empty `Uint8Array`.

### `bytesEqual(a, b) -> boolean`

Compares two `Uint8Array` values byte-for-byte.
Returns `true` when the two arrays have equal length and equal contents.

### `toIndexableUint8Array(bytes) -> Uint8Array`

Exported from `@endo/bytes/indexed.js` as a stopgap for historical bytewise
algorithms that require integer-indexed reads.
Prefer `at(index)` unless a multi-platform benchmark demonstrates that coercing
an emulated immutable wrapper is faster on platforms that use the JavaScript
fallback.

### `concatImmutables(buffers) -> Uint8Array`

Concatenates a list of byteArray-passable values (or bare
`ArrayBufferLike`s) into a single hardened frozen `Uint8Array` backed
by an immutable `ArrayBuffer`. Equivalent to
`frozenBytes(concatBytes(buffers.map(thawedBytes)))`, provided as a
single-call helper because that composition is common when assembling
protocol records from immutable byte fragments.

### `frozenBytes` and `thawedBytes` (in `@endo/immutable-arraybuffer`)

The immutable byte utilities `frozenBytes` (wrap a `Uint8Array` view's
contents in a hardened frozen `Uint8Array` backed by an immutable
`ArrayBuffer`) and `thawedBytes` (copy such a value back out into a
fresh mutable `Uint8Array`) are exported from
`@endo/immutable-arraybuffer`, alongside the platform shim that remains
its separate `@endo/immutable-arraybuffer/shim.js` export.

## Out of scope

For other byte operations, prefer existing packages or built-in
methods.

- Slicing: use `Uint8Array.prototype.subarray` (no copy) or
  `Uint8Array.prototype.slice` (copy).
- Hex encoding and decoding: use `@endo/hex`.
- Base64 encoding and decoding: use `@endo/base64`.
- UTF-8 encoding and decoding: use `@endo/utf8`.
- Streaming concatenation: compose `concatBytes` with a `for await`
  loop; see `@endo/stream` and `@endo/stream-node` for stream primitives.

## Hardened JavaScript

Every export is hardened.
The modules have no other mutable state.
