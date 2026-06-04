// @ts-check

import harden from '@endo/harden';
import { CapturedTextEncoder } from './install-helpers.js';

// Capture the realm's original `TextEncoder` once at module load (the
// constructor is stateless by spec) so a compartment global endowment
// that later replaces `TextEncoder` on `globalThis` does not redirect
// the encode operation. The capture is the load-bearing guarantee; no
// install on the intrinsic is needed, because each consumer of
// `@endo/bytes` reaches the same captured encoder through this
// module's exported callable.
// eslint-disable-next-line new-cap
const capturedEncoder = new CapturedTextEncoder();

/**
 * Encodes a string as UTF-8 bytes.
 *
 * Captures the realm's original `TextEncoder` once at module load, so
 * a compartment global endowment that later replaces `TextEncoder` on
 * `globalThis` does not redirect the encode operation.
 *
 * @param {string} s
 * @returns {Uint8Array}
 */
export const bytesFromText = s => capturedEncoder.encode(s);
harden(bytesFromText);
