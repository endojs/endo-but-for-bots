// @ts-check
/* global globalThis */

/**
 * Web Crypto power for `makeMemoryCasStore`.
 *
 * The store deliberately does not bind to a platform: it accepts a
 * caller-supplied `sha256` function as part of its options.  Callers
 * that have Web Crypto (browsers, Node 19+, SES realms that retain
 * `globalThis.crypto.subtle`) wire in `sha256HexWebCrypto` here; a
 * Node-only host that prefers `node:crypto.createHash` could supply
 * its own equivalent without dragging Web Crypto into a context where
 * it is not available.
 *
 * This mirrors the daemon's `daemon-node-powers.js` vs
 * `daemon-go-powers.js` split: layer 1 stays platform-agnostic and a
 * companion "powers" module per platform binds the actual primitive.
 *
 * @import { Sha256Hex } from '../types.js';
 */

import { makeError, X } from '@endo/errors';

/**
 * Compute a SHA-256 hex digest of the bytes using Web Crypto.
 *
 * @type {Sha256Hex}
 */
export const sha256HexWebCrypto = async bytes => {
  // eslint-disable-next-line no-restricted-globals
  const crypto = globalThis.crypto;
  if (!crypto || !crypto.subtle) {
    throw makeError(
      X`sha256HexWebCrypto requires globalThis.crypto.subtle (Web Crypto)`,
    );
  }
  const digest = await crypto.subtle.digest(
    'SHA-256',
    /** @type {BufferSource} */ (/** @type {unknown} */ (bytes)),
  );
  const view = new Uint8Array(digest);
  let hex = '';
  for (let i = 0; i < view.length; i += 1) {
    const byte = view[i];
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
};
harden(sha256HexWebCrypto);
