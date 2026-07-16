// @ts-check
/* eslint no-bitwise: ["off"] */
import { makeError, q, X } from '@endo/errors';

/** @import { BlockDevice } from '@endo/block-device' */

// The ext2/3/4 superblock lives 1024 bytes into the volume and is itself
// 1024 bytes. All multi-byte fields are little-endian.
const SUPERBLOCK_OFFSET = 1024;
const SUPERBLOCK_SIZE = 1024;
const EXT_MAGIC = 0xef53;

// Incompatible feature bits we need to interpret.
const INCOMPAT_FILETYPE = 0x2;
const INCOMPAT_EXTENTS = 0x40;
const INCOMPAT_64BIT = 0x80;

/**
 * @typedef {object} Superblock
 * @property {number} blockSize Bytes per filesystem block.
 * @property {number} inodesPerGroup
 * @property {number} blocksPerGroup
 * @property {number} inodeSize Bytes per inode record.
 * @property {number} firstInode First non-reserved inode number.
 * @property {number} descSize Bytes per block-group descriptor (32 or 64).
 * @property {boolean} has64bit Whether the 64bit feature is set.
 * @property {boolean} hasFiletype Whether dir entries carry a file type.
 * @property {boolean} hasExtents Whether inodes may use extent trees.
 * @property {number} blocksCount Total block count.
 */

/**
 * Read and parse the filesystem superblock.
 *
 * @param {BlockDevice} device
 * @returns {Promise<Superblock>}
 */
export const readSuperblock = async device => {
  const bytes = await device.read(SUPERBLOCK_OFFSET, SUPERBLOCK_SIZE);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = view.getUint16(0x38, true);
  if (magic !== EXT_MAGIC) {
    throw makeError(
      X`Not an ext2/3/4 filesystem: bad magic ${q(magic.toString(16))}`,
    );
  }
  const blockSize = 1024 << view.getUint32(0x18, true);
  const featureIncompat = view.getUint32(0x60, true);
  const has64bit = (featureIncompat & INCOMPAT_64BIT) !== 0;
  const descSize = has64bit ? view.getUint16(0xfe, true) || 64 : 32;
  const blocksCountLo = view.getUint32(0x04, true);
  const blocksCountHi = has64bit ? view.getUint32(0x150, true) : 0;
  return harden({
    blockSize,
    inodesPerGroup: view.getUint32(0x28, true),
    blocksPerGroup: view.getUint32(0x20, true),
    inodeSize: view.getUint16(0x58, true) || 128,
    firstInode: view.getUint32(0x54, true) || 11,
    descSize,
    has64bit,
    hasFiletype: (featureIncompat & INCOMPAT_FILETYPE) !== 0,
    hasExtents: (featureIncompat & INCOMPAT_EXTENTS) !== 0,
    blocksCount: blocksCountHi * 2 ** 32 + blocksCountLo,
  });
};
harden(readSuperblock);
