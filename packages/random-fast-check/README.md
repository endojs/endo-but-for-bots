# `@endo/random-fast-check`

`@endo/random-fast-check` adapts an
[`@endo/random`](../random/README.md) `RandomSource` to and from the
[`pure-rand`](https://www.npmjs.com/package/pure-rand)
`RandomGenerator` interface that
[`fast-check`](https://fast-check.dev/) consumes via the
[`randomType`](https://fast-check.dev/docs/api/interfaces/Parameters/#randomtype)
parameter.

The package imports nothing from `pure-rand` or `fast-check` at
runtime; it depends only on those interfaces being structurally
compatible.
Two parallel adapter pairs ship: the unsuffixed exports target
`pure-rand` v5 / v6 / v7 (the shape `fast-check@^3` consumes), and
the `*V8` exports target `pure-rand@^8` (the shape `fast-check@^4`
consumes).

## Install

```sh
npm install @endo/random-fast-check
```

## Exports

| Symbol | Generation | Purpose |
| --- | --- | --- |
| `adaptToPureRandomGenerator` | v5 / v6 / v7 | Wrap a `RandomSource` as a `pure-rand` v5 `RandomGenerator`. |
| `adaptFromPureRandomGenerator` | v5 / v6 / v7 | Wrap a `pure-rand` v5 `RandomGenerator` as a `RandomSource`. |
| `makeRandomTypeFromSeed` | v5 / v6 / v7 | Build a `fast-check@3` `randomType` factory from a seed-to-source builder. |
| `adaptToPureRandomGeneratorV8` | v8 | Wrap a `RandomSource` as a `pure-rand` v8 `RandomGenerator`. |
| `adaptFromPureRandomGeneratorV8` | v8 | Wrap a `pure-rand` v8 `RandomGenerator` as a `RandomSource`. |
| `makeRandomTypeFromSeedV8` | v8 | Build a `fast-check@4` `randomType` factory from a seed-to-source builder. |

The two generations differ only in the surface of the returned
generator object; the byte-level pack/unpack is bit-identical, so a
consumer can switch generations without changing the underlying
entropy stream for a given seed and source.

## Example: ChaCha12-backed `randomType` for `fast-check@3`

```js
import { fc } from '@fast-check/ava';
import { makeChaCha12 } from '@endo/chacha12';
import { makeRandomTypeFromSeed } from '@endo/random-fast-check';

const chaCha12RandomType = makeRandomTypeFromSeed(
  seed => makeChaCha12(seed).fillRandomBytes,
);

fc.assert(
  fc.property(fc.integer(), n => n + 0 === n),
  { randomType: chaCha12RandomType, seed: 0xdeadbeef, numRuns: 100 },
);
```

The same example for `fast-check@4` substitutes
`makeRandomTypeFromSeedV8`; nothing else changes.

## Caveats on the v8 contract

- **`clone()`** returns an alias of the same generator rather than a
  fully independent fork.
  `RandomSource` has no general state-snapshot facility, so the
  alias shares keystream state with the original.
  This is sufficient for `fast-check`'s forward sampling but does
  not satisfy v8's "fully independent" wording for shrinking
  workloads.
  Pass a source with its own snapshot mechanism (e.g.
  `chacha12State(key, nonce, counter)` once that exists), or drive a
  fresh source from a freshly-derived seed, when independent forks
  are required.
- **`getState()`** returns an empty array.
  v8 promotes `getState` from optional to mandatory; the empty
  placeholder satisfies the type without misleading.
  `fast-check`'s `randomType` path does not consult `getState` on a
  `randomType`-built generator, so the placeholder is never observed
  in the property-testing hot path.

## Hardening

Every exported function and every returned generator is hardened
with `@endo/harden` and is safe to invoke from a SES vat or
compartment.
