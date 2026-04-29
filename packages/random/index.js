// @ts-check

import harden from '@endo/harden';

import { makeChaCha20Source } from './src/chacha20.js';
import { makeRandomFromSource, assertSeed } from './src/random.js';

/** @import { Random } from './src/random.js' */

/**
 * Creates a ChaCha20-backed seedable PRNG.  Works in any ES2017+
 * environment, including browsers, XS, and SES vats.
 *
 * @param {Uint8Array} seed 32-byte ChaCha20 key.
 * @returns {Random}
 */
export const makeRandom = seed => {
  assertSeed(seed);
  const source = makeChaCha20Source(seed);
  return makeRandomFromSource(source);
};
harden(makeRandom);
