// @ts-check

import harden from '@endo/harden';
import { CapturedTextDecoder } from './install-helpers.js';

/**
 * @typedef {object} BytesToTextOptions
 * @property {boolean} [fatal] When `true`, malformed UTF-8 throws instead of
 *   substituting U+FFFD.
 */

// Capture the realm's original `TextDecoder` once at module load
// (separate instances for the lenient and fatal modes) so a
// compartment global endowment that later replaces `TextDecoder` on
// `globalThis` does not redirect the decode operation. The capture is
// the load-bearing guarantee; no install on the intrinsic is needed,
// because each consumer of `@endo/bytes` reaches the same captured
// decoder through this module's exported callable.
// eslint-disable-next-line new-cap
const capturedLenientDecoder = new CapturedTextDecoder();
// eslint-disable-next-line new-cap
const capturedFatalDecoder = new CapturedTextDecoder('utf-8', { fatal: true });

/**
 * Decodes UTF-8 bytes to a string.
 *
 * Captures the realm's original `TextDecoder` once at module load, so
 * a compartment global endowment that later replaces `TextDecoder` on
 * `globalThis` does not redirect the decode operation.
 *
 * Pass `{ fatal: true }` for strict UTF-8 decoding (throws on
 * malformed UTF-8). Otherwise the lenient decoder substitutes the
 * Unicode replacement character (U+FFFD).
 *
 * @param {Uint8Array} view
 * @param {BytesToTextOptions} [options]
 * @returns {string}
 */
export const bytesToText = (view, options = undefined) => {
  if (options !== undefined && options.fatal) {
    return capturedFatalDecoder.decode(view);
  }
  return capturedLenientDecoder.decode(view);
};
harden(bytesToText);
