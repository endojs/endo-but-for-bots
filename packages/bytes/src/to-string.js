// @ts-check

import harden from '@endo/harden';
import {
  installedToTextValue,
  installedToStrictTextValue,
} from './install-to-string.js';

/**
 * @typedef {object} BytesToTextOptions
 * @property {boolean} [fatal] When `true`, malformed UTF-8 throws instead of
 *   substituting U+FFFD.
 */

/**
 * Decodes UTF-8 bytes to a string.
 *
 * Calls through to one of two realm-wide installed slots on
 * `Uint8Array`:
 *
 * - `Uint8Array[Symbol.for('toText')]`: lenient decoder; substitutes
 *   the Unicode replacement character (U+FFFD) for malformed UTF-8.
 * - `Uint8Array[Symbol.for('toStrictText')]`: fatal decoder; throws on
 *   malformed UTF-8.
 *
 * Both slots are installed by `@endo/bytes` (see `./install-to-string.js`).
 * The install captures the realm's original `TextDecoder` instances
 * once at module load, so a compartment global endowment that later
 * replaces `TextDecoder` on `globalThis` does not redirect the decode
 * operation.
 *
 * Pass `{ fatal: true }` for strict UTF-8 decoding.
 *
 * @param {Uint8Array} view
 * @param {BytesToTextOptions} [options]
 * @returns {string}
 */
export const bytesToText = (view, options = undefined) => {
  if (options !== undefined && options.fatal) {
    return installedToStrictTextValue(view);
  }
  return installedToTextValue(view);
};
harden(bytesToText);
