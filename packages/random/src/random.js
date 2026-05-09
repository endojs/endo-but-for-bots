// @ts-check

import harden from '@endo/harden';

import { randomUint53 } from './read-uint.js';

// 1 / 2 ** 53.  Multiplying a 53-bit non-negative integer by this
// produces a float in [0, 1) using deterministic integer arithmetic,
// so the same seed produces the same float across runs and engines.
const POW2_M53 = 1.1102230246251565e-16; // = 2 ** -53

/** @typedef {import('../random.types.d.ts').RandomSource} RandomSource */

/**
 * Returns a float in `[0, 1)`.
 *
 * `random` ensures that each respective returned value from streams
 * with the same seed is equal across runs and engines by internally
 * constructing a 53-bit integer and dividing it by `2 ** 53` (which
 * avoids engine-dependent rounding).
 *
 * @param {RandomSource} source
 * @returns {number}
 */
export const random = source => randomUint53(source) * POW2_M53;
harden(random);
