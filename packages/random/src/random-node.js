// @ts-check
/* eslint no-bitwise: ["off"] */

// Node-only wiring: ChaCha20 keystream from `node:crypto`, plumbed
// into the shared block-oriented PRNG in `./random.js`.
//
// `crypto.createCipheriv('chacha20', key, iv16)` accepts a 16-byte
// IV: a 32-bit little-endian counter, then a 96-bit nonce.  This
// matches the OpenSSL convention used by the pure-JS path so output
// is bit-identical for the same seed.  We construct the cipher with
// counter = 0, nonce = 0; pulling each subsequent block automatically
// advances the cipher's internal counter, so we never need to
// reconstruct the cipher under normal operation.  We do reconstruct
// when the JS-side counter overflows 2^32, which is an error.

import { createCipheriv } from 'node:crypto';

import harden from '@endo/harden';

import { makeRandomFromSource, assertSeed } from './random.js';

/** @import { Random } from './random.js' */

const BLOCK_SIZE = 64;

// Reusable zero-filled block fed into the cipher to extract pure
// keystream bytes (encrypting zeros yields the keystream itself).
const ZERO_BLOCK = new Uint8Array(BLOCK_SIZE);

const makeNodeChaCha20Source = key => {
  const iv = new Uint8Array(16); // counter (4 LE) || nonce (12 zero)
  let cipher = createCipheriv('chacha20', key, iv);
  let counter = 0;

  const pullBlock = out => {
    if (!(out instanceof Uint8Array) || out.length !== BLOCK_SIZE) {
      throw TypeError('chacha20 pullBlock output must be a 64-byte Uint8Array');
    }
    if (counter >= 0x100000000) {
      throw RangeError('chacha20 counter overflow (2^32 blocks exhausted)');
    }
    // `cipher.update` with a Uint8Array input returns a Buffer.
    // Treat that Buffer as a Uint8Array view (Buffer extends
    // Uint8Array on Node) and copy the bytes — we never expose the
    // Buffer outside this module, satisfying the repo's "no Buffer"
    // policy at the public boundary.
    const ks = cipher.update(ZERO_BLOCK);
    if (ks.length !== BLOCK_SIZE) {
      // Defensive: createCipheriv('chacha20', ...) is a stream
      // cipher and emits 64 bytes per 64-byte input.  Node has held
      // this behaviour stable since 10.x; flag any deviation
      // loudly.
      throw Error(
        `chacha20 keystream block size mismatch: got ${ks.length}, want ${BLOCK_SIZE}`,
      );
    }
    for (let i = 0; i < BLOCK_SIZE; i += 1) out[i] = ks[i];
    counter += 1;
  };

  // Expose a recreate hook so callers in test / future use can reset
  // the keystream; not part of the public API.
  const reset = () => {
    cipher = createCipheriv('chacha20', key, iv);
    counter = 0;
  };

  return harden({ pullBlock, reset });
};

/**
 * Creates a ChaCha20-backed PRNG using `node:crypto`'s ChaCha20
 * cipher.  Output is bit-identical to {@link makeRandom} from
 * `./random-pure.js` for the same seed.
 *
 * @param {Uint8Array} seed 32-byte ChaCha20 key.
 * @returns {Random}
 */
export const makeRandom = seed => {
  assertSeed(seed);
  // `createCipheriv` accepts Uint8Array on Node 16+.
  const source = makeNodeChaCha20Source(seed);
  return makeRandomFromSource(source);
};
harden(makeRandom);
