// @ts-check
/* eslint-disable no-bitwise */

// This is the synchronous pure-JavaScript SHA-256 used under the `browser` and
// `default` export conditions. It is not a stopgap for missing platform crypto:
// the Web Crypto API exposes SHA-256 only through `crypto.subtle.digest`, which
// is asynchronous (it returns a `Promise<ArrayBuffer>`). `@endo/sha256`'s whole
// contract is a *synchronous* `Uint8Array -> Uint8Array` primitive, so Web
// Crypto cannot back it in a browser, and there is no synchronous digest to
// ponyfill against. This implementation is therefore the mainline evergreen
// browser path, not merely a legacy-XS fallback. (Node uses `node:crypto` and
// XS uses synchronous host streaming calls, both under their own conditions.)

import harden from '@endo/harden';

import { assertOutput, assertUint8Array } from './assert.js';

const { apply } = Reflect;
const { set: setUint8Array } = Uint8Array.prototype;

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

const rotateRight = (value, bits) => (value >>> bits) | (value << (32 - bits));

/** @param {Uint8Array} bytes */
export const sha256 = bytes => {
  assertUint8Array(bytes);
  const h = new Uint32Array([
    0x6a09_e667, 0xbb67_ae85, 0x3c6e_f372, 0xa54f_f53a, 0x510e_527f,
    0x9b05_688c, 0x1f83_d9ab, 0x5be0_cd19,
  ]);
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  const bitLength = BigInt(bytes.length) << 3n;
  view.setUint32(paddedLength - 4, Number(bitLength & 0xffff_ffffn), false);
  view.setUint32(paddedLength - 8, Number(bitLength >> 32n), false);

  const w = new Uint32Array(64);
  for (let block = 0; block < paddedLength; block += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(block + i * 4, false);
    for (let i = 16; i < 64; i += 1) {
      const s0 =
        rotateRight(w[i - 15], 7) ^
        rotateRight(w[i - 15], 18) ^
        (w[i - 15] >>> 3);
      const s1 =
        rotateRight(w[i - 2], 17) ^
        rotateRight(w[i - 2], 19) ^
        (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i += 1) {
      const t1 =
        (hh +
          (rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25)) +
          ((e & f) ^ (~e & g)) +
          K[i] +
          w[i]) |
        0;
      const t2 =
        ((rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22)) +
          ((a & b) ^ (a & c) ^ (b & c))) |
        0;
      [hh, g, f, e, d, c, b, a] = [
        g,
        f,
        e,
        (d + t1) | 0,
        c,
        b,
        a,
        (t1 + t2) | 0,
      ];
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
  const output = new Uint8Array(32);
  const outView = new DataView(output.buffer);
  for (let i = 0; i < 8; i += 1) outView.setUint32(i * 4, h[i] >>> 0, false);
  return output;
};
harden(sha256);

/**
 * @param {Uint8Array} output
 * @param {Uint8Array} bytes
 * @param {number} [offset]
 */
export const sha256Into = (output, bytes, offset = 0) => {
  assertOutput(output, offset);
  apply(setUint8Array, output, [sha256(bytes), offset]);
  return 32;
};
harden(sha256Into);
