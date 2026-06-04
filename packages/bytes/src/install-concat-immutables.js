// @ts-nocheck

/**
 * Installs `ArrayBuffer[Symbol.for('concatImmutables')]`.
 *
 * Installed on the `ArrayBuffer` constructor rather than the prototype,
 * since the operation does not have a single buffer receiver: it
 * concatenates a list of immutable buffers into a fresh immutable
 * buffer.
 */

import { sliceBufferToImmutable } from '@endo/immutable-arraybuffer';
import {
  CapturedArrayBuffer,
  CapturedUint8Array,
  installOrAdopt,
} from './install-helpers.js';

const symConcatImmutables = Symbol.for('concatImmutables');

function concatImmutablesImpl(buffers) {
  let totalLength = 0;
  for (const b of buffers) {
    totalLength += b.byteLength;
  }
  const result = new CapturedUint8Array(totalLength);
  let offset = 0;
  for (const b of buffers) {
    result.set(new CapturedUint8Array(b.slice(0)), offset);
    offset += b.byteLength;
  }
  return sliceBufferToImmutable(
    result.buffer,
    result.byteOffset,
    result.byteOffset + result.byteLength,
  );
}

export const installedConcatImmutables = installOrAdopt(
  CapturedArrayBuffer,
  symConcatImmutables,
  concatImmutablesImpl,
);

export { symConcatImmutables };
