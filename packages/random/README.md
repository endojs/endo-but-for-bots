# `@endo/random`

`@endo/random` is a small, seedable pseudorandom number generator built
on the [ChaCha20](https://datatracker.ietf.org/doc/html/rfc8439) stream
cipher.  Given a 32-byte seed it produces a deterministic, statistically
high-quality stream of bytes, floats, and integers.

ChaCha20 is a cryptographically strong stream cipher, but using it as a
PRNG with a caller-supplied seed is **not a key-derivation function and
must not be used to derive cryptographic keys**.  The intended use is
deterministic test fixtures, property-based testing, fuzzing, and
similar reproducible workloads where a fixed seed must produce the same
stream across runs and engines.

The method names align with the
[TC39 proposal-random-functions](https://tc39.es/proposal-random-functions/)
(Stage 1) so consumers can swap in a `Random.Seeded` instance later
without changing call sites.

## Install

```sh
npm install @endo/random
```

## Usage

```js
import { makeRandom } from '@endo/random';

// Seed: 32-byte Uint8Array (ChaCha20 key).
const seed = new Uint8Array(32);
seed[0] = 0x42; // ... fill in your seed

const prng = makeRandom(seed);

prng.random();        // float in [0, 1)
prng.int(0, 99);      // integer in the closed interval [0, 99]
prng.bytes(16);       // fresh 16-byte Uint8Array
prng.fillBytes(buf);  // fill an existing Uint8Array
```

The seed must be a 32-byte `Uint8Array`.  The factory throws
`TypeError` for any other shape.  All returned objects pass through
`harden` from `@endo/harden`.

## Node fast path

The package ships two implementations:

- A portable pure-JavaScript ChaCha20 (default export, used in
  browsers, XS, and SES vats).
- A `node:crypto`-backed implementation that uses
  `crypto.createCipheriv('chacha20', key, iv)` to produce keystream
  blocks.

The `"node"` export condition in `package.json` selects the Node
implementation automatically, so `import { makeRandom } from
'@endo/random'` Just Works on Node and falls back to the pure-JS path
elsewhere.  The two implementations are bit-identical: for any seed,
they return the same bytes from `bytes()`, the same floats from
`random()`, and the same integers from `int()`.

## Determinism

- `random()` reads 8 keystream bytes, masks the top 11 bits, and
  divides by `2 ** 53`.  The result is exactly equal across runs
  because the float arithmetic is performed on a 53-bit integer.
- `int(lo, hi)` uses rejection sampling on the 53-bit float to
  eliminate modulo bias.

## Counter limit

The PRNG follows the OpenSSL / Node-crypto convention of a 32-bit
ChaCha20 block counter.  After `2 ** 32` blocks (256 GiB of
keystream) the counter would wrap; the factory throws `RangeError`
instead.  In practice no test suite consumes anywhere close to this.
