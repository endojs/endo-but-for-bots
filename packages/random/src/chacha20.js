// @ts-check
/* eslint no-bitwise: ["off"] */

// Pure-JavaScript ChaCha20 keystream generator, per RFC 8439.
//
// `makeChaCha20Source(key)` exposes a block-oriented keystream that
// uses the OpenSSL / Node-crypto IV convention (32-bit
// little-endian counter prefix followed by 96-bit nonce, both zero
// here), so the keystream matches `crypto.createCipheriv('chacha20',
// key, iv16)` block-for-block.  The 32-bit counter wraps after
// `2 ** 32` blocks (256 GiB of keystream); the source throws if the
// caller tries to advance past that.
//
// `chacha20Block(state, out)` is exposed for known-answer testing
// against the RFC 8439 §2.3.2 vector, which uses a non-zero nonce
// and counter.

import harden from '@endo/harden';

const ROUNDS = 20;
const BLOCK_SIZE = 64;

// "expand 32-byte k", little-endian u32 of "expa", "nd 3", "2-by",
// "te k".  RFC 8439 §2.3.
const C0 = 0x61707865;
const C1 = 0x3320646e;
const C2 = 0x79622d32;
const C3 = 0x6b206574;

const rotl = (x, n) => ((x << n) | (x >>> (32 - n))) >>> 0;

const quarterRound = (state, a, b, c, d) => {
  let xa = state[a];
  let xb = state[b];
  let xc = state[c];
  let xd = state[d];
  xa = (xa + xb) >>> 0;
  xd = rotl(xd ^ xa, 16);
  xc = (xc + xd) >>> 0;
  xb = rotl(xb ^ xc, 12);
  xa = (xa + xb) >>> 0;
  xd = rotl(xd ^ xa, 8);
  xc = (xc + xd) >>> 0;
  xb = rotl(xb ^ xc, 7);
  state[a] = xa;
  state[b] = xb;
  state[c] = xc;
  state[d] = xd;
};

const readU32LE = (bytes, offset) =>
  (bytes[offset] |
    (bytes[offset + 1] << 8) |
    (bytes[offset + 2] << 16) |
    (bytes[offset + 3] << 24)) >>>
  0;

const writeU32LE = (bytes, offset, value) => {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
  bytes[offset + 3] = (value >>> 24) & 0xff;
};

/**
 * Computes one ChaCha20 keystream block.  `state` is a 16-word
 * Uint32Array organized per RFC 8439 §2.3 (4 constants, 8 key
 * words, 1 counter, 3 nonce).  `out` receives 64 bytes of
 * little-endian keystream.  Caller is responsible for incrementing
 * the counter between calls.
 *
 * Exported for known-answer testing against RFC 8439 vectors.
 *
 * @param {Uint32Array} state
 * @param {Uint8Array} out
 */
export const chacha20Block = (state, out) => {
  if (state.length !== 16) {
    throw TypeError('chacha20 state must be 16 u32 words');
  }
  if (out.length !== BLOCK_SIZE) {
    throw TypeError(`chacha20 output must be ${BLOCK_SIZE} bytes`);
  }
  const working = new Uint32Array(16);
  for (let i = 0; i < 16; i += 1) working[i] = state[i];
  // 10 column-round + diagonal-round pairs = 20 rounds total.
  for (let i = 0; i < ROUNDS; i += 2) {
    // Column round.
    quarterRound(working, 0, 4, 8, 12);
    quarterRound(working, 1, 5, 9, 13);
    quarterRound(working, 2, 6, 10, 14);
    quarterRound(working, 3, 7, 11, 15);
    // Diagonal round.
    quarterRound(working, 0, 5, 10, 15);
    quarterRound(working, 1, 6, 11, 12);
    quarterRound(working, 2, 7, 8, 13);
    quarterRound(working, 3, 4, 9, 14);
  }
  for (let i = 0; i < 16; i += 1) {
    writeU32LE(out, i * 4, (working[i] + state[i]) >>> 0);
  }
};
harden(chacha20Block);

/**
 * Builds a 16-word ChaCha20 state from a 32-byte key, 12-byte
 * nonce, and 32-bit counter.  Exported for RFC test vectors; the
 * `makeChaCha20Source` factory below uses a zero nonce per OpenSSL
 * convention.
 *
 * @param {Uint8Array} key 32 bytes
 * @param {Uint8Array} nonce 12 bytes
 * @param {number} counter unsigned 32-bit
 * @returns {Uint32Array}
 */
export const chacha20State = (key, nonce, counter) => {
  if (!(key instanceof Uint8Array) || key.length !== 32) {
    throw TypeError('chacha20 key must be 32 bytes');
  }
  if (!(nonce instanceof Uint8Array) || nonce.length !== 12) {
    throw TypeError('chacha20 nonce must be 12 bytes');
  }
  const state = new Uint32Array(16);
  state[0] = C0;
  state[1] = C1;
  state[2] = C2;
  state[3] = C3;
  for (let i = 0; i < 8; i += 1) state[4 + i] = readU32LE(key, i * 4);
  state[12] = counter >>> 0;
  state[13] = readU32LE(nonce, 0);
  state[14] = readU32LE(nonce, 4);
  state[15] = readU32LE(nonce, 8);
  return state;
};
harden(chacha20State);

/**
 * @typedef {object} ChaCha20Source
 * @property {(out: Uint8Array) => void} pullBlock
 *   Fills `out` (which must be exactly 64 bytes) with the next
 *   ChaCha20 keystream block.  Throws `RangeError` if the 32-bit
 *   counter has wrapped.
 */

/**
 * Creates a ChaCha20 keystream source from a 32-byte key, using the
 * OpenSSL convention: counter = 0, nonce = 0 (12 bytes of zero).
 * Output is bit-identical to
 * `crypto.createCipheriv('chacha20', key, new Uint8Array(16))`
 * fed zero plaintext.
 *
 * @param {Uint8Array} key 32-byte key.
 * @returns {ChaCha20Source}
 */
export const makeChaCha20Source = key => {
  if (!(key instanceof Uint8Array) || key.length !== 32) {
    throw TypeError('chacha20 key must be a 32-byte Uint8Array');
  }
  // Initial state, per RFC 8439 §2.3:
  //   state[0..3]   = constants ("expand 32-byte k")
  //   state[4..11]  = key (8 little-endian u32 words)
  //   state[12]     = block counter
  //   state[13..15] = nonce (zero in this PRNG)
  const baseState = new Uint32Array(16);
  baseState[0] = C0;
  baseState[1] = C1;
  baseState[2] = C2;
  baseState[3] = C3;
  for (let i = 0; i < 8; i += 1) {
    baseState[4 + i] = readU32LE(key, i * 4);
  }
  // counter = 0, nonce = 0 (already zeroed by Uint32Array).

  let counter = 0;

  const pullBlock = out => {
    if (!(out instanceof Uint8Array) || out.length !== BLOCK_SIZE) {
      throw TypeError(
        `chacha20 pullBlock output must be a ${BLOCK_SIZE}-byte Uint8Array`,
      );
    }
    if (counter >= 0x100000000) {
      throw RangeError('chacha20 counter overflow (2^32 blocks exhausted)');
    }
    baseState[12] = counter >>> 0;
    chacha20Block(baseState, out);
    counter += 1;
  };

  return harden({ pullBlock });
};
harden(makeChaCha20Source);
