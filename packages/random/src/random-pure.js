// @ts-check

// Pure-JavaScript wiring: ChaCha20 keystream from `./chacha20.js`,
// plumbed into the shared block-oriented PRNG in `./random.js`.

import harden from '@endo/harden';

import { makeChaCha20Source } from './chacha20.js';
import { makeRandomFromSource, assertSeed } from './random.js';

/** @import { Random } from './random.js' */

/**
 * Creates a ChaCha20-backed PRNG using the pure-JavaScript
 * keystream implementation.  Works in any ES2017+ environment,
 * including XS and SES vats.
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
