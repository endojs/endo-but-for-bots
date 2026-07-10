export { QCLASS } from './src/encodeToCapData.js';
export { makeMarshal } from './src/marshal.js';
export { stringify, parse } from './src/marshal-stringify.js';

export { decodeToJustin, passableAsJustin, qp } from './src/marshal-justin.js';

export {
  makePassableKit,
  makeEncodePassable,
  makeDecodePassable,
  isEncodedRemotable,
  zeroPad,
  recordNames,
  recordValues,
} from './src/encodePassable.js';

export {
  compareNumerics,
  compareByCodePoints,
  assertRankSorted,
  compareRank,
  compareRankRemotablesTied,
  isRankSorted,
  sortByRank,
  compareAntiRank,
  compareAntiRankRemotablesTied,
  makeFullOrderComparatorKit,
  getPassStyleCover,
  intersectRankCovers,
  unionRankCovers,
} from './src/rankOrder.js';

// eslint-disable-next-line import/export
export * from './src/types.js';

/**
 * @deprecated Import these names from `@endo/pass-style` directly. `@endo/marshal`
 * plain-re-exports the `@endo/pass-style` surface (endojs/endo-but-for-bots#543):
 * importing a name through it rather than from the package that originally
 * exports it is discouraged, and this re-export is slated for removal in a
 * future major version.
 */
// eslint-disable-next-line import/export
export * from '@endo/pass-style';

/**
 * @deprecated Import `deeplyFulfilled` from `@endo/pass-style` directly.
 * `@endo/marshal` is a plain re-exporter of this name
 * (endojs/endo-but-for-bots#543): importing it through `@endo/marshal` rather
 * than from the package that originally exports it is discouraged, and this
 * re-export is slated for removal in a future major version.
 */
// eslint-disable-next-line import/export
export { deeplyFulfilled } from '@endo/pass-style';
