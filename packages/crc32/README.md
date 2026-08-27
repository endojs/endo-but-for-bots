# @endo/crc32

Hardened synchronous IEEE CRC-32 checksums over bytes.

```js
import { crc32 } from '@endo/crc32';

const checksum = crc32(bytes);
```

## API

### `crc32(bytes, length?, index = 0, previous = 0)`

Returns the unsigned 32-bit IEEE CRC-32 checksum of `length` bytes beginning at
`index` of `bytes`. `length` defaults to the input's intrinsic byte length (a
genuine view's true intrinsic length read through `%TypedArray%.prototype`, or a
validated emulated `.length`) — *not* to `bytes.length` read directly, and *not*
narrowed by `index`, so supplying a non-zero `index` while defaulting `length`
overflows the input and throws a `RangeError` (`crc32(bytes, undefined, 5)` on a
10-byte input asks for `[5, 15)`). Pass an explicit `length` alongside a
non-zero `index`.

The input is byte-oriented. Encode text at the caller boundary, for example
with `@endo/bytes`' `bytesFromText`, so the caller explicitly chooses the text
encoding.

The optional range arguments support callers that checksum a view without
allocating a slice. To process incrementally, pass the result of one call as
`previous` to the next:

```js
const first = crc32(bytes, 100, 0);
const complete = crc32(bytes, bytes.length - 100, 100, first);
```

`bytes` may be a genuine single-byte `ArrayBuffer` view (`Uint8Array`,
`Uint8ClampedArray`, or `Int8Array`) or a conforming emulated view — an object
with a numeric `length` and an `.at(index)` that returns each byte as an
integer in `[0, 255]`. A genuine single-byte view is branded by its intrinsic
`%TypedArray%.prototype` `[Symbol.toStringTag]` and read on the engine's fast
path by index; everything else is read through `.at` and every byte is
validated, so a byte an emulated `.at` returns that is not a `[0, 255]` integer
throws `TypeError` rather than being coerced. That brand is why the following do
not silently produce a plausible-but-wrong checksum: a multi-byte view such as
`Uint16Array` or `Float64Array` (rejected outright — its elements are not bytes,
so it is not folded over its element values); a `DataView` (no `.length` and no
`.at`, so it is rejected); a bare `Proxy` over a `Uint8Array` or a plain
lookalike (its intrinsic toStringTag getter reports `undefined`, so it is held
to the `.at`/`.length` contract, and its `.length` must be a non-negative safe
integer no greater than `2**32 - 1`, the largest a real byte view could back —
which also bounds the `.at` loop so a tiny object cannot declare a
near-`Number.MAX_SAFE_INTEGER` length and spin it effectively forever); and a
`length`-overriding `Uint8Array` subclass (the fast path reads the true
intrinsic length, so the override cannot drive out-of-range reads). A genuine
view over a detached (or transferred) `ArrayBuffer`, or one out of bounds over a
shrunk resizable `ArrayBuffer`, throws rather than silently checksumming as
empty, because its intrinsic length reads as `0` without throwing in both cases;
these are detected by invoking the intrinsic `%TypedArray%.prototype.at` (which
throws for a detached and an out-of-bounds view alike, cannot be spoofed by a
caller-planted `detached` property, and works on engines predating the ES2024
`.detached` accessor), never by reading the buffer's `.detached` accessor. A
`SharedArrayBuffer`-backed view is accepted, but its bytes are read
unsynchronized, so a checksum over a shared buffer is not an integrity
guarantee. Range arguments must be non-negative safe integers within the input,
and `previous` must be an unsigned 32-bit integer; invalid arguments throw
`TypeError` or `RangeError` instead of being coerced.

CRC-32 detects accidental corruption. It is not a cryptographic hash and must
not be used for authenticity, signatures, or adversarial collision resistance.
