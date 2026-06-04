// @ts-check

import harden from '@endo/harden';
import { toUtf8StringFunction } from './spackle-install.js';

/**
 * @typedef {object} BytesToTextOptions
 * @property {boolean} [fatal] When `true`, malformed UTF-8 throws instead of
 *   substituting U+FFFD.
 */

/**
 * Decodes UTF-8 bytes to a string.
 *
 * Calls through to the realm's `Uint8Array[Symbol.for('toUtf8String')]`
 * slot installed by the `@endo/bytes` spackle (see
 * `./spackle-install.js`). The spackle captures the realm's original
 * `TextDecoder` once at module load (both lenient and `fatal: true`
 * modes), so a compartment global endowment that later replaces
 * `TextDecoder` on `globalThis` does not redirect the decode
 * operation.
 *
 * Pass `{ fatal: true }` for strict UTF-8 decoding that throws on
 * invalid input. The default lenient mode substitutes the Unicode
 * replacement character (U+FFFD) for malformed sequences.
 *
 * @param {Uint8Array} view
 * @param {BytesToTextOptions} [options]
 * @returns {string}
 */
export const bytesToText = (view, options = undefined) =>
  toUtf8StringFunction(view, options);
harden(bytesToText);
