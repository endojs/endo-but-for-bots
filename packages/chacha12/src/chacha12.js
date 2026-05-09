// @ts-check
/* eslint no-bitwise: ["off"] */

// Pure-JavaScript ChaCha12 keystream generator.
//
// ChaCha12 is the 12-round variant of Daniel J. Bernstein's ChaCha
// stream cipher.  The block function is otherwise identical to
// ChaCha20 (same quarter round, same state layout, same "expand
// 32-byte k" constants, same little-endian conventions, same final
// state add).  The only difference is the loop count: 6
// double-rounds in ChaCha12 (= 12 rounds), 10 in ChaCha20.
//
// `makeChaCha12(key)` returns a `(out: Uint8Array) => void` function
// matching the `RandomSource` shape from `@endo/random`: the caller
// passes a buffer of any length and the keystream fills it.  The
// function-shaped result also lines up with `crypto.getRandomValues`
// (modulo the return value), so the two are interchangeable.
//
// `chacha12Block(state, out)` and `chacha12State(key, nonce?,
// counter?)` are exported for known-answer testing against
// block-function test vectors that supply a non-zero nonce and
// counter.

import harden from '@endo/harden';

const ROUNDS = 12;

/**
 * The size in bytes of one ChaCha12 keystream block.  Exported for
 * callers that want to align allocation with block boundaries.
 */
export const BLOCK_SIZE = 64;

// "expand 32-byte k", little-endian u32 of "expa", "nd 3", "2-by",
// "te k".  Same constants as ChaCha20.
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

// Module-scope working buffer for `chacha12Block`.  Reused across
// every block invocation; cleared in place rather than reallocated.
const WORKING = new Uint32Array(16);

/**
 * Computes one ChaCha12 keystream block.  `state` is a 16-word
 * Uint32Array organized like ChaCha20 (4 constants, 8 key words, 1
 * counter, 3 nonce).  `out` receives 64 bytes of little-endian
 * keystream.  Caller is responsible for incrementing the counter
 * between calls.
 *
 * Exported for known-answer testing against ChaCha12 vectors.
 *
 * @param {Uint32Array} state
 * @param {Uint8Array} out
 */
export const chacha12Block = (state, out) => {
  if (state.length !== 16) {
    throw TypeError('chacha12 state must be 16 u32 words');
  }
  if (out.length !== BLOCK_SIZE) {
    throw TypeError(`chacha12 output must be ${BLOCK_SIZE} bytes`);
  }
  const working = WORKING;
  for (let i = 0; i < 16; i += 1) working[i] = state[i];
  // 6 column-round + diagonal-round pairs = 12 rounds total.
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
  // Manual little-endian u32 writes.  A `DataView` is a clearer
  // expression of "endian-correct u32 store", but constructing one
  // per block-function call costs more than the writes save: a
  // microbenchmark on Node 22 / x64 found `new DataView` + 16
  // `setUint32` to be ~12% slower than scalar byte writes here.
  for (let i = 0; i < 16; i += 1) {
    const v = (working[i] + state[i]) >>> 0;
    const off = i * 4;
    out[off] = v & 0xff;
    out[off + 1] = (v >>> 8) & 0xff;
    out[off + 2] = (v >>> 16) & 0xff;
    out[off + 3] = (v >>> 24) & 0xff;
  }
  // Clear working state so no keystream-derived bits linger between
  // calls.
  for (let i = 0; i < 16; i += 1) working[i] = 0;
};
harden(chacha12Block);

/**
 * Builds a 16-word ChaCha12 state from a 32-byte key, optional
 * 12-byte nonce, and optional 32-bit counter.  Exported for ChaCha12
 * test vectors and reused by `makeChaCha12` below.
 *
 * @param {Uint8Array} key 32 bytes
 * @param {Uint8Array} [nonce] 12 bytes
 * @param {number} [counter] unsigned 32-bit
 * @returns {Uint32Array}
 */
export const chacha12State = (key, nonce = undefined, counter = 0) => {
  if (!(key instanceof Uint8Array) || key.length !== 32) {
    throw TypeError('chacha12 key must be a 32-byte Uint8Array');
  }
  if (nonce && (!(nonce instanceof Uint8Array) || nonce.length !== 12)) {
    throw TypeError('chacha12 nonce must be 12 bytes');
  }
  const state = new Uint32Array(16);
  state[0] = C0;
  state[1] = C1;
  state[2] = C2;
  state[3] = C3;
  // Manual little-endian u32 reads.  As with `chacha12Block` above,
  // constructing a `DataView` per call costs more than the reads
  // save: the bench measured `chacha12State(key, nonce)` ~3.4x
  // slower with DataView than with scalar byte loads on Node 22.
  for (let i = 0; i < 8; i += 1) {
    const off = i * 4;
    state[4 + i] =
      (key[off] |
        (key[off + 1] << 8) |
        (key[off + 2] << 16) |
        (key[off + 3] << 24)) >>>
      0;
  }
  state[12] = counter >>> 0;
  if (nonce) {
    state[13] =
      (nonce[0] | (nonce[1] << 8) | (nonce[2] << 16) | (nonce[3] << 24)) >>> 0;
    state[14] =
      (nonce[4] | (nonce[5] << 8) | (nonce[6] << 16) | (nonce[7] << 24)) >>> 0;
    state[15] =
      (nonce[8] | (nonce[9] << 8) | (nonce[10] << 16) | (nonce[11] << 24)) >>>
      0;
  }
  return state;
};
harden(chacha12State);

/**
 * Creates a ChaCha12-backed `RandomSource`: a function `(out:
 * Uint8Array) => void` that fills `out` with successive bytes of the
 * keystream produced by ChaCha12 with the supplied 32-byte key,
 * counter starting at 0, nonce all-zero.
 *
 * The function manages its own block buffer internally; callers may
 * request any number of bytes per call.  After `2 ** 32` blocks
 * (256 GiB of keystream) the counter would wrap; the function
 * throws `RangeError` instead.
 *
 * The returned function shape matches `crypto.getRandomValues` minus
 * the return value, and conforms to `@endo/random`'s `RandomSource`
 * type.
 *
 * `makeChaCha12` reads the key bytes once, into a private state
 * vector, and does not retain the supplied `Uint8Array` reference.
 * Callers do not need to defensively copy the key; passing a frozen
 * or shared key array is safe.
 *
 * @param {Uint8Array} key 32-byte key.
 * @returns {(out: Uint8Array) => void}
 */
export const makeChaCha12 = key => {
  const baseState = chacha12State(key);
  const block = new Uint8Array(BLOCK_SIZE);
  let offset = BLOCK_SIZE; // empty; first call refills.
  let counter = 0;

  const refill = () => {
    // Correctness guard at 256 GiB of keystream; not test-reachable.
    /* c8 ignore start */
    if (counter >= 0x100000000) {
      throw RangeError('chacha12 counter overflow (2^32 blocks exhausted)');
    }
    /* c8 ignore stop */
    baseState[12] = counter >>> 0;
    chacha12Block(baseState, block);
    counter += 1;
    offset = 0;
  };

  /** @param {Uint8Array} out */
  const fillRandomBytes = out => {
    let i = 0;
    const end = out.length;
    while (i < end) {
      if (offset >= BLOCK_SIZE) refill();
      const available = BLOCK_SIZE - offset;
      const want = end - i;
      const n = available < want ? available : want;
      for (let k = 0; k < n; k += 1) {
        out[i + k] = block[offset + k];
      }
      offset += n;
      i += n;
    }
  };

  return harden(fillRandomBytes);
};
harden(makeChaCha12);
