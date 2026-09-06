// @ts-check

import { createHash } from 'node:crypto';

import harden from '@endo/harden';

import { assertHashAlgorithm } from './hash.js';

/** @import { GitDigest } from './types.js' */

/**
 * Node.js `digest` power for git object hashing.
 *
 * @type {GitDigest}
 */
export const nodeDigest = (algorithm, bytes) => {
  assertHashAlgorithm(algorithm);
  // node:crypto names match our algorithm ids for sha1/sha256.
  const hash = createHash(algorithm);
  hash.update(bytes);
  return new Uint8Array(hash.digest());
};
harden(nodeDigest);
