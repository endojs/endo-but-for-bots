// @ts-check
/* eslint no-bitwise: ["off"] */

// Forked from the CommonJS xorshift package by Andreas Madsen,
// originally released under the MIT License:
// https://github.com/AndreasMadsen/xorshift/blob/d60ca9ca341957a9824908f733f30ce4592c9af4/xorshift.js
//
// Copyright (c) 2014 Andreas Madsen
//
// Permission is hereby granted, free of charge, to any person
// obtaining a copy of this software and associated documentation
// files (the "Software"), to deal in the Software without
// restriction, including without limitation the rights to use, copy,
// modify, merge, publish, distribute, sublicense, and/or sell copies
// of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be
// included in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.

import harden from '@endo/harden';

const SEED_BYTES = 16;
// 2^53.  All non-negative integers up to and including this value are
// exactly representable in IEEE 754, so it is the correct upper bound
// for an unsigned 53-bit integer drawn from `random64()`.
const MAX_U53 = Number.MAX_SAFE_INTEGER + 1;

/**
 * @typedef {object} XorShift
 * @property {() => number} random
 *   Returns a float in `[0, 1)`, like `Math.random()`.
 * @property {(lo: number, hi: number) => number} int
 *   Returns a uniformly distributed integer in the half-open interval
 *   `[lo, hi)`.  Both bounds must be safe integers and `lo < hi`.
 */

/**
 * Creates an xorshift128+ pseudorandom number generator.
 *
 * @param {Uint8Array} seed
 *   A non-empty `Uint8Array` of at most 16 bytes.  Shorter seeds are
 *   left-padded with zero bytes to fill the 128-bit state, in the
 *   style of the TC39 [seeded-random
 *   proposal](https://github.com/tc39/proposal-seeded-random).  The
 *   16 bytes are read as four big-endian 32-bit words and loaded
 *   into the state in `[state0U, state0L, state1U, state1L]` order.
 * @returns {XorShift}
 */
export const makeXorShift = seed => {
  if (!(seed instanceof Uint8Array)) {
    throw TypeError('seed must be a Uint8Array');
  }
  if (seed.byteLength === 0 || seed.byteLength > SEED_BYTES) {
    throw RangeError(
      `seed must be 1..${SEED_BYTES} bytes (got ${seed.byteLength})`,
    );
  }
  const padded = new Uint8Array(SEED_BYTES);
  padded.set(seed, SEED_BYTES - seed.byteLength);
  // xorshift128+ has an absorbing fixed point at the all-zero state:
  // every output is `[0, 0]` and the state never recovers.  Reject it
  // up front to surface the misuse rather than letting it silently
  // produce a constant stream.
  if (!padded.some(b => b !== 0)) {
    throw RangeError('seed must not be all-zero (xorshift128+ fixed point)');
  }
  const dv = new DataView(padded.buffer, padded.byteOffset, SEED_BYTES);
  // `| 0` forces ToInt32, matching the upstream reference's signed
  // 32-bit arithmetic in the inner loop.
  let state0U = dv.getUint32(0, false) | 0;
  let state0L = dv.getUint32(4, false) | 0;
  let state1U = dv.getUint32(8, false) | 0;
  let state1L = dv.getUint32(12, false) | 0;

  /**
   * Returns a 64-bit random number as a 2x32-bit array.
   *
   * @returns {[number, number]}
   */
  const random64 = () => {
    // uint64_t s1 = s[0]
    let s1U = state0U;
    let s1L = state0L;
    // uint64_t s0 = s[1]
    const s0U = state1U;
    const s0L = state1L;

    // result = s0 + s1
    const sumL = (s0L >>> 0) + (s1L >>> 0);
    const resU = (s0U + s1U + ((sumL / 2) >>> 31)) >>> 0;
    const resL = sumL >>> 0;

    // s[0] = s0
    state0U = s0U;
    state0L = s0L;

    // - t1 = [0, 0]
    let t1U = 0;
    let t1L = 0;
    // - t2 = [0, 0]
    let t2U = 0;
    let t2L = 0;

    // s1 ^= s1 << 23;
    // :: t1 = s1 << 23
    const a1 = 23;
    const m1 = 0xffffffff << (32 - a1);
    t1U = (s1U << a1) | ((s1L & m1) >>> (32 - a1));
    t1L = s1L << a1;
    // :: s1 = s1 ^ t1
    s1U ^= t1U;
    s1L ^= t1L;

    // t1 = ( s1 ^ s0 ^ ( s1 >> 17 ) ^ ( s0 >> 26 ) )
    // :: t1 = s1 ^ s0
    t1U = s1U ^ s0U;
    t1L = s1L ^ s0L;
    // :: t2 = s1 >> 18
    const a2 = 18;
    const m2 = 0xffffffff >>> (32 - a2);
    t2U = s1U >>> a2;
    t2L = (s1L >>> a2) | ((s1U & m2) << (32 - a2));
    // :: t1 = t1 ^ t2
    t1U ^= t2U;
    t1L ^= t2L;
    // :: t2 = s0 >> 5
    const a3 = 5;
    const m3 = 0xffffffff >>> (32 - a3);
    t2U = s0U >>> a3;
    t2L = (s0L >>> a3) | ((s0U & m3) << (32 - a3));
    // :: t1 = t1 ^ t2
    t1U ^= t2U;
    t1L ^= t2L;

    // s[1] = t1
    state1U = t1U;
    state1L = t1L;

    // return result
    return [resU, resL];
  };

  const random = () => {
    const t2 = random64();
    // Math.pow(2, -32) = 2.3283064365386963e-10
    // Math.pow(2, -52) = 2.220446049250313e-16
    return (
      t2[0] * 2.3283064365386963e-10 + (t2[1] >>> 12) * 2.220446049250313e-16
    );
  };

  /**
   * @param {number} lo
   * @param {number} hi
   * @returns {number}
   */
  const int = (lo, hi) => {
    if (!Number.isSafeInteger(lo) || !Number.isSafeInteger(hi)) {
      throw TypeError('lo and hi must be safe integers');
    }
    if (lo >= hi) {
      throw RangeError('lo must be less than hi');
    }
    const range = hi - lo;
    if (!Number.isSafeInteger(range)) {
      throw RangeError('range exceeds Number.MAX_SAFE_INTEGER');
    }
    // Rejection-sample a uniform 53-bit integer in
    // `[0, floor(2^53 / range) * range)` to avoid modulo bias.
    // For ranges that divide 2^53 evenly the bound equals 2^53
    // and no draw is rejected.
    const bound = Math.floor(MAX_U53 / range) * range;
    for (;;) {
      const [hi32, lo32] = random64();
      // Assemble a 53-bit unsigned integer from a 64-bit draw:
      // 32 high bits scaled by 2^21, plus the top 21 bits of the
      // low half.  Stays within `Number.MAX_SAFE_INTEGER`.
      const u53 = hi32 * 0x200000 + (lo32 >>> 11);
      if (u53 < bound) {
        return lo + (u53 % range);
      }
    }
  };

  return harden({ random, int });
};
harden(makeXorShift);
