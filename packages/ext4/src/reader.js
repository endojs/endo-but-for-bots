// @ts-check
import { makeError, q, X } from '@endo/errors';

import { readSuperblock } from './superblock.js';
import {
  readInode,
  readInodeRange,
  readInodeContents,
  readSymbolicLink,
} from './inode.js';
import { readDirectory } from './directory.js';

/** @import { BlockDevice } from '@endo/block-device' */
/** @import { Inode } from './inode.js' */
/** @import { DirectoryEntry } from './directory.js' */

// The root directory is always inode 2 in ext2/3/4.
const ROOT_INODE = 2;

/**
 * Normalize a path argument (a `'a/b'` string or `['a','b']` segments) into
 * a flat array of non-empty segments, rejecting traversal (`..`) and NUL,
 * matching the segment discipline of Endo's `ReadableTree` surface.
 *
 * @param {string | string[]} path
 * @returns {string[]}
 */
const normalizeSegments = path => {
  const parts = typeof path === 'string' ? [path] : path;
  /** @type {string[]} */
  const out = [];
  for (const part of parts) {
    for (const seg of part.split('/')) {
      if (seg === '' || seg === '.') {
        // skip
      } else if (seg === '..') {
        throw makeError(X`Path traversal segment ${q('..')} is not allowed`);
      } else if (seg.includes('\0')) {
        throw makeError(X`Path segment contains NUL: ${q(seg)}`);
      } else {
        out.push(seg);
      }
    }
  }
  return out;
};
harden(normalizeSegments);

/**
 * @typedef {object} Ext4Reader
 * @property {import('./superblock.js').Superblock} superblock
 * @property {Inode} root The root directory inode.
 * @property {(ino: number) => Promise<Inode>} getInode
 * @property {(inode: Inode) => Promise<DirectoryEntry[]>} listDirectory
 * @property {(inode: Inode, offset: number, length: number) => Promise<Uint8Array>} readRange
 * @property {(inode: Inode) => Promise<Uint8Array>} readContents
 * @property {(inode: Inode) => Promise<string>} readSymlink
 * @property {(path: string | string[]) => Promise<Inode | undefined>} maybeResolve
 * @property {(path: string | string[]) => Promise<Inode>} resolve
 */

/**
 * Build a read-only ext2/3/4 reader over a block device. All reads are
 * lazy: the superblock and root inode are read up front, everything else is
 * faulted in on access.
 *
 * @param {BlockDevice} device
 * @returns {Promise<Ext4Reader>}
 */
export const makeExt4Reader = async device => {
  const superblock = await readSuperblock(device);
  const root = await readInode(device, superblock, ROOT_INODE);

  const getInode = ino => readInode(device, superblock, ino);
  const listDirectory = inode => readDirectory(device, superblock, inode);
  const readRange = (inode, offset, length) =>
    readInodeRange(device, superblock, inode, offset, length);
  const readContents = inode => readInodeContents(device, superblock, inode);
  const readSymlink = inode => readSymbolicLink(device, superblock, inode);

  /** @type {(path: string | string[]) => Promise<Inode | undefined>} */
  const maybeResolve = async path => {
    const segments = normalizeSegments(path);
    let current = root;
    for (const segment of segments) {
      if (!current.isDirectory) {
        return undefined;
      }
      // eslint-disable-next-line no-await-in-loop
      const entries = await listDirectory(current);
      const match = entries.find(e => e.name === segment);
      if (match === undefined) {
        return undefined;
      }
      // eslint-disable-next-line no-await-in-loop
      current = await getInode(match.ino);
    }
    return current;
  };

  /** @type {(path: string | string[]) => Promise<Inode>} */
  const resolve = async path => {
    const inode = await maybeResolve(path);
    if (inode === undefined) {
      throw makeError(X`No such path ${q(path)}`);
    }
    return inode;
  };

  return harden({
    superblock,
    root,
    getInode,
    listDirectory,
    readRange,
    readContents,
    readSymlink,
    maybeResolve,
    resolve,
  });
};
harden(makeExt4Reader);

export { normalizeSegments };
