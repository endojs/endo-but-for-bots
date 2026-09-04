// @ts-check

import { frozenBytes } from '@endo/immutable-arraybuffer';

/**
 * Wraps a `Uint8Array` view's contents in a hardened frozen `Uint8Array`
 * backed by an immutable `ArrayBuffer`.
 *
 * This compatibility name now delegates to `frozenBytes`, preserving the
 * existing `@endo/bytes/to-immutable.js` entry point while returning the
 * narrowed `byteArray` passable shape.
 *
 * Honors the view's `byteOffset` and `byteLength`, so passing a
 * `subarray` copies only that window.
 *
 * @param {Uint8Array} view
 * @returns {Uint8Array}
 */
export const bytesToImmutable = frozenBytes;
