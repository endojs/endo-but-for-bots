// @ts-check

/**
 * Goblins-style manual persistence for Hardened JavaScript: portraits,
 * persistence environments, and portrait-graph heaps over pluggable
 * stores, designed to plug into `@endo/ocapn` through its locator seam
 * (see `./src/ocapn.js`). See `designs/ocapn-persistence.md` at the
 * repository root for the design.
 */

export { makePersistenceEnv, persistenceEnvCompose } from './src/env.js';
export {
  definePersistentExoClass,
  definePersistentExoClassKit,
  getInstanceBinding,
} from './src/class.js';
export { makePersistentHeap } from './src/heap.js';
export { makeMemoryPortraitStore, mergeDelta } from './src/stores/memory.js';
export { makeFilePortraitStore } from './src/stores/file.js';
