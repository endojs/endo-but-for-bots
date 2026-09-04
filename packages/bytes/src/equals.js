import harden from '@endo/harden';
import { toIndexableUint8Array } from './indexed.js';

/**
 * Compares two byte sequences byte-for-byte.
 * Returns `true` when the two have equal length and equal contents.
 *
 * Accepts a frozen `Uint8Array` backed by an immutable `ArrayBuffer`
 * (the byteArray passable form) or a plain mutable `Uint8Array`.
 * A genuine view is compared in place; an emulated
 * `@endo/immutable-arraybuffer` wrapper
 * (typed `Uint8Array` but `isView(wrapper) === false`, so `bytes[i]` reads
 * `undefined`) is first thawed into a mutable `Uint8Array` so that
 * integer-indexed comparison works correctly.
 *
 * @param {Uint8Array} a
 * @param {Uint8Array} b
 * @returns {boolean}
 */
export const bytesEqual = (a, b) => {
  if (a === b) {
    return true;
  }
  const l = toIndexableUint8Array(a);
  const r = toIndexableUint8Array(b);
  if (l.length !== r.length) {
    return false;
  }
  for (let i = 0; i < l.length; i += 1) {
    if (l[i] !== r[i]) {
      return false;
    }
  }
  return true;
};
harden(bytesEqual);
