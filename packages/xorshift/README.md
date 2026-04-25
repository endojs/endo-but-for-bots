# `@endo/xorshift`

`@endo/xorshift` is a small implementation of the
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

The seed is a `Uint8Array` of 1 to 16 bytes.  Shorter seeds are
left-padded with zero bytes to fill the 128-bit state, in the style of
the [TC39 seeded-random
proposal](https://github.com/tc39/proposal-seeded-random).  The
all-zero seed is rejected because it is xorshift128+'s absorbing fixed
point.

```js
import { makeXorShift } from '@endo/xorshift';

const seed = Uint8Array.of(
  0xb0, 0xb5, 0xc0, 0xff, 0xee, 0xfa, 0xca, 0xde,
  0xb0, 0xb5, 0xc0, 0xff, 0xee, 0xfa, 0xca, 0xde,
);
const { random, int } = makeXorShift(seed);

random(); // float in [0, 1)
int(0, 100); // integer in [0, 100)
```
