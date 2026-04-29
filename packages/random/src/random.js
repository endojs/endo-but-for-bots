// @ts-check
/* eslint no-bitwise: ["off"] */

// Block-oriented PRNG factory.  Consumes a `pullBlock(out)` callback
// that fills a 64-byte Uint8Array with the next ChaCha20 keystream
// block; serves bytes from a 64-byte buffer that is refilled on
// demand.  Pure-JS and Node-crypto backends share this file via
// `random-pure.js` and `random-node.js`.

import harden from '@endo/harden';

const BLOCK_SIZE = 64;

// 1 / 2 ** 53.  Multiplying a 53-bit non-negative integer by this
// produces a float in [0, 1) using deterministic integer arithmetic,
// so the same seed produces the same float across runs and engines.
const POW2_M53 = 1.1102230246251565e-16; // = 2 ** -53

/**
 * @typedef {object} Random
 * @property {() => number} random
 *   Returns a Number in `[0, 1)`, like `Math.random()` and aligned
 *   with the TC39 proposal-random-functions `random()` method.
 * @property {(lo: number, hi: number) => number} int
 *   Returns a uniformly distributed integer in the closed interval
 *   `[lo, hi]`.  Both bounds must be safe integers and `lo <= hi`.
 * @property {(n: number) => Uint8Array} bytes
 *   Returns a fresh `Uint8Array` of `n` random bytes.
 * @property {(buf: Uint8Array, start?: number, end?: number) => Uint8Array} fillBytes
 *   Fills the slice `[start, end)` of `buf` with random bytes.
 *   Returns `buf` for convenience.
 */

/**
 * Builds a {@link Random} on top of a block-oriented keystream
 * source.  The factory pulls 64-byte blocks lazily and serves bytes
 * from an internal buffer; it never holds more than one block of
 * keystream in memory.
 *
 * @param {{ pullBlock: (out: Uint8Array) => void }} source
 * @returns {Random}
 */
export const makeRandomFromSource = source => {
  const buffer = new Uint8Array(BLOCK_SIZE);
  let offset = BLOCK_SIZE; // empty; first call refills.

  const refill = () => {
    source.pullBlock(buffer);
    offset = 0;
  };

  // Read a single byte from the keystream.
  const readByte = () => {
    if (offset >= BLOCK_SIZE) refill();
    const b = buffer[offset];
    offset += 1;
    return b;
  };

  /**
   * @param {Uint8Array} out
   * @param {number} start
   * @param {number} end
   */
  const fillRange = (out, start, end) => {
    let i = start;
    while (i < end) {
      if (offset >= BLOCK_SIZE) refill();
      const available = BLOCK_SIZE - offset;
      const want = end - i;
      const n = available < want ? available : want;
      // Manual byte copy keeps the implementation portable across
      // engines that lack Uint8Array.prototype.set on overlapping
      // sources (none in practice, but harmless).
      for (let k = 0; k < n; k += 1) {
        out[i + k] = buffer[offset + k];
      }
      offset += n;
      i += n;
    }
  };

  /**
   * Pulls 8 keystream bytes, masks the high 11 bits to 0, and
   * divides the resulting 53-bit integer by `2 ** 53`.  The result
   * is a float in `[0, 1)`, deterministic for a given seed across
   * engines.
   */
  const random = () => {
    // Read 8 bytes from the buffer; assemble into a non-negative
    // 53-bit integer using two halves.
    //
    // High 32 bits: little-endian.  We mask off the top 11 bits to
    // leave 21 high bits + 32 low bits = 53 bits.
    const b0 = readByte();
    const b1 = readByte();
    const b2 = readByte();
    const b3 = readByte();
    const b4 = readByte();
    const b5 = readByte();
    const b6 = readByte();
    const b7 = readByte();
    const lo = (b0 | (b1 << 8) | (b2 << 16) | (b3 << 24)) >>> 0;
    // Mask top 11 bits of the high word to 0, keeping 21 bits.
    const hi = ((b4 | (b5 << 8) | (b6 << 16) | (b7 << 24)) >>> 0) & 0x1fffff;
    // hi * 2 ** 32 + lo, divided by 2 ** 53:
    //   = hi * 2 ** -21  +  lo * 2 ** -53
    // Computed as a single multiply by POW2_M53 of the 53-bit int.
    return (hi * 4294967296 + lo) * POW2_M53;
  };

  /**
   * @param {number} lo
   * @param {number} hi
   * @returns {number}
   */
  const int = (lo, hi) => {
    if (!Number.isInteger(lo) || !Number.isInteger(hi)) {
      throw TypeError('int: lo and hi must be integers');
    }
    if (lo > hi) {
      throw RangeError(`int: lo (${lo}) must be <= hi (${hi})`);
    }
    const range = hi - lo + 1;
    if (!Number.isSafeInteger(range)) {
      throw RangeError(
        `int: range hi - lo + 1 (${range}) must be a safe integer`,
      );
    }
    // Rejection sampling on the 53-bit float.  `random()` returns
    // values in `[0, 1)` drawn from `2 ** 53` equally likely buckets.
    // To eliminate modulo bias we discard the top
    // `(2 ** 53) % range` buckets so the remaining `floor(2 ** 53 /
    // range) * range` buckets divide evenly.
    //
    // Concretely: draw a 53-bit int u in `[0, 2 ** 53)`, retry if it
    // falls in the rejection zone, otherwise return `lo + (u %
    // range)`.  We obtain u by multiplying `random()` by `2 ** 53`,
    // which is exact because `random()` was constructed by dividing
    // a 53-bit int by `2 ** 53`.
    const limit = Math.floor(9007199254740992 / range) * range; // = 2 ** 53
    for (;;) {
      const u = random() * 9007199254740992; // back to a 53-bit int.
      if (u < limit) {
        return lo + (u % range);
      }
    }
  };

  /**
   * @param {Uint8Array} buf
   * @param {number} [start]
   * @param {number} [end]
   * @returns {Uint8Array}
   */
  const fillBytes = (buf, start = 0, end = buf.length) => {
    if (!(buf instanceof Uint8Array)) {
      throw TypeError('fillBytes: buf must be a Uint8Array');
    }
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < 0 ||
      end < start ||
      end > buf.length
    ) {
      throw RangeError(
        `fillBytes: invalid range [${start}, ${end}) for length ${buf.length}`,
      );
    }
    fillRange(buf, start, end);
    return buf;
  };

  /**
   * @param {number} n
   * @returns {Uint8Array}
   */
  const bytes = n => {
    if (!Number.isInteger(n) || n < 0) {
      throw RangeError(`bytes: n (${n}) must be a non-negative integer`);
    }
    const out = new Uint8Array(n);
    fillRange(out, 0, n);
    return out;
  };

  return harden({ random, int, bytes, fillBytes });
};
harden(makeRandomFromSource);

/**
 * Validates a 32-byte seed.  Shared by the pure-JS and Node entry
 * points so they reject the same inputs.
 *
 * @param {Uint8Array} seed
 */
export const assertSeed = seed => {
  if (!(seed instanceof Uint8Array)) {
    throw TypeError('seed must be a Uint8Array');
  }
  if (seed.length !== 32) {
    throw TypeError(
      `seed must be 32 bytes (got ${seed.length}); ChaCha20 keys are 256 bits`,
    );
  }
};
harden(assertSeed);
