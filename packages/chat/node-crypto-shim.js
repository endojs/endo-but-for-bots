// @ts-check

// Browser stand-in for the slice of `node:crypto` reachable from
// `@endo/platform/fs/extended` (`src/from-mount.js` and anything else that
// still hashes inline). Vite aliases `node:crypto` to this module for the
// chat bundle.
//
// The SHA-256 itself is not implemented here: it is `@endo/sha256`'s
// pure-JS build, which this file's digest used to be a copy of. Only the
// `createHash` streaming shape that `node:crypto` callers expect lives
// here. A real digest (rather than a placeholder) matters because the
// explorer's content-addressed read cache (`withCachedReads`) keys blobs on
// it, and a weaker hash could serve one file's bytes for another.

import harden from '@endo/harden';
import { jsSha256 } from '@endo/sha256/src/sha256-js.js';

/**
 * @param {Uint8Array} bytes
 * @returns {string}
 */
const toBase64 = bytes => {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
};

/**
 * @param {Uint8Array} bytes
 * @returns {string}
 */
const toHex = bytes => {
  let out = '';
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, '0');
  }
  return out;
};

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
  if (encoding === 'base64') return toBase64(bytes);
  if (encoding === 'hex') return toHex(bytes);
  throw new Error(`Unsupported digest encoding: ${encoding}`);
};

/**
 * Minimal `crypto.createHash` replacement (SHA-256 only).
 *
 * Throws for any algorithm other than `'sha256'` so consumers that
 * silently expected MD5/SHA-1/etc. fail fast — `node:crypto`
 * likewise throws (`ERR_OSSL_EVP_UNSUPPORTED`) on unknown
 * algorithms rather than degrading to a different digest.
 *
 * @param {string} algorithm
 */
export const createHash = algorithm => {
  if (algorithm !== 'sha256') {
    throw new Error(
      `node-crypto-shim only supports 'sha256', got ${JSON.stringify(algorithm)}`,
    );
  }
  let buffer = new Uint8Array(0);
  const hasher = {
    /**
     * @param {Uint8Array | string} chunk
     */
    update(chunk) {
      const next =
        typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk;
      const merged = new Uint8Array(buffer.length + next.length);
      merged.set(buffer);
      merged.set(next, buffer.length);
      buffer = merged;
      return hasher;
    },
    /**
     * Returns the raw digest bytes or, when an encoding is given,
     * a string. The bytes case returns a `Uint8Array` whose
     * `toString(encoding)` mimics Node's `Buffer` so callers
     * can do `hashBytes.toString('base64')` and `h[i]`
     * interchangeably.
     *
     * @param {string} [encoding]
     * @returns {Uint8Array | string}
     */
    digest(encoding) {
      const bytes = jsSha256(buffer);
      if (encoding !== undefined) {
        return encodeBytes(bytes, encoding);
      }
      // Override `toString` so the returned bytes are Buffer-like.
      // Without this, `bytes.toString('base64')` falls through to
      // `Uint8Array.prototype.toString`, which ignores its argument
      // and returns a comma-separated decimal listing.
      Object.defineProperty(bytes, 'toString', {
        value: (/** @type {string} */ enc) =>
          enc === undefined
            ? Uint8Array.prototype.toString.call(bytes)
            : encodeBytes(bytes, enc),
        writable: false,
        enumerable: false,
        configurable: false,
      });
      return bytes;
    },
  };
  return hasher;
};
harden(createHash);

export default harden({ createHash });
