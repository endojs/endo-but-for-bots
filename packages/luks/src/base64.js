// @ts-check
/* global atob */

/**
 * Decode a standard (RFC 4648) base64 string to bytes. LUKS2 JSON metadata
 * encodes salts, digests, and similar binary fields as base64. Uses the
 * portable `atob` rather than Node's `Buffer` so the package runs unchanged
 * under XS, browsers, and SES realms.
 *
 * @param {string} text
 * @returns {Uint8Array}
 */
export const decodeBase64 = text => {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
};
harden(decodeBase64);
