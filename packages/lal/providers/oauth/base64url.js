// @ts-check

/**
 * Base64url (RFC 4648 §5) wrappers around `@endo/base64`. PKCE carries the
 * code challenge as base64url-without-padding, so we keep the conversion in
 * one place rather than coupling the flow to Node's `Buffer`. Mirrors the
 * equivalent helper in `@endo/goblin-chat`, kept local to avoid a
 * cross-package dependency.
 */

import { decodeBase64, encodeBase64 } from '@endo/base64';

/**
 * Encode bytes as base64url without trailing padding.
 *
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export const encodeBase64Url = bytes =>
  encodeBase64(bytes)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
harden(encodeBase64Url);

/**
 * Decode a base64url string (with or without padding) into bytes.
 *
 * @param {string} value
 * @param {string} [name]
 * @returns {Uint8Array}
 */
export const decodeBase64Url = (value, name) => {
  const standard = value.replaceAll('-', '+').replaceAll('_', '/');
  const padded = standard + '='.repeat((4 - (standard.length % 4)) % 4);
  return decodeBase64(padded, name);
};
harden(decodeBase64Url);
