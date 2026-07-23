// @ts-check

// Browser (and any non-Node, non-XS environment) implementation:
// pure-JS synchronous SHA-256. Lifted from `packages/chat/node-crypto-shim.js`.

import harden from '@endo/harden';

const K = new Uint32Array([
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

const rotr = (x, n) => (x >>> n) | (x << (32 - n));

/**
 * Compute the SHA-256 digest of a byte sequence.
 *
 * @param {Uint8Array} data
 * @returns {Uint8Array}  // length 32
 */
const sha256Core = harden((data) => {
  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f,
    0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const paddedLength = (((data.length + 8) >> 6) + 1) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(data);
  padded[data.length] = 0x80;
  const view = new DataView(padded.buffer);
  const bitLength = data.length * 8;
  view.setUint32(paddedLength - 4, bitLength >>> 0, false);
  view.setUint32(
    paddedLength - 8,
    Math.floor(bitLength / 0x1_0000_0000),
    false,
  );

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

  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < 8; i += 1) {
    outView.setUint32(i * 4, h[i] >>> 0, false);
  }
  return out;
});

/**
 * Encode a byte sequence using one of the encodings supported by
 * Node's `Buffer.toString(encoding)` and reachable from the
 * `@endo/platform/fs/extended` consumers (currently `'base64'` and `'hex'`).
 *
 * @param {Uint8Array} bytes
 * @param {string} encoding
 * @returns {string}
 */
const encodeBytes = (bytes, encoding) => {
  if (encoding === 'base64') return btoa(Array.from(bytes).map((b) => String.fromCharCode(b)).join(''));
  if (encoding === 'hex') return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
  throw new Error(`Unsupported digest encoding: ${encoding}`);
};

/**
 * One-shot SHA-256 over binary input, returning the raw 32-byte digest.
 * @param {Uint8Array} bytes
 * @returns {Uint8Array}  // length 32
 */
export const sha256 = harden((bytes) => sha256Core(bytes));

/**
 * Bring-your-own-buffer variant: write the 32-byte digest into `out`
 * at `offset` and return the number of bytes written (32). Throws
 * RangeError if `out.length - offset < 32`.
 * @param {Uint8Array} out
 * @param {Uint8Array} bytes
 * @param {number} [offset=0]
 * @returns {number}
 */
export const sha256Into = harden((out, bytes, offset = 0) => {
  if (out.length - offset < 32) {
    throw new RangeError('output buffer too small for SHA-256 digest');
  }
  out.set(sha256Core(bytes), offset);
  return 32;
});

/**
 * Minimal `crypto.createHash` replacement (SHA-256 only).
 *
 * Provided as a compatibility shim so packages that alias `node:crypto`
 * to this module continue to work without changes.
 *
 * @param {string} algorithm
 */
export const createHash = harden((algorithm) => {
  if (algorithm !== 'sha256') {
    throw new Error(
      `sha256 only supports 'sha256', got ${JSON.stringify(algorithm)}`,
    );
  }
  let buffer = new Uint8Array(0);
  const hasher = harden({
    /** @param {Uint8Array | string} chunk */
    update(chunk) {
      const next =
        typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk;
      const merged = new Uint8Array(buffer.length + next.length);
      merged.set(buffer);
      merged.set(next, buffer.length);
      buffer = merged;
      return hasher;
    },
    /** @param {string} [encoding] */
    digest(encoding) {
      const bytes = sha256Core(buffer);
      if (encoding !== undefined) {
        return encodeBytes(bytes, encoding);
      }
      // Override `toString` so the returned bytes are Buffer-like.
      Object.defineProperty(bytes, 'toString', {
        value: (enc) =>
          enc === undefined
            ? Uint8Array.prototype.toString.call(bytes)
            : encodeBytes(bytes, enc),
        writable: false,
        enumerable: false,
        configurable: false,
      });
      return bytes;
    },
  });
  return hasher;
});

harden({ sha256, sha256Into, createHash });
