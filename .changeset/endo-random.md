---
'@endo/random': minor
---

Add `@endo/random` package providing `makeRandom(seed)` — a seedable
pseudorandom number generator built on the ChaCha20 stream cipher.

The public API matches the
[TC39 proposal-random-functions](https://tc39.es/proposal-random-functions/)
shape:

- `prng.random()` — float in `[0, 1)`
- `prng.int(lo, hi)` — integer in the closed interval `[lo, hi]`
- `prng.bytes(n)` — fresh `Uint8Array` of `n` random bytes
- `prng.fillBytes(buf, start?, end?)` — fill an existing `Uint8Array`

The implementation is pure JavaScript so the same code runs in
browsers, XS, SES vats, and Node.  At ChaCha20's 64-byte block
granularity the JS↔native FFI cost of `node:crypto` actually exceeds
the inlined keystream loop, so a Node-specific fast path was
considered and dropped.

ChaCha20 here is **not** a guarantee of fitness for cryptographic
key derivation; it is used as a deterministic, high-quality
seedable PRNG for test fixtures, property-based testing, fuzzing,
and similar reproducible workloads.
