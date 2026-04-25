/* eslint no-bitwise: ["off"] */

import harden from '@endo/harden';

// Forked from CommonJS version at
// https://github.com/AndreasMadsen/xorshift/blob/d60ca9ca341957a9824908f733f30ce4592c9af4/xorshift.js

/**
 * @typedef {readonly [number, number, number, number]} XorShiftSeed
 *   A 128-bit seed expressed as four 32-bit integers in big-endian order.
 */

/**
 * @typedef {object} XorShift
 * @property {() => [number, number]} randomint
 *   Returns a 64-bit random number as a `[hi32, lo32]` pair where each
 *   element is a non-negative 32-bit integer.
 * @property {() => number} random
 *   Returns a random number in `[0, 1)`, like `Math.random()`.
 */

/**
 * Creates an xorshift128+ pseudorandom number generator.
 *
 * @param {XorShiftSeed | number[]} seed
 *   A 128-bit integer, expressed as four 32-bit integers in big-endian
 *   order.
 * @returns {XorShift}
 */
export const makeXorShift = seed => {
  if (!Array.isArray(seed) || seed.length !== 4) {
    throw TypeError('seed must be an array with 4 numbers');
  }

  // uint64_t s = [seed ...]
  let state0U = seed[0] | 0;
  let state0L = seed[1] | 0;
  let state1U = seed[2] | 0;
  let state1L = seed[3] | 0;

  /**
   * Returns a 64-bit random number as a 2x32-bit array.
   *
   * @returns {[number, number]}
   */
  const randomint = () => {
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

  /**
   * Returns a random number normalized to `[0, 1)`, like `Math.random()`.
   *
   * @returns {number}
   */
  const random = () => {
    const t2 = randomint();
    // Math.pow(2, -32) = 2.3283064365386963e-10
    // Math.pow(2, -52) = 2.220446049250313e-16
    return (
      t2[0] * 2.3283064365386963e-10 + (t2[1] >>> 12) * 2.220446049250313e-16
    );
  };

  return harden({ randomint, random });
};
harden(makeXorShift);
