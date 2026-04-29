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

The package ships two implementations selected via export conditions:
a pure-JavaScript ChaCha20 for browsers / XS / SES vats, and a
`node:crypto`-backed implementation that uses
`createCipheriv('chacha20', key, iv)` for the Node fast path.  The
two implementations are bit-identical for the same seed.

ChaCha20 here is **not** a guarantee of fitness for cryptographic
key derivation; it is used as a deterministic, high-quality
seedable PRNG for test fixtures, property-based testing, fuzzing,
and similar reproducible workloads.
