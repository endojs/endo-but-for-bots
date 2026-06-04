// @ts-nocheck

/**
 * Installs `Uint8Array[Symbol.for('fromText')]`.
 *
 * Encodes a string as UTF-8 bytes. Captures the realm's original
 * `TextEncoder` once at module load (stateless by spec) so a
 * compartment global endowment that later replaces `TextEncoder` on
 * `globalThis` does not redirect the encode operation.
 */

import {
  CapturedTextEncoder,
  CapturedUint8Array,
  installOrAdopt,
} from './install-helpers.js';

const symFromText = Symbol.for('fromText');

// eslint-disable-next-line new-cap
const capturedEncoder = new CapturedTextEncoder();

function installedFromText(s) {
  return capturedEncoder.encode(s);
}

export const installedFromTextValue = installOrAdopt(
  CapturedUint8Array,
  symFromText,
  installedFromText,
);

export { symFromText };
