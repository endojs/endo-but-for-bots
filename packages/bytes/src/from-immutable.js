// @ts-check

import { thawedBytes } from '@endo/immutable-arraybuffer';

/**
 * Copies the contents of a narrowed byteArray into a fresh mutable
 * `Uint8Array`.
 *
 * This compatibility name delegates to `thawedBytes`, preserving the
 * existing `@endo/bytes/from-immutable.js` entry point for master consumers.
 *
 * @param {Uint8Array} buffer
 * @returns {Uint8Array}
 */
export const bytesFromImmutable = thawedBytes;
