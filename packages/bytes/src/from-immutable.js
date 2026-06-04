// @ts-check

import harden from '@endo/harden';
import { installedFromImmutableValue } from './install-from-immutable.js';

/**
 * Copies the contents of an immutable `ArrayBuffer` into a fresh
 * mutable `Uint8Array`.
 *
 * Calls through to the realm's `Uint8Array[Symbol.for('fromImmutable')]`
 * slot installed by `@endo/bytes` (see `./install-from-immutable.js`).
 * Immutable `ArrayBuffer` instances (proposal-immutable-arraybuffer)
 * cannot back a `Uint8Array` view directly, and APIs such as
 * `TextDecoder.decode` reject them. This helper produces a working
 * `Uint8Array` copy that callers can pass to those APIs.
 *
 * Accepts any `ArrayBufferLike` so callers do not need to narrow the
 * argument before invoking.
 *
 * @param {ArrayBufferLike} buffer
 * @returns {Uint8Array}
 */
export const bytesFromImmutable = buffer => {
  return /** @type {Uint8Array} */ (installedFromImmutableValue(buffer));
};
harden(bytesFromImmutable);
