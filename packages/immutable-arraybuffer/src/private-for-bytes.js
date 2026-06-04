/**
 * INTERNAL SUBPATH: re-exports a minimal set of pony internals to
 * `@endo/bytes` so its freezable-TypedArray install can build pseudo
 * constructors that interoperate with this package's emulated
 * immutable buffers. This subpath is not part of the package's public
 * API; it is named `private-for-bytes.js` and not advertised in the
 * README, and it must not be imported from any package other than
 * `@endo/bytes`. Importing it elsewhere defeats the encapsulation of
 * the `hiddenBuffers` and `reverseHiddenBuffers` WeakMaps, which is a
 * documented security boundary of this package.
 */

export {
  hiddenBuffers,
  reverseHiddenBuffers,
  FERAL_GET_ARRAY_BUFFER,
  sliceBufferToImmutable,
} from './immutable-arraybuffer-pony-internal.js';

export { makeInternalHeir, getGetter } from './internal-heir.js';
