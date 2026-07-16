// @ts-check

export { makeMemoryBlockDevice } from './src/memory.js';
export { makeSlicedBlockDevice } from './src/slice.js';
export { makeCachingBlockDevice } from './src/cache.js';
export { assertReadRange } from './src/assert.js';

/** @import { BlockDevice } from './src/types.js' */
/** @typedef {import('./src/types.js').BlockDevice} BlockDevice */
