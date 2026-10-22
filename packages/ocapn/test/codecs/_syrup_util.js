// @ts-check

import { encodeUtf8 } from '@endo/utf8/encode.js';
import { frozenBytes } from '@endo/immutable-arraybuffer';
import { concatImmutables } from '@endo/bytes/concat-immutables.js';

const textEncoder = new TextEncoder();

/**
 * @import { OcapnLocation } from '../../src/codecs/components.js'
 * @import { PublicKeyId, SessionId } from '../../src/client/types.types.js'
 * @import { OcapnPublicKey } from '../../src/cryptography.js'
 */

/**
 * @param {string} s
 * @returns {Uint8Array}
 */
const selectorSyrup = s => {
  const b = textEncoder.encode(s);
  return frozenBytes(encodeUtf8(`${b.length}'${String.fromCharCode(...b)}`));
};

/**
 * @param {number} i
 * @returns {Uint8Array}
 */
export const intSyrup = i =>
  frozenBytes(encodeUtf8(`${Math.floor(Math.abs(i))}${i < 0 ? '-' : '+'}`));

/**
 * @param {string} label
 * @param {Array<Uint8Array>} items
 * @returns {Uint8Array}
 */
export const recordSyrup = (label, ...items) =>
  concatImmutables([
    frozenBytes(encodeUtf8('<')),
    selectorSyrup(label),
    ...items,
    frozenBytes(encodeUtf8('>')),
  ]);
