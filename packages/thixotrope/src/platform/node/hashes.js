// @ts-check
/** @import { FilePowers } from '../files.js' */
/** @import { HashPowers, Sha256 } from '../hashes.js' */
import harden from '@endo/harden';

/**
 * SHA-256 over Node's `crypto`. The hash object stays inside this module;
 * callers receive hex text.
 *
 * @param {object} host
 * @param {import('crypto')['createHash']} host.createHash
 * @param {FilePowers['readChunks']} host.readChunks
 * @returns {HashPowers}
 */
export const makeHashPowers = ({ createHash, readChunks }) => {
  /** @returns {Sha256} */
  const makeSha256 = () => {
    const hash = createHash('sha256');
    return harden({
      update: bytes => {
        hash.update(bytes);
      },
      digestHex: () => hash.digest('hex'),
    });
  };
  return harden({
    makeSha256,
    sha256Hex: bytes => createHash('sha256').update(bytes).digest('hex'),
    sha256File: async path => {
      const hash = makeSha256();
      for await (const chunk of readChunks(path)) hash.update(chunk);
      return hash.digestHex();
    },
  });
};
harden(makeHashPowers);
