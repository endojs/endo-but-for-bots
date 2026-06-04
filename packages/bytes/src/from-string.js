// @ts-check

import harden from '@endo/harden';
import { installedFromTextValue } from './install-from-string.js';

/**
 * Encodes a string as UTF-8 bytes.
 *
 * Calls through to the realm's `Uint8Array[Symbol.for('fromText')]`
 * slot installed by `@endo/bytes` (see `./install-from-string.js`).
 * The install captures the realm's original `TextEncoder` once at
 * module load, so a compartment global endowment that later replaces
 * `TextEncoder` on `globalThis` does not redirect the encode
 * operation.
 *
 * @param {string} s
 * @returns {Uint8Array}
 */
export const bytesFromText = s => installedFromTextValue(s);
harden(bytesFromText);
