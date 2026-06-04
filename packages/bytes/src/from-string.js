// @ts-check

import harden from '@endo/harden';
import { fromUtf8StringFunction } from './spackle-install.js';

/**
 * Encodes a string as UTF-8 bytes.
 *
 * Calls through to the realm's `Uint8Array[Symbol.for('fromUtf8String')]`
 * slot installed by the `@endo/bytes` spackle (see
 * `./spackle-install.js`). The spackle captures the realm's original
 * `TextEncoder` once at module load, so a compartment global
 * endowment that later replaces `TextEncoder` on `globalThis` does
 * not redirect the encode operation.
 *
 * @param {string} s
 * @returns {Uint8Array}
 */
export const bytesFromText = s => fromUtf8StringFunction(s);
harden(bytesFromText);
