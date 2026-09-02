// @ts-check

import harden from '@endo/harden';
import { frozenBytes, thawedBytes } from '@endo/immutable-arraybuffer';

import { concatBytes } from './concat.js';

/**
 * Concatenates a list of byteArray-passable values into a single hardened
 * frozen `Uint8Array` backed by an immutable `ArrayBuffer`.
 *
 * Equivalent to `frozenBytes(concatBytes(buffers.map(thawedBytes)))`,
 * provided as a single-call helper because the composition is common
 * when assembling protocol records from immutable byte fragments.
 *
 * The input element type is `Uint8Array` — the narrowed byteArray passable
 * shape (issue #573). Each element is thawed to a fresh mutable `Uint8Array`
 * before concatenation, so both a genuine frozen `Uint8Array` and the emulated
 * `@endo/immutable-arraybuffer` wrapper (typed `Uint8Array` but
 * `isView === false`) are handled by `thawedBytes`.
 *
 * This use as an `Array.prototype.map` callback relies on `thawedBytes`
 * ignoring the callback's index and array arguments. Consequently,
 * `thawedBytes` must remain unary and cannot grow an options-bag parameter.
 *
 * @param {ReadonlyArray<Uint8Array>} buffers
 * @returns {Uint8Array}
 */
export const concatImmutables = buffers =>
  frozenBytes(concatBytes(buffers.map(thawedBytes)));
harden(concatImmutables);
