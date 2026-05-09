# `@endo/chacha12`

`@endo/chacha12` is a small, pure-JavaScript implementation of the
ChaCha12 keystream: the 12-round variant of Daniel J. Bernstein's
ChaCha family.  Given a 32-byte key it produces a deterministic,
statistically high-quality stream of bytes suitable for deterministic
test fixtures, property-based testing, and fuzzing.

The package exposes a single public entry point, `makeChaCha12`.
`makeChaCha12(key)` returns a function `(out: Uint8Array) => void`
that fills `out` with the next bytes of the keystream.  The shape
matches `crypto.getRandomValues` (minus the return value) and
conforms to `@endo/random`'s `RandomSource` type; the same function
serves either ecosystem.

The ChaCha12 block function is identical to
[ChaCha20](https://datatracker.ietf.org/doc/html/rfc8439) modulo the
loop count: 6 double-rounds (12 rounds) instead of 10 (20 rounds).
The reduced round count trades cryptographic safety margin for
speed.

For cipher use cases, prefer ChaCha20 or another 20-round
implementation.  ChaCha20 has a larger published security margin and
remains the cryptographer's first choice for cipher work.  ChaCha12
has no public attack that improves on brute force, but the 12-round
version is best understood as a PRNG choice (a throughput-vs-margin
knob), not a cipher recommendation.

ChaCha12 (like ChaCha20) **must not be used to derive cryptographic
keys** when the seed is caller-supplied.  This package is a PRNG
keystream, not a key-derivation function.

## Install

```sh
npm install @endo/chacha12
```

## Usage

```js
import { makeChaCha12 } from '@endo/chacha12';
import { random } from '@endo/random/random.js';
import { randomInt } from '@endo/random/int.js';

// Seed: 32-byte Uint8Array (ChaCha12 key).
const seed = new Uint8Array(32);
seed[0] = 0x42;

// `source` is a bytes filler: a function that takes a buffer and
// fills it with the next bytes of the ChaCha12 keystream.
const source = makeChaCha12(seed);

// Use directly.
const buffer = new Uint8Array(16);
source(buffer);

// Or pass to @endo/random samplers.
random(source); // float in [0, 1)
randomInt(source, 0, 99); // integer in the closed interval [0, 99]
```

The seed must be a 32-byte `Uint8Array`; `makeChaCha12` throws
`TypeError` on any other shape.  The returned function is hardened
with `@endo/harden`.

## Bound on keystream length

A given source can produce at most 256 GiB of keystream; calls
beyond that throw `RangeError`.  In practice no test suite consumes
anywhere close to this.

## Verification

The keystream is cross-checked against three published ChaCha12 test
vectors from
[`draft-strombergson-chacha-test-vectors-01`](https://datatracker.ietf.org/doc/html/draft-strombergson-chacha-test-vectors-01)
(TC1, TC4, TC8) by `test/chacha12.test.js`.  The sampling functions
in `@endo/random` carry their own determinism vectors.

## ChaCha12 vs ChaCha20

ChaCha12 is faster than ChaCha20 by roughly the ratio of round counts
(12 / 20 = 0.6), modulo per-call overhead.  The benchmark that
measures both keystreams (and an `xorshift128+` baseline) side by
side lives in `@endo/random/test/random.bench.js`, since it drives
the keystreams through `@endo/random`'s sampler functions.  See
`BENCH.md` in this directory for a recent measurement.
