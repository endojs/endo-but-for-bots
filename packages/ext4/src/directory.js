// @ts-check
import { readInodeContents } from './inode.js';

/** @import { BlockDevice } from '@endo/block-device' */
/** @import { Superblock } from './superblock.js' */
/** @import { Inode } from './inode.js' */

// ext4 directory entry file types.
export const FT_REGULAR = 1;
export const FT_DIRECTORY = 2;
export const FT_SYMLINK = 7;

/**
 * @typedef {object} DirectoryEntry
 * @property {string} name
 * @property {number} ino Inode number of the entry's target.
 * @property {number} fileType One of the `FT_*` constants (0 if the volume
 *   lacks the filetype feature).
 */

/**
 * List the entries of a directory inode, excluding the `.`/`..` self and
 * parent links and any unused (inode 0) slots. The linked-list of
 * `ext4_dir_entry_2` records is walked across the directory's data blocks;
 * the trailing checksum "tail" record (inode 0) on `metadata_csum` volumes
 * is skipped naturally.
 *
 * @param {BlockDevice} device
 * @param {Superblock} sb
 * @param {Inode} inode A directory inode.
 * @returns {Promise<DirectoryEntry[]>}
 */
export const readDirectory = async (device, sb, inode) => {
  const data = await readInodeContents(device, sb, inode);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const decoder = new TextDecoder();
  /** @type {DirectoryEntry[]} */
  const entries = [];
  let p = 0;
  while (p + 8 <= data.length) {
    const ino = view.getUint32(p, true);
    const recLen = view.getUint16(p + 4, true);
    if (recLen < 8) {
      break;
    }
    const nameLen = sb.hasFiletype ? data[p + 6] : view.getUint16(p + 6, true);
    const fileType = sb.hasFiletype ? data[p + 7] : 0;
    if (ino !== 0 && nameLen > 0 && p + 8 + nameLen <= data.length) {
      const name = decoder.decode(data.subarray(p + 8, p + 8 + nameLen));
      if (name !== '.' && name !== '..') {
        entries.push({ name, ino, fileType });
      }
    }
    p += recLen;
  }
  return harden(entries);
};
harden(readDirectory);
