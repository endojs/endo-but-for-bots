// @ts-check

import { bytesFromText } from '@endo/bytes/from-string.js';
import { toBytes } from '@endo/pass-style/to-bytes.js';
import { concatBytes } from '@endo/pass-style/concat-bytes.js';

const textEncoder = new TextEncoder();

/**
 * @typedef {import('../../src/codecs/components.js').OcapnLocation} OcapnLocation
 * @typedef {import('../../src/client/types.js').SessionId} SessionId
 * @typedef {import('../../src/client/types.js').PublicKeyId} PublicKeyId
 * @typedef {import('../../src/cryptography.js').OcapnPublicKey} OcapnPublicKey
 */

/**
 * @param {string} s
 * @returns {Uint8Array}
 */
const selectorSyrup = s => {
  const b = textEncoder.encode(s);
  return toBytes(bytesFromText(`${b.length}'${String.fromCharCode(...b)}`));
};

/**
 * @param {number} i
 * @returns {Uint8Array}
 */
export const intSyrup = i =>
  toBytes(bytesFromText(`${Math.floor(Math.abs(i))}${i < 0 ? '-' : '+'}`));

/**
 * @param {string} label
 * @param {Array<Uint8Array>} items
 * @returns {Uint8Array}
 */
export const recordSyrup = (label, ...items) =>
  concatBytes([
    toBytes(bytesFromText('<')),
    selectorSyrup(label),
    ...items,
    toBytes(bytesFromText('>')),
  ]);
