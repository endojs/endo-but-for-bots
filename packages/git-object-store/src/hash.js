// @ts-check

import { Fail, q } from '@endo/errors';
import harden from '@endo/harden';
import { encodeHex } from '@endo/hex/encode.js';
import { decodeHex } from '@endo/hex/decode.js';

/** @import { GitHashAlgorithm } from './types.js' */

/**
 * Raw digest byte length for each supported hash algorithm.
 *
 * @type {Readonly<Record<GitHashAlgorithm, number>>}
 */
export const OID_BYTE_LENGTH = harden({
  sha1: 20,
  sha256: 32,
});

/**
 * Hex character length for each supported hash algorithm.
 *
 * @type {Readonly<Record<GitHashAlgorithm, number>>}
 */
export const OID_HEX_LENGTH = harden({
  sha1: 40,
  sha256: 64,
});

/**
 * @param {string} algorithm
 * @returns {asserts algorithm is GitHashAlgorithm}
 */
export const assertHashAlgorithm = algorithm => {
  algorithm === 'sha1' ||
    algorithm === 'sha256' ||
    Fail`unsupported git hash algorithm ${q(algorithm)}`;
};
harden(assertHashAlgorithm);

/**
 * Normalize and validate a hex oid for the given algorithm.
 *
 * @param {GitHashAlgorithm} algorithm
 * @param {string} oid
 * @returns {string} lowercase hex oid
 */
export const assertOid = (algorithm, oid) => {
  assertHashAlgorithm(algorithm);
  (typeof oid === 'string' && oid.length === OID_HEX_LENGTH[algorithm]) ||
    Fail`oid for ${q(algorithm)} must be ${q(OID_HEX_LENGTH[algorithm])} hex characters, got ${q(oid)}`;
  // Round-trip through decode/encode to reject non-hex and normalize case.
  return encodeHex(decodeHex(oid, 'oid'));
};
harden(assertOid);

/**
 * @param {GitHashAlgorithm} algorithm
 * @param {Uint8Array} oidBytes
 * @returns {string}
 */
export const oidBytesToHex = (algorithm, oidBytes) => {
  assertHashAlgorithm(algorithm);
  oidBytes.byteLength === OID_BYTE_LENGTH[algorithm] ||
    Fail`oid bytes for ${q(algorithm)} must be length ${q(OID_BYTE_LENGTH[algorithm])}, got ${q(oidBytes.byteLength)}`;
  return encodeHex(oidBytes);
};
harden(oidBytesToHex);

/**
 * @param {GitHashAlgorithm} algorithm
 * @param {string} oidHex
 * @returns {Uint8Array}
 */
export const oidHexToBytes = (algorithm, oidHex) => {
  const normalized = assertOid(algorithm, oidHex);
  return decodeHex(normalized, 'oid');
};
harden(oidHexToBytes);
