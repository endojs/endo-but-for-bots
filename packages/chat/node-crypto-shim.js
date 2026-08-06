// @ts-check

// Browser stand-in for the small `node:crypto` surface that chat reaches
// through @endo/platform/fs/extended. SHA-256 itself lives in @endo/sha256 so
// browser and XS consumers share one canonical implementation.

import harden from '@endo/harden';
import { sha256 } from '@endo/sha256';

/** @param {Uint8Array} bytes */
const toBase64 = bytes => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

/** @param {Uint8Array} bytes */
const toHex = bytes => {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
};

/**
 * @param {Uint8Array} bytes
 * @param {string} encoding
 */
const encodeBytes = (bytes, encoding) => {
  if (encoding === 'base64') return toBase64(bytes);
  if (encoding === 'hex') return toHex(bytes);
  throw Error(`Unsupported digest encoding: ${encoding}`);
};

/** @param {string} algorithm */
export const createHash = algorithm => {
  if (algorithm !== 'sha256') {
    throw Error(
      `node-crypto-shim only supports 'sha256', got ${JSON.stringify(algorithm)}`,
    );
  }
  let buffer = new Uint8Array(0);
  const hasher = {
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
      const bytes = sha256(buffer);
      if (encoding !== undefined) return encodeBytes(bytes, encoding);
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
