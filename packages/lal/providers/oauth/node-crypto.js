// @ts-check

/**
 * Node-backed crypto capabilities for the subscription-OAuth path: the SHA-256
 * and randomness the PKCE flow needs, plus an AES-256-GCM authenticated cipher
 * and a scrypt passphrase key-derivation for sealing credentials at rest.
 *
 * This is the one module in the OAuth path that reaches for `node:crypto`,
 * mirroring how `packages/daemon/src/daemon-node-powers.js` concentrates Node
 * crypto behind a powers object. The pure flow and the auth-storage exo take
 * the capabilities this module produces as injected arguments and never import
 * `node:crypto` themselves.
 *
 * The design calls for the encryption key to be "derived from the host's
 * passphrase or a hardware key per the existing daemon pattern". No such
 * daemon key-derivation exists yet, so `deriveKeyFromPassphrase` introduces
 * the passphrase path (scrypt); a hardware-key path and daemon-store wiring
 * are follow-ups.
 */

/** @import { Cipher, OAuthCryptoPowers } from './oauth.types.js' */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomFillSync,
  scryptSync,
} from 'node:crypto';

const AES_256_KEY_BYTES = 32;
const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;

/**
 * Concatenate byte arrays into a single Uint8Array.
 *
 * @param {Uint8Array[]} parts
 * @returns {Uint8Array}
 */
const concatBytes = parts => {
  let total = 0;
  for (const part of parts) {
    total += part.length;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

/**
 * SHA-256 digest of the given bytes.
 *
 * @param {Uint8Array} bytes
 * @returns {Uint8Array}
 */
export const sha256 = bytes =>
  new Uint8Array(createHash('sha256').update(bytes).digest());
harden(sha256);

/**
 * Fill `into` with cryptographically strong random bytes and return it.
 *
 * @param {Uint8Array} into
 * @returns {Uint8Array}
 */
export const getRandomValues = into => {
  randomFillSync(into);
  return into;
};
harden(getRandomValues);

/**
 * The crypto powers the PKCE flow needs, backed by `node:crypto`.
 *
 * @returns {OAuthCryptoPowers}
 */
export const makeNodeOAuthCryptoPowers = () =>
  harden({ sha256, getRandomValues });
harden(makeNodeOAuthCryptoPowers);

/**
 * An AES-256-GCM authenticated cipher over a 32-byte key. Each sealed blob is
 * `iv (12 bytes) || authTag (16 bytes) || ciphertext`, so decryption both
 * confirms integrity and rejects tampering.
 *
 * @param {Uint8Array} key - 32-byte AES-256 key
 * @returns {Cipher}
 */
export const makeAesGcmCipher = key => {
  if (key.length !== AES_256_KEY_BYTES) {
    throw new Error(
      `AES-256-GCM requires a ${AES_256_KEY_BYTES}-byte key; got ${key.length}.`,
    );
  }
  return harden({
    /** @param {Uint8Array} plaintext */
    encrypt(plaintext) {
      const iv = new Uint8Array(GCM_IV_BYTES);
      randomFillSync(iv);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const ciphertext = concatBytes([
        new Uint8Array(cipher.update(plaintext)),
        new Uint8Array(cipher.final()),
      ]);
      const tag = new Uint8Array(cipher.getAuthTag());
      return concatBytes([iv, tag, ciphertext]);
    },
    /** @param {Uint8Array} sealed */
    decrypt(sealed) {
      if (sealed.length < GCM_IV_BYTES + GCM_TAG_BYTES) {
        throw new Error('Sealed credential blob is too short to be valid.');
      }
      const iv = sealed.subarray(0, GCM_IV_BYTES);
      const tag = sealed.subarray(GCM_IV_BYTES, GCM_IV_BYTES + GCM_TAG_BYTES);
      const ciphertext = sealed.subarray(GCM_IV_BYTES + GCM_TAG_BYTES);
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(tag);
      return concatBytes([
        new Uint8Array(decipher.update(ciphertext)),
        new Uint8Array(decipher.final()),
      ]);
    },
  });
};
harden(makeAesGcmCipher);

/**
 * Derive a 32-byte AES key from a passphrase and salt via scrypt. The cost
 * parameters follow common interactive-login defaults; raise `cost` for a
 * larger work factor.
 *
 * @param {string} passphrase
 * @param {Uint8Array} salt
 * @param {{ keyLength?: number, cost?: number, blockSize?: number, parallelization?: number }} [options]
 * @returns {Uint8Array}
 */
export const deriveKeyFromPassphrase = (passphrase, salt, options = {}) => {
  const {
    keyLength = AES_256_KEY_BYTES,
    cost = 2 ** 14,
    blockSize = 8,
    parallelization = 1,
  } = options;
  const key = scryptSync(passphrase, salt, keyLength, {
    N: cost,
    r: blockSize,
    p: parallelization,
    maxmem: 128 * 1024 * 1024,
  });
  return new Uint8Array(key);
};
harden(deriveKeyFromPassphrase);
