import { decodeBase64 } from './decode.js';

/**
 * Decode Base64 with omitted trailing padding.
 *
 * Canonically padded input remains accepted so protocols may tolerate either
 * wire representation.
 *
 * @param {string} string Base64-encoded string
 * @param {string} [name] The name of the string as it will appear in error
 * messages.
 * @returns {Uint8Array}
 */
export const decodeBase64NoPadding = (string, name = '<unknown>') => {
  const remainder = string.length % 4;
  if (remainder === 1) {
    throw Error(
      `Invalid base64 string length ${string.length} for string ${name}`,
    );
  }
  const padded =
    remainder === 0 ? string : `${string}${'='.repeat(4 - remainder)}`;
  return decodeBase64(padded, name);
};
Object.freeze(decodeBase64NoPadding);
