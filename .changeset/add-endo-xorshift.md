---
'@endo/xorshift': minor
'@endo/hex': patch
'@endo/ocapn': patch
---

Extracts the xorshift128+ PRNG previously duplicated as
`packages/ocapn/test/_xorshift.js` and `packages/hex/test/_xorshift.js`
into a new standalone hardened package `@endo/xorshift`, exposing
`makeXorShift(seed)` that returns `{ random, int }` where `random()`
returns a float in `[0, 1)` (like `Math.random()`) and `int(lo, hi)`
returns a uniformly distributed integer in `[lo, hi)` via rejection
sampling on a 53-bit draw. The seed is a `Uint8Array` of 1 to 16
bytes, left-padded with zeros to fill the 128-bit state in the style
of the TC39 seeded-random proposal; the all-zero state (xorshift128+'s
absorbing fixed point) is rejected. Rewires the `@endo/ocapn` syrup
and passable fuzz tests and the `@endo/hex` encode/decode benchmarks
to import from `@endo/xorshift`, and removes the duplicate copies.

`@endo/xorshift` ships its own ses-ava multi-config test suite
(lockdown, unsafe, shims-only) and hardens both the returned generator
and the `makeXorShift` factory.
