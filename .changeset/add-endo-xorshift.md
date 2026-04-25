---
'@endo/xorshift': minor
'@endo/ocapn': patch
---

Extracts the xorshift128+ PRNG previously embedded as
`packages/ocapn/test/_xorshift.js` into a new standalone hardened
package `@endo/xorshift`, exposing `makeXorShift(seed)` with `random()`
and `randomint()` methods. Rewires the `@endo/ocapn` syrup and passable
fuzz tests to import from `@endo/xorshift`.
