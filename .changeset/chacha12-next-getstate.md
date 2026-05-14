---
'@endo/chacha12': major
'@endo/random': patch
'@endo/hex': patch
'@endo/ocapn': patch
---

**Breaking:** `makeChaCha12(key)` now returns a `ChaCha12Generator`
record `{ next, getState, clone, fillRandomBytes }` instead of a
bare `(out: Uint8Array) => void` function.

The new shape exposes the keystream's internal state for
introspection and resumption, and is structurally compatible with
[`pure-rand`](https://github.com/dubzzz/pure-rand) v8's
`RandomGenerator` interface (the contract that
[`fast-check`](https://github.com/dubzzz/fast-check) v4 consumes via
its `randomType` parameter).  The byte-keystream entry point is
preserved as the `fillRandomBytes` method.

| Method | Shape | Notes |
| --- | --- | --- |
| `next()` | `() => number` | Signed int32 in `[-0x80000000, 0x7fffffff]`; pulls 4 little-endian keystream bytes.  Matches `pure-rand` v8 `RandomGenerator.next`. |
| `getState()` | `() => readonly number[]` | 34-element snapshot: `[base0..base15, counter, offset, block0..block15]`.  Pass to `makeChaCha12FromState` to reconstruct. |
| `clone()` | `() => ChaCha12Generator` | Fully independent copy at the same keystream position. |
| `fillRandomBytes(out)` | `(out: Uint8Array) => void` | Conforms to `@endo/random`'s `RandomSource` and `crypto.getRandomValues`-style ergonomics. |

Adds `makeChaCha12FromState(state)` for deterministic resumption
from a snapshot.

### Migration

```js
// Before
const fillRandomBytes = makeChaCha12(seed);
fillRandomBytes(out);

// After
const { fillRandomBytes } = makeChaCha12(seed);
fillRandomBytes(out);
```

In-tree consumers in `@endo/random`, `@endo/hex`, and `@endo/ocapn`
have been updated; the change is mechanical (destructure
`fillRandomBytes` from the returned record).

### Why

[Upstream review feedback on PR #3232](https://github.com/endojs/endo/pull/3232#issuecomment-4421637048)
asked for `@endo/chacha12` to expose enough of its keystream state
to support a `pure-rand` v8 / `fast-check` v4 adapter.  The closure
returned by the previous shape encapsulated `baseState`, `counter`,
`offset`, and `block` with no accessor, so an out-of-package
adapter could not snapshot or clone the keystream.

The new sibling package `@endo/chacha12-fast-check-test` (private)
exercises the surface end-to-end against `fast-check@4`'s
`randomType` parameter.
