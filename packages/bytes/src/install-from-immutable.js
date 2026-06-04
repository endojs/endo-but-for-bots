// @ts-nocheck

/**
 * Installs `Uint8Array[Symbol.for('fromImmutable')]`.
 *
 * Returns a fresh mutable `Uint8Array` whose contents are a copy of an
 * immutable `ArrayBuffer`'s bytes. Immutable buffers cannot back a
 * `Uint8Array` view directly; this install gives application code a
 * realm-wide handle for the copy operation.
 */

import { CapturedUint8Array, installOrAdopt } from './install-helpers.js';

const symFromImmutable = Symbol.for('fromImmutable');

function installedFromImmutable(buffer) {
  return new CapturedUint8Array(buffer.slice(0));
}

export const installedFromImmutableValue = installOrAdopt(
  CapturedUint8Array,
  symFromImmutable,
  installedFromImmutable,
);

export { symFromImmutable };
