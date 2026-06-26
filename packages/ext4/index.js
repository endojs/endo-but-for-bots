// @ts-check

export { makeExt4Filesystem } from './src/fs-object.js';
export { makeExt4Reader } from './src/reader.js';
export { readSuperblock } from './src/superblock.js';
export {
  readInode,
  readInodeRange,
  readInodeContents,
  readSymbolicLink,
} from './src/inode.js';
export { readDirectory } from './src/directory.js';

/** @import { Ext4Reader } from './src/reader.js' */
/** @import { Superblock } from './src/superblock.js' */
/** @import { Inode } from './src/inode.js' */
/** @import { DirectoryEntry } from './src/directory.js' */
