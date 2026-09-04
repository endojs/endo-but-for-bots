import { encodeBase64 } from './encode.js';

/**
 * Encode bytes as Base64 without the canonical trailing padding.
 *
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export const encodeBase64NoPadding = bytes =>
  encodeBase64(bytes).replace(/=+$/, '');
Object.freeze(encodeBase64NoPadding);
