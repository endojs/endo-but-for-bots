# `@endo/xorshift`

`@endo/xorshift` is a small, dependency-free implementation of the
[xorshift128+](https://en.wikipedia.org/wiki/Xorshift#xorshift+)
pseudorandom number generator, suitable for deterministic property and
fuzz testing.

This generator is **not** cryptographically secure.
It is intended for reproducible test fixtures where a small fixed seed
must produce the same stream of numbers across runs.

The implementation is forked from
[AndreasMadsen/xorshift](https://github.com/AndreasMadsen/xorshift) at
commit
[`d60ca9ca`](https://github.com/AndreasMadsen/xorshift/blob/d60ca9ca341957a9824908f733f30ce4592c9af4/xorshift.js).

## Install

```sh
npm install @endo/xorshift
```

## Usage

```js
import { makeXorShift } from '@endo/xorshift';

// Seed: four 32-bit integers in big-endian order.
const prng = makeXorShift([0xb0b5c0ff, 0xeefacade, 0xb0b5c0ff, 0xeefacade]);

prng.random(); // float in [0, 1)
prng.randomint(); // [hi32, lo32]
```
