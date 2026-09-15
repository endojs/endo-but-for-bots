// @ts-check

import { bytesFromText } from '@endo/bytes/from-string.js';
import { Fail, q } from '@endo/errors';
import harden from '@endo/harden';
import { encodeHex } from '@endo/hex/encode.js';

import { assertHashAlgorithm } from './hash.js';

/** @import { GitDigest, GitHashAlgorithm, GitObjectType } from './types.js' */

/**
 * @type {ReadonlySet<string>}
 */
const OBJECT_TYPES = new Set(['blob', 'tree', 'commit', 'tag']);

/**
 * @param {string} type
 * @returns {asserts type is GitObjectType}
 */
export const assertObjectType = type => {
  OBJECT_TYPES.has(type) || Fail`unsupported git object type ${q(type)}`;
};
harden(assertObjectType);

/**
 * Build the canonical git object framing bytes
 * `<type> <length>\0<content>` used for oid hashing.
 * These bytes are *not* stored in the CAS; only `content` is.
 *
 * @param {GitObjectType} type
 * @param {Uint8Array} content
 * @returns {Uint8Array}
 */
export const frameObject = (type, content) => {
  assertObjectType(type);
  content instanceof Uint8Array ||
    Fail`git object content must be a Uint8Array`;
  const header = bytesFromText(`${type} ${content.byteLength}\0`);
  const framed = new Uint8Array(header.byteLength + content.byteLength);
  framed.set(header, 0);
  framed.set(content, header.byteLength);
  return framed;
};
harden(frameObject);

/**
 * Compute a git object id from type + content.
 *
 * @param {GitHashAlgorithm} algorithm
 * @param {GitDigest} digest
 * @param {GitObjectType} type
 * @param {Uint8Array} content
 * @returns {string} lowercase hex oid
 */
export const hashObject = (algorithm, digest, type, content) => {
  assertHashAlgorithm(algorithm);
  const framed = frameObject(type, content);
  return encodeHex(digest(algorithm, framed));
};
harden(hashObject);
