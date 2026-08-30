---
'@endo/bytes': patch
---

Publish the stopgap `toIndexableUint8Array` coercion from
`@endo/bytes/indexed.js` for bytewise fallbacks that benchmarks demonstrate are
faster with integer-indexed reads than with `at(index)`.
Genuine views pass through without allocation and emulated immutable wrappers
are copied into a genuine mutable `Uint8Array`.

Also publish `constantTimeBytesEqual` from
`@endo/bytes/constant-time-equals.js`. It compares every byte for equal-length
inputs and uses the shared indexed-access coercion for emulated immutable
wrappers.
