// @ts-check
/* eslint-disable no-bitwise */

/**
 * Pure-JavaScript synchronous SHA-256 (FIPS 180-4), exported for the
 * browser condition and for cross-checking the host-backed builds in
 * tests.
 *
 * Synchronous by construction: the only in-graph consumer,
 * `makeBlobRefExo` in `@endo/platform/fs/extended`, computes its
 * content address inside a synchronous exo factory, so an async
 * digest (`crypto.subtle.digest`) cannot back it.  See
 * `designs/platform-neutral-hash.md` § Open questions.
 *
 * Lifted from the browser stand-in that used to live at
 * `packages/chat/node-crypto-shim.js`, which now re-exports from here.
 */

import harden from '@endo/harden';

import {
  DIGEST_LENGTH,
  assertBytes,
  assertRoomForDigest,
  byteLengthOf,
} from './shared.js';

const K = new Uint32Array([
  0x428a_2f98, 0x7137_4491, 0xb5c0_fbcf, 0xe9b5_dba5, 0x3956_c25b, 0x59f1_11f1,
  0x923f_82a4, 0xab1c_5ed5, 0xd807_aa98, 0x1283_5b01, 0x2431_85be, 0x550c_7dc3,
  0x72be_5d74, 0x80de_b1fe, 0x9bdc_06a7, 0xc19b_f174, 0xe49b_69c1, 0xefbe_4786,
  0x0fc1_9dc6, 0x240c_a1cc, 0x2de9_2c6f, 0x4a74_84aa, 0x5cb0_a9dc, 0x76f9_88da,
  0x983e_5152, 0xa831_c66d, 0xb003_27c8, 0xbf59_7fc7, 0xc6e0_0bf3, 0xd5a7_9147,
  0x06ca_6351, 0x1429_2967, 0x27b7_0a85, 0x2e1b_2138, 0x4d2c_6dfc, 0x5338_0d13,
  0x650a_7354, 0x766a_0abb, 0x81c2_c92e, 0x9272_2c85, 0xa2bf_e8a1, 0xa81a_664b,
  0xc24b_8b70, 0xc76c_51a3, 0xd192_e819, 0xd699_0624, 0xf40e_3585, 0x106a_a070,
  0x19a4_c116, 0x1e37_6c08, 0x2748_774c, 0x34b0_bcb5, 0x391c_0cb3, 0x4ed8_aa4a,
  0x5b9c_ca4f, 0x682e_6ff3, 0x748f_82ee, 0x78a5_636f, 0x84c8_7814, 0x8cc7_0208,
  0x90be_fffa, 0xa450_6ceb, 0xbef9_a3f7, 0xc671_78f2,
]);

/**
 * @param {number} x
 * @param {number} n
 * @returns {number}
 */
const rotr = (x, n) => (x >>> n) | (x << (32 - n));

/**
 * Pure-JavaScript `sha256Into`: writes the eight result words straight
 * into `out` at `offset`.  This is a caller-owns-the-destination
 * convenience, not a performance claim: like every build it still
 * allocates its padded copy of the input, so it saves a 32-byte
 * result array and nothing else.
 *
 * @param {Uint8Array} out
 * @param {Uint8Array} bytes
 * @param {number} [offset]
 * @returns {number} the number of bytes written (always 32)
 */
export const jsSha256Into = (out, bytes, offset = 0) => {
  assertRoomForDigest(out, offset);
  const data = assertBytes(bytes, 'bytes');
  // Read the length ONCE, through the intrinsic accessor.  Reading
  // `data.length` at each of the four sites below would let a
  // length-tracking view (or anything that can answer differently
  // between reads) pad one length and copy another, which is a wrong
  // digest rather than an error.
  const length = byteLengthOf(data);

  const h = new Uint32Array([
    0x6a09_e667, 0xbb67_ae85, 0x3c6e_f372, 0xa54f_f53a, 0x510e_527f,
    0x9b05_688c, 0x1f83_d9ab, 0x5be0_cd19,
  ]);
  // One 0x80 terminator plus the 8-byte big-endian bit length, rounded
  // up to a whole number of 64-byte blocks.  Computed by division, not
  // `>> 6`: the shift coerces to signed 32-bit, so at 2**31 - 8 bytes
  // it goes negative and `new Uint8Array` throws an opaque RangeError
  // while the node build hashes the same input happily.  The builds
  // must not diverge on any input.
  const paddedLength = (Math.floor((length + 8) / 64) + 1) * 64;
  const padded = new Uint8Array(paddedLength);
  if (length > 0) {
    // Skipped at zero length so a detached buffer digests as empty,
    // which is what `node:crypto` does with one.  `set` would throw on
    // it, and a build that throws where another returns a digest is
    // exactly the divergence this package exists to prevent.
    padded.set(data);
  }
  padded[length] = 0x80;
  const view = new DataView(padded.buffer);
  // The 64-bit big-endian bit length, written as one quantity rather
  // than decomposed into two 32-bit halves.
  view.setBigUint64(paddedLength - 8, BigInt(length) * 8n, false);

  const w = new Uint32Array(64);
  for (let block = 0; block < paddedLength; block += 64) {
    for (let i = 0; i < 16; i += 1) {
      w[i] = view.getUint32(block + i * 4, false);
    }
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let a = h[0];
    let b = h[1];
    let c = h[2];
    let d = h[3];
    let e = h[4];
    let f = h[5];
    let g = h[6];
    let hh = h[7];
    for (let i = 0; i < 64; i += 1) {
      const bigS1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + bigS1 + ch + K[i] + w[i]) | 0;
      const bigS0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (bigS0 + maj) | 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    h[0] = (h[0] + a) | 0;
    h[1] = (h[1] + b) | 0;
    h[2] = (h[2] + c) | 0;
    h[3] = (h[3] + d) | 0;
    h[4] = (h[4] + e) | 0;
    h[5] = (h[5] + f) | 0;
    h[6] = (h[6] + g) | 0;
    h[7] = (h[7] + hh) | 0;
  }

  // Write big-endian words by hand rather than through a `DataView`
  // over `out.buffer`: `out` may be a view with a non-zero
  // `byteOffset` into a larger buffer.
  for (let i = 0; i < 8; i += 1) {
    const word = h[i];
    const at = offset + i * 4;
    out[at] = (word >>> 24) & 0xff;
    out[at + 1] = (word >>> 16) & 0xff;
    out[at + 2] = (word >>> 8) & 0xff;
    out[at + 3] = word & 0xff;
  }
  return DIGEST_LENGTH;
};
harden(jsSha256Into);

/**
 * Pure-JavaScript one-shot SHA-256.
 *
 * @param {Uint8Array} bytes
 * @returns {Uint8Array} the raw 32-byte digest
 */
export const jsSha256 = bytes => {
  const digest = new Uint8Array(DIGEST_LENGTH);
  jsSha256Into(digest, bytes);
  return digest;
};
harden(jsSha256);
