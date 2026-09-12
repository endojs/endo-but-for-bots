// @ts-check
import { sha256 } from '@noble/hashes/sha2.js';
import harden from '@endo/harden';

/** @import { FilePowers } from './files.js' */

/** @param {Uint8Array} bytes */
const toHex = bytes =>
  [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');

/**
 * SHA-256 over bytes, text, or a file. This is pure computation over
 * @noble/hashes, so it is not host authority; `sha256File` reads through
 * the injected {@link FilePowers}.
 *
 * @typedef {object} HashPowers
 * @property {(bytes: Uint8Array) => string} sha256Hex
 * @property {(path: string) => Promise<string>} sha256File
 *
 * @param {object} host
 * @param {FilePowers} host.files
 * @returns {HashPowers}
 */
export const makeHashPowers = ({ files }) =>
  harden({
    sha256Hex: bytes => toHex(sha256(bytes)),
    sha256File: async path => {
      const hash = sha256.create();
      for await (const chunk of files.readChunks(path)) hash.update(chunk);
      return toHex(hash.digest());
    },
  });
harden(makeHashPowers);
