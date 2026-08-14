// @ts-check
/* eslint-disable no-bitwise */

import harden from '@endo/harden';

const textEncoder = new TextEncoder();

const LABEL_PREFIX = 'slots/session/';

// SHA-256 constants — first 32 bits of the fractional parts of the
// cube roots of the first 64 primes (RFC 6234 §5.1).
const K = harden([
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
  const bitHi = Math.floor(bitLen / 0x1_0000_0000) >>> 0;
  const bitLo = bitLen >>> 0;
  const dv = new DataView(padded.buffer);
  dv.setUint32(withPad - 8, bitHi, false);
  dv.setUint32(withPad - 4, bitLo, false);

  // Initial hash values (RFC 6234 §5.3.3).
  let h0 = 0x6a09_e667;
  let h1 = 0xbb67_ae85;
  let h2 = 0x3c6e_f372;
  let h3 = 0xa54f_f53a;
  let h4 = 0x510e_527f;
  let h5 = 0x9b05_688c;
  let h6 = 0x1f83_d9ab;
  let h7 = 0x5be0_cd19;

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
 *   SHA-256("slots/session/" || label.utf8()) -> 32 bytes
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
