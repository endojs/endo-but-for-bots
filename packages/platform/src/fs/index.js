// @ts-check

export {
  looksLikeReadableBlob,
  readableBlobMethodGuards,
  readableTreeMethodGuards,
  readableNameHubMethodGuards,
  directoryFileMethodGuards,
  pathEntryMethodGuards,
  pathEntryIssuerMethodGuards,
  rangeReadMethodGuards,
  PathEntryInterface,
  PathEntryIssuerInterface,
  rangeAttenuationMethodGuards,
  recursiveListMethodGuards,
  ReadableBlobInterface,
  ReadableBlobRangeInterface,
  SnapshotBlobInterface,
  ReadableTreeInterface,
  SnapshotTreeInterface,
  TreeWriterInterface,
  FileInterface,
  DirectoryInterface,
} from './interfaces.js';

export {
  assertByteRange,
  assertLineRange,
  composeByteInterval,
  lineRangeToByteSlice,
} from './range-attenuation.js';

export { snapshotBlobMethods } from './snapshot-blob.js';
export { snapshotTreeMethods } from './snapshot-tree.js';
export { makeSnapshotStore } from './snapshot-store.js';
export { checkinTree } from './checkin.js';
export { checkoutTree } from './checkout.js';

export {
  makeSearch,
  provideSearch,
  compileGlobSegment,
  parseGlobPattern,
  DEFAULT_BATCH_SIZE,
  MAX_BATCH_SIZE,
  GLOB_MAX_RESULTS,
  GREP_MAX_RESULTS,
} from './search.js';

export { makeMaybeRealPath, isPathWithin } from './confinement.js';
