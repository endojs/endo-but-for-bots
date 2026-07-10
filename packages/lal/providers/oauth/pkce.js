// @ts-check

/**
 * Proof Key for Code Exchange (PKCE, RFC 7636) helpers for the subscription
 * OAuth flow. The S256 method is the only one implemented: `plain` is
 * omitted deliberately because every subscription provider Lal targets
 * (Claude, ChatGPT, GitHub Copilot) supports S256, and `plain` offers no
 * protection against an intercepted authorization request.
 *
 * The randomness source and the SHA-256 digest are injected (see
 * `OAuthCryptoPowers`) rather than reached for as ambient authority, so this
 * module is pure and testable and carries no Node coupling.
 */

/** @import { OAuthCryptoPowers, PkcePair } from './oauth.types.js' */

import { bytesFromText } from '@endo/bytes/from-string.js';
import { encodeBase64Url } from './base64url.js';

// 32 random bytes base64url-encode to a 43-character verifier, within the
// RFC 7636 §4.1 range of 43 to 128 characters.
const CODE_VERIFIER_BYTES = 32;

/**
 * Generate a fresh PKCE code verifier: a high-entropy base64url string.
 *
 * @param {(into: Uint8Array) => Uint8Array} getRandomValues
 * @returns {string}
 */
export const generateCodeVerifier = getRandomValues => {
  const bytes = new Uint8Array(CODE_VERIFIER_BYTES);
  getRandomValues(bytes);
  return encodeBase64Url(bytes);
};
harden(generateCodeVerifier);

/**
 * Derive the S256 code challenge for a verifier:
 * `BASE64URL(SHA256(ASCII(code_verifier)))`.
 *
 * @param {string} codeVerifier
 * @param {(bytes: Uint8Array) => Uint8Array} sha256
 * @returns {string}
 */
export const computeCodeChallenge = (codeVerifier, sha256) => {
  const digest = sha256(bytesFromText(codeVerifier));
  return encodeBase64Url(digest);
};
harden(computeCodeChallenge);

/**
 * Generate a verifier and its matching S256 challenge in one step.
 *
 * @param {OAuthCryptoPowers} powers
 * @returns {PkcePair}
 */
export const generatePkcePair = ({ getRandomValues, sha256 }) => {
  const codeVerifier = generateCodeVerifier(getRandomValues);
  const codeChallenge = computeCodeChallenge(codeVerifier, sha256);
  return harden({
    codeVerifier,
    codeChallenge,
    codeChallengeMethod: /** @type {'S256'} */ ('S256'),
  });
};
harden(generatePkcePair);
