// @ts-check
/* eslint-disable no-bitwise */

import harden from '@endo/harden';

const textEncoder = new TextEncoder();

const LABEL_PREFIX = 'slots/session/';

// SHA-256 constants — first 32 bits of the fractional parts of the
// cube roots of the first 64 primes (RFC 6234 §5.1).
const K = harden([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotr = (/** @type {number} */ x, /** @type {number} */ n) =>
  (x >>> n) | (x << (32 - n));

/**
 * Pure-JS SHA-256 of a Uint8Array.  No external dependency so the
 * package loads cleanly in any SES-flavoured host (Node, XS,
 * browsers).  Verified against the fixture digests pinned in
 * `test/session.test.js` and `rust/endo/slots/src/session.rs`.
 *
 * @param {Uint8Array} bytes
 * @returns {Uint8Array} 32 bytes
 */
const sha256 = bytes => {
  const ml = bytes.length;
  // Padded length: pad with 0x80, then zeros, then 8-byte big-endian
  // bit-length.  Round up to a multiple of 64.
  const withPad = (((ml + 9 + 63) >>> 6) << 6) >>> 0;
  const padded = new Uint8Array(withPad);
  padded.set(bytes);
  padded[ml] = 0x80;
  const bitLen = ml * 8;
  const bitHi = Math.floor(bitLen / 0x100000000) >>> 0;
  const bitLo = bitLen >>> 0;
  const dv = new DataView(padded.buffer);
  dv.setUint32(withPad - 8, bitHi, false);
  dv.setUint32(withPad - 4, bitLo, false);

  // Initial hash values (RFC 6234 §5.3.3).
  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;

  const w = new Uint32Array(64);
  for (let i = 0; i < withPad; i += 64) {
    for (let j = 0; j < 16; j += 1) {
      w[j] = dv.getUint32(i + j * 4, false);
    }
    for (let j = 16; j < 64; j += 1) {
      const s0 = rotr(w[j - 15], 7) ^ rotr(w[j - 15], 18) ^ (w[j - 15] >>> 3);
      const s1 = rotr(w[j - 2], 17) ^ rotr(w[j - 2], 19) ^ (w[j - 2] >>> 10);
      w[j] = (w[j - 16] + s0 + w[j - 7] + s1) >>> 0;
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;
    for (let j = 0; j < 64; j += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + s1 + ch + K[j] + w[j]) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const mj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + mj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  const out = new Uint8Array(32);
  const ov = new DataView(out.buffer);
  ov.setUint32(0, h0, false);
  ov.setUint32(4, h1, false);
  ov.setUint32(8, h2, false);
  ov.setUint32(12, h3, false);
  ov.setUint32(16, h4, false);
  ov.setUint32(20, h5, false);
  ov.setUint32(24, h6, false);
  ov.setUint32(28, h7, false);
  return out;
};

/**
 * Deterministic session identifier.  Must match
 * `slots::session::SessionId::from_label(label)` in the Rust crate:
 *
 *   SHA-256("slots/session/" || label.utf8()) → 32 bytes
 *
 * @param {string} label
 * @returns {Uint8Array} 32 bytes
 */
export const sessionIdFromLabel = label => {
  const bytes = textEncoder.encode(`${LABEL_PREFIX}${label}`);
  return sha256(bytes);
};
harden(sessionIdFromLabel);

/**
 * Hex encoding of a session id — useful for logs and diagnostics.
 *
 * @param {Uint8Array} id
 * @returns {string}
 */
export const sessionIdHex = id => {
  let out = '';
  for (let i = 0; i < id.length; i += 1) {
    const byte = id[i];
    out += (byte < 16 ? '0' : '') + byte.toString(16);
  }
  return out;
};
harden(sessionIdHex);
