// @ts-check
/* eslint no-bitwise: ["off"] */

// Bindings between `@endo/random`'s `RandomSource` and the
// `pure-rand` `RandomGenerator` interface, which is the contract
// `fast-check` uses to drive property-based tests via the
// `randomType` parameter.  This module imports nothing from
// `pure-rand` or `fast-check`; it depends only on those interfaces
// being structurally compatible.
//
// pure-rand v5 / v6 / v7 RandomGenerator (the shape `fast-check@^3`
// consumes; resolved by `yarn.lock` today):
//   next(): [value: number, nextGenerator: RandomGenerator];
//   unsafeNext(): number;
//   clone(): RandomGenerator;
//   min(): number;  // inclusive
//   max(): number;  // inclusive
//
// pure-rand v8 RandomGenerator (the shape `fast-check@^4` consumes):
//   next(): number;            // mutates; returned value is the only output
//   clone(): RandomGenerator;  // documented as fully independent
//   getState(): readonly number[];
//
// `next()` value is a 32-bit signed integer in
// `[-0x80000000, 0x7fffffff]`.  Both adapter generations ship; the
// `*V8` exports target `fast-check@4` and the unsuffixed exports
// target `fast-check@3`.

import harden from '@endo/harden';

import { randomUint32 } from '@endo/random/uint.js';

/**
 * @typedef {import('./random-fast-check.types.d.ts').RandomSource} RandomSource
 * @typedef {import('./random-fast-check.types.d.ts').PureRandomGenerator} PureRandomGenerator
 * @typedef {import('./random-fast-check.types.d.ts').PureRandomGeneratorV8} PureRandomGeneratorV8
 */

const INT32_MIN = -0x80000000;
const INT32_MAX = 0x7fffffff;

/**
 * Wraps a `RandomSource` as a `pure-rand` v5 `RandomGenerator`.
 * `next()` reads 4 bytes through the source and returns the result
 * as a 32-bit signed integer plus the same generator instance
 * (state advances in place).
 *
 * `clone()` returns an alias of this generator: `RandomSource` has
 * no general state-snapshot facility, so the alias shares keystream
 * state with the original.  This is sufficient for `fast-check`'s
 * forward sampling but degrades shrinking quality.  Pass a source
 * with its own snapshot mechanism, or drive a fresh source from a
 * freshly-derived seed, when independent forks are required.
 *
 * @param {RandomSource} source
 * @returns {PureRandomGenerator}
 */
export const adaptToPureRandomGenerator = source => {
  const unsafeNext = () => randomUint32(source) | 0;
  /** @type {PureRandomGenerator} */
  const rg = {
    next() {
      return [unsafeNext(), rg];
    },
    unsafeNext,
    clone() {
      return rg;
    },
    min() {
      return INT32_MIN;
    },
    max() {
      return INT32_MAX;
    },
  };
  return harden(rg);
};
harden(adaptToPureRandomGenerator);

/**
 * Wraps a `pure-rand` `RandomGenerator` as a `RandomSource`.  The
 * adapter unpacks each `next()` value into 4 little-endian bytes,
 * advancing the generator reference to the returned `nextGenerator`
 * after each call.  `min()` / `max()` are not consulted: the value
 * is treated as a bit pattern.
 *
 * @param {PureRandomGenerator} rg
 * @returns {RandomSource}
 */
export const adaptFromPureRandomGenerator = rg => {
  let current = rg;
  let pending = 0;
  let pendingBits = 0;

  /** @param {Uint8Array} out */
  const fillBytes = out => {
    for (let i = 0; i < out.length; i += 1) {
      if (pendingBits === 0) {
        const pair = current.next();
        pending = pair[0] >>> 0;
        const next = pair[1];
        current = next;
        pendingBits = 32;
      }
      out[i] = pending & 0xff;
      pending >>>= 8;
      pendingBits -= 8;
    }
  };

  return harden(fillBytes);
};
harden(adaptFromPureRandomGenerator);

/**
 * Builds a `fast-check`-compatible
 * [`randomType`](https://fast-check.dev/docs/api/interfaces/Parameters/#randomtype)
 * function from a factory that turns a 32-byte seed into a
 * `RandomSource`.  `fast-check` calls the returned function with a
 * 32-bit signed integer seed and expects back a `pure-rand`-shaped
 * `RandomGenerator`.  The integer seed is broadcast across a 32-byte
 * buffer (compatible with ChaCha-style key inputs).
 *
 * @param {(seed: Uint8Array) => RandomSource} makeSourceFromSeed
 * @returns {(int32Seed: number) => PureRandomGenerator}
 */
