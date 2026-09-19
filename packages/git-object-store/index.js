// @ts-check

export { parseBlob, serializeBlob } from './src/codec-blob.js';
export {
  formatIdentity,
  parseCommit,
  parseIdentity,
  serializeCommit,
} from './src/codec-commit.js';
export { parseTag, serializeTag } from './src/codec-tag.js';
export {
  isTreeMode,
  parseTree,
  serializeTree,
  treeSortKey,
} from './src/codec-tree.js';
export { fetchBytes, storeBytes } from './src/content-bytes.js';
export { assertObjectType, frameObject, hashObject } from './src/frame.js';
export {
  DEFAULT_READ_BATCH_SIZE,
  makeGitObjectStore,
  MAX_READ_BATCH_SIZE,
} from './src/git-object-store.js';
export {
  assertHashAlgorithm,
  assertOid,
  OID_BYTE_LENGTH,
  OID_HEX_LENGTH,
  oidBytesToHex,
  oidHexToBytes,
} from './src/hash.js';
export { makeMemoryOidIndex } from './src/oid-index.js';
export {
  GIT_OID_INDEX_SCHEMA,
  makeSqliteOidIndex,
} from './src/sqlite-oid-index.js';
export { diffCommits, diffTrees, walkCommitLog, walkTree } from './src/walk.js';

// eslint-disable-next-line import/export
export * from './types-index.js';
