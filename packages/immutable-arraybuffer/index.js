// The package's public exports. The narrowing to `isBufferImmutable` only
// is the destination state of the drop-the-pseudo-prototype redesign, but
// the bytes-side migration that retires `sliceBufferToImmutable` and
// `optTransferBufferToImmutable` as call sites is folded into the
// premise-2 follow-up PR (see packages/immutable-arraybuffer/DESIGN.md
// § Out of scope). Until premise-2 lands, the two free functions remain
// re-exported from the package surface so existing consumers (today
// `packages/bytes/src/to-immutable.js`) continue to work without
// disruption.
export {
  isBufferImmutable,
  sliceBufferToImmutable,
  optTransferBufferToImmutable,
} from './src/lib.js';