export const makeRandomTypeFromSeed = makeSourceFromSeed => {
  /** @param {number} int32Seed */
  const randomType = int32Seed => {
    const seed = new Uint8Array(32);
    const view = new DataView(seed.buffer);
    for (let i = 0; i < 8; i += 1) {
      view.setInt32(i * 4, int32Seed | 0, true);
    }
    return adaptToPureRandomGenerator(makeSourceFromSeed(seed));
  };
  return harden(randomType);
};
harden(makeRandomTypeFromSeed);

// ---------------------------------------------------------------------------
// pure-rand v8 adapters (fast-check@4 path).  Same byte-level behavior
// as the v5 adapters above; the surface differs only in the shape of
// the returned generator object.  Maintained as a parallel pair so a
// single source tree serves both fast-check majors until v3 support
// is dropped.
// ---------------------------------------------------------------------------

const EMPTY_STATE = harden(/** @type {readonly number[]} */ ([]));

/**
 * Wraps a `RandomSource` as a `pure-rand` v8 `RandomGenerator`.
 * `next()` reads 4 bytes through the source and returns the result
 * as a 32-bit signed integer; the generator state advances in place
 * (v8 collapsed the v5 `next` / `unsafeNext` distinction).
 *
 * `clone()` returns an alias of this generator: `RandomSource` has
 * no general state-snapshot facility, so the alias shares keystream
 * state with the original.  This is sufficient for `fast-check`'s
 * forward sampling but does not satisfy v8's "fully independent"
 * wording for shrinking workloads.  Pass a source with its own
 * snapshot mechanism, or drive a fresh source from a freshly-derived
 * seed, when independent forks are required.
 *
 * `getState()` returns an empty array because `RandomSource` does
 * not expose its state; v8 promotes `getState` from optional to
 * mandatory, so an empty-array placeholder satisfies the type
 * without misleading.  `fast-check`'s `randomType` path does not
 * consult `getState`.
 *
 * @param {RandomSource} source
 * @returns {PureRandomGeneratorV8}
 */
export const adaptToPureRandomGeneratorV8 = source => {
  const next = () => randomUint32(source) | 0;
  /** @type {PureRandomGeneratorV8} */
  const rg = {
    next,
    clone() {
      return rg;
    },
    getState() {
      return EMPTY_STATE;
    },
  };
  return harden(rg);
};
harden(adaptToPureRandomGeneratorV8);

/**
 * Wraps a `pure-rand` v8 `RandomGenerator` as a `RandomSource`.  Each
 * `next()` call yields one 32-bit signed value; the adapter unpacks
 * it into 4 little-endian bytes.  Unlike the v5 adapter there is no
 * `nextGenerator` to thread; the generator mutates in place.
 *
 * @param {PureRandomGeneratorV8} rg
 * @returns {RandomSource}
 */
export const adaptFromPureRandomGeneratorV8 = rg => {
  let pending = 0;
  let pendingBits = 0;

  /** @param {Uint8Array} out */
  const fillBytes = out => {
    for (let i = 0; i < out.length; i += 1) {
      if (pendingBits === 0) {
        pending = rg.next() >>> 0;
        pendingBits = 32;
      }
      out[i] = pending & 0xff;
      pending >>>= 8;
      pendingBits -= 8;
    }
  };

  return harden(fillBytes);
};
harden(adaptFromPureRandomGeneratorV8);

/**
 * Builds a `fast-check@4`-compatible
 * [`randomType`](https://fast-check.dev/docs/api/interfaces/Parameters/#randomtype)
 * function from a factory that turns a 32-byte seed into a
 * `RandomSource`.  Behaves identically to `makeRandomTypeFromSeed`
 * except that the returned generator implements the v8 shape; the
 * seed-broadcast path is shared.
 *
 * @param {(seed: Uint8Array) => RandomSource} makeSourceFromSeed
 * @returns {(int32Seed: number) => PureRandomGeneratorV8}
 */
export const makeRandomTypeFromSeedV8 = makeSourceFromSeed => {
  /** @param {number} int32Seed */
  const randomType = int32Seed => {
    const seed = new Uint8Array(32);
    const view = new DataView(seed.buffer);
    for (let i = 0; i < 8; i += 1) {
      view.setInt32(i * 4, int32Seed | 0, true);
    }
    return adaptToPureRandomGeneratorV8(makeSourceFromSeed(seed));
  };
  return harden(randomType);
};
harden(makeRandomTypeFromSeedV8);
