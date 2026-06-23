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

This package deals exclusively with plain mutable `Uint8Array` values.
Callers that work with passable byte arrays (frozen `Uint8Array` values
backed by an immutable `ArrayBuffer`) should use `@endo/pass-style/to-bytes.js`,
`@endo/pass-style/from-bytes.js`, and `@endo/pass-style/concat-bytes.js`.

## Install

```sh
npm install @endo/bytes
```

## Usage

```js
import { concatBytes } from '@endo/bytes/concat.js';
import { bytesEqual } from '@endo/bytes/equals.js';
import { compareBytes } from '@endo/bytes/compare.js';

const a = new Uint8Array([1, 2, 3]);
const b = new Uint8Array([4, 5, 6]);
const combined = concatBytes([a, b]);
bytesEqual(combined, new Uint8Array([1, 2, 3, 4, 5, 6])); // true
compareBytes(a, b); // negative (a < b)
```

For UTF-8 transcoding, use `@endo/utf8`.
For ASCII transcoding, use `@endo/ascii`.
For hex encoding and decoding, use `@endo/hex`.
For base64 encoding and decoding, use `@endo/base64`.

The package is exported as per-symbol subpath modules so that callers
import qualified names without needing a namespace import.

## API

### `concatBytes(chunks) -> Uint8Array`

Concatenates a list of mutable `Uint8Array` chunks into a single contiguous
`Uint8Array`.
Empty input yields an empty `Uint8Array`.

### `bytesEqual(a, b) -> boolean`

Compares two `Uint8Array` values byte-for-byte.
Returns `true` when the two arrays have equal length and equal contents.

### `compareBytes(left, right) -> number`

Compares two `Uint8Array` values lexicographically.
Returns a negative number when `left` sorts before `right`, `0` when
equal, and a positive number when `left` sorts after `right`.

## Out of scope

- UTF-8 transcoding: use `@endo/utf8`.
- ASCII transcoding: use `@endo/ascii`.
- Hex encoding and decoding: use `@endo/hex`.
- Base64 encoding and decoding: use `@endo/base64`.
- Passable byteArray wrapping and unwrapping: use
  `@endo/pass-style/to-bytes.js` and `@endo/pass-style/from-bytes.js`.

## Hardened JavaScript

Every export is hardened.
The modules have no mutable state.
