import harden from '@endo/harden';
import { Uint8ArrayCaptured } from './spackle-install.js';

/**
 * Concatenates a list of `Uint8Array` chunks into a single contiguous
 * `Uint8Array`.
 * Empty input yields an empty `Uint8Array`.
 *
 * Uses the realm's `Uint8Array` constructor as captured by the spackle
 * at module load (see `./spackle-install.js`); does not rely on the
 * post-lockdown `globalThis.Uint8Array` binding being unmodified.
 *
 * @param {readonly Uint8Array[]} chunks
 * @returns {Uint8Array}
 */
export const concatBytes = chunks => {
  let totalLength = 0;
  for (const chunk of chunks) {
    totalLength += chunk.length;
  }
  const result = new Uint8ArrayCaptured(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
};
harden(concatBytes);
