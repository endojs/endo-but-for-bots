// @ts-nocheck

/**
 * Installs two text-decode operations on `Uint8Array`:
 *
 * - `Uint8Array[Symbol.for('toText')]`: lenient decoder; substitutes
 *   `U+FFFD` for malformed UTF-8.
 * - `Uint8Array[Symbol.for('toStrictText')]`: fatal decoder; throws on
 *   malformed UTF-8.
 *
 * Captures the realm's original `TextDecoder` once at module load
 * (separate instances for the lenient and fatal modes) so a
 * compartment global endowment that later replaces `TextDecoder` on
 * `globalThis` does not redirect the decode operation.
 */

import {
  CapturedTextDecoder,
  CapturedUint8Array,
  installOrAdopt,
} from './install-helpers.js';

const symToText = Symbol.for('toText');
const symToStrictText = Symbol.for('toStrictText');

// eslint-disable-next-line new-cap
const capturedLenientDecoder = new CapturedTextDecoder();
// eslint-disable-next-line new-cap
const capturedFatalDecoder = new CapturedTextDecoder('utf-8', { fatal: true });

function installedToText(view) {
  return capturedLenientDecoder.decode(view);
}

function installedToStrictText(view) {
  return capturedFatalDecoder.decode(view);
}

export const installedToTextValue = installOrAdopt(
  CapturedUint8Array,
  symToText,
  installedToText,
);

export const installedToStrictTextValue = installOrAdopt(
  CapturedUint8Array,
  symToStrictText,
  installedToStrictText,
);

export { symToText, symToStrictText };
