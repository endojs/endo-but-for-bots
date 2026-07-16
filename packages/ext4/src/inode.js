// @ts-check
/* eslint no-bitwise: ["off"] */
import { makeError, q, X } from '@endo/errors';

/** @import { BlockDevice } from '@endo/block-device' */
/** @import { Superblock } from './superblock.js' */

const S_IFMT = 0xf000;
const S_IFREG = 0x8000;
const S_IFDIR = 0x4000;
const S_IFLNK = 0xa000;

const EXTENTS_FL = 0x8_0000;
const INLINE_DATA_FL = 0x1000_0000;

const EXTENT_MAGIC = 0xf30a;

/**
 * @typedef {object} Inode
 * @property {number} ino
 * @property {number} mode
 * @property {number} size File size in bytes.
 * @property {number} flags
 * @property {boolean} isDirectory
 * @property {boolean} isFile
 * @property {boolean} isSymbolicLink
 * @property {boolean} usesExtents
 * @property {Uint8Array} blockData The 60-byte `i_block` region.
 */

/**
 * Locate and read one inode record by number.
 *
 * @param {BlockDevice} device
 * @param {Superblock} sb
 * @param {number} ino 1-based inode number (root directory is 2).
 * @returns {Promise<Inode>}
 */
export const readInode = async (device, sb, ino) => {
  const group = Math.floor((ino - 1) / sb.inodesPerGroup);
  const index = (ino - 1) % sb.inodesPerGroup;
  // Group descriptor table starts in the block after the superblock (or two
  // blocks in, when the block size is the minimum 1024).
  const gdtBlock = sb.blockSize === 1024 ? 2 : 1;
  const descOffset = gdtBlock * sb.blockSize + group * sb.descSize;
  const desc = await device.read(descOffset, sb.descSize);
  const descView = new DataView(desc.buffer, desc.byteOffset, desc.byteLength);
  let inodeTableBlock = descView.getUint32(0x08, true);
  if (sb.descSize >= 64) {
    inodeTableBlock += descView.getUint32(0x28, true) * 2 ** 32;
  }
  const inodeOffset = inodeTableBlock * sb.blockSize + index * sb.inodeSize;
  const raw = await device.read(inodeOffset, sb.inodeSize);
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const mode = view.getUint16(0x00, true);
  const flags = view.getUint32(0x20, true);
  const sizeLo = view.getUint32(0x04, true);
  const sizeHi = view.getUint32(0x6c, true);
  return harden({
    ino,
    mode,
    flags,
    size: sizeHi * 2 ** 32 + sizeLo,
    isDirectory: (mode & S_IFMT) === S_IFDIR,
    isFile: (mode & S_IFMT) === S_IFREG,
    isSymbolicLink: (mode & S_IFMT) === S_IFLNK,
    usesExtents: (flags & EXTENTS_FL) !== 0,
    blockData: raw.slice(0x28, 0x28 + 60),
  });
};
harden(readInode);

/**
 * Walk an inode's extent tree into a flat, logical-block-ordered list of
 * `{ logical, length, physical }` extents. Index nodes are read lazily, so
 * only the tree spine is faulted in.
 *
 * @param {BlockDevice} device
 * @param {Superblock} sb
 * @param {Uint8Array} node The extent node bytes (the inode's `i_block`, or
 *   a child extent block).
 * @returns {Promise<Array<{ logical: number, length: number, physical: number }>>}
 */
const readExtentTree = async (device, sb, node) => {
  const view = new DataView(node.buffer, node.byteOffset, node.byteLength);
  if (view.getUint16(0, true) !== EXTENT_MAGIC) {
    throw makeError(X`Bad extent header magic ${q(view.getUint16(0, true))}`);
  }
  const entries = view.getUint16(2, true);
  const depth = view.getUint16(6, true);
  const extents = [];
  for (let i = 0; i < entries; i += 1) {
    const e = 12 + i * 12;
    const logical = view.getUint32(e, true);
    if (depth === 0) {
      let length = view.getUint16(e + 4, true);
      // Lengths above 32768 mark uninitialized extents; the mapping is real.
      if (length > 32_768) {
        length -= 32_768;
      }
      const physical =
        view.getUint32(e + 8, true) + view.getUint16(e + 6, true) * 2 ** 32;
      extents.push({ logical, length, physical });
    } else {
      const child =
        view.getUint32(e + 4, true) + view.getUint16(e + 8, true) * 2 ** 32;
      // eslint-disable-next-line no-await-in-loop
      const childBytes = await device.read(child * sb.blockSize, sb.blockSize);
      // eslint-disable-next-line no-await-in-loop
      extents.push(...(await readExtentTree(device, sb, childBytes)));
    }
  }
  return extents;
};

/**
 * Resolve a logical block to a physical block for a classic
 * (non-extent) inode using the direct / single / double / triple indirect
 * block map. Returns `0` for a sparse hole.
 *
 * @param {BlockDevice} device
 * @param {Superblock} sb
 * @param {DataView} iblock The inode's 60-byte `i_block` as a DataView.
 * @param {number} logical
 * @returns {Promise<number>}
 */
const resolveIndirect = async (device, sb, iblock, logical) => {
  const perBlock = sb.blockSize / 4;
  const direct = i => iblock.getUint32(i * 4, true);
  const readPointer = async (blockNo, index) => {
    if (blockNo === 0) {
      return 0;
    }
    const block = await device.read(blockNo * sb.blockSize, sb.blockSize);
    return new DataView(
      block.buffer,
      block.byteOffset,
      block.byteLength,
    ).getUint32(index * 4, true);
  };
  let lb = logical;
  if (lb < 12) {
    return direct(lb);
  }
  lb -= 12;
  if (lb < perBlock) {
    return readPointer(direct(12), lb);
  }
  lb -= perBlock;
  if (lb < perBlock * perBlock) {
    const mid = await readPointer(direct(13), Math.floor(lb / perBlock));
    return readPointer(mid, lb % perBlock);
  }
  lb -= perBlock * perBlock;
  const high = await readPointer(
    direct(14),
    Math.floor(lb / (perBlock * perBlock)),
  );
  const mid = await readPointer(
    high,
    Math.floor((lb % (perBlock * perBlock)) / perBlock),
  );
  return readPointer(mid, lb % perBlock);
};

/**
 * Read a byte range from a file (or directory) inode, faulting in only the
 * blocks the range touches. Sparse holes read as zeros. The range is
 * clamped to the inode size, so a read past EOF returns the available
 * prefix (possibly empty).
 *
 * @param {BlockDevice} device
 * @param {Superblock} sb
 * @param {Inode} inode
 * @param {number} offset
 * @param {number} length
 * @returns {Promise<Uint8Array>}
 */
export const readInodeRange = async (device, sb, inode, offset, length) => {
  if (inode.flags & INLINE_DATA_FL) {
    throw makeError(
      X`Inode ${q(inode.ino)} uses inline data, which is not supported`,
    );
  }
  if (offset >= inode.size || length <= 0) {
    return new Uint8Array(0);
  }
  const bs = sb.blockSize;
  const end = Math.min(inode.size, offset + length);
  const out = new Uint8Array(end - offset);

  /** @type {((logical: number) => Promise<number>)} */
  let resolve;
  if (inode.usesExtents) {
    const extents = await readExtentTree(device, sb, inode.blockData);
    resolve = async logical => {
      const ext = extents.find(
        x => logical >= x.logical && logical < x.logical + x.length,
      );
      return ext ? ext.physical + (logical - ext.logical) : 0;
    };
  } else {
    const iblock = new DataView(
      inode.blockData.buffer,
      inode.blockData.byteOffset,
      inode.blockData.byteLength,
    );
    resolve = logical => resolveIndirect(device, sb, iblock, logical);
  }

  const firstLb = Math.floor(offset / bs);
  const lastLb = Math.floor((end - 1) / bs);
  for (let lb = firstLb; lb <= lastLb; lb += 1) {
    // eslint-disable-next-line no-await-in-loop
    const physical = await resolve(lb);
    const blockStart = lb * bs;
    const copyStart = Math.max(offset, blockStart);
    const copyEnd = Math.min(end, blockStart + bs);
    if (physical !== 0) {
      // eslint-disable-next-line no-await-in-loop
      const block = await device.read(physical * bs, bs);
      out.set(
        block.subarray(copyStart - blockStart, copyEnd - blockStart),
        copyStart - offset,
      );
    }
  }
  return out;
};
harden(readInodeRange);

/**
 * Read the full contents of a file or directory inode.
 *
 * @param {BlockDevice} device
 * @param {Superblock} sb
 * @param {Inode} inode
 * @returns {Promise<Uint8Array>}
 */
export const readInodeContents = (device, sb, inode) =>
  readInodeRange(device, sb, inode, 0, inode.size);
harden(readInodeContents);

/**
 * Read a fast or slow symbolic link's target path.
 *
 * @param {BlockDevice} device
 * @param {Superblock} sb
 * @param {Inode} inode
 * @returns {Promise<string>}
 */
export const readSymbolicLink = async (device, sb, inode) => {
  // Targets shorter than 60 bytes are stored inline in `i_block`.
  const bytes =
    inode.size < 60
      ? inode.blockData.subarray(0, inode.size)
      : await readInodeContents(device, sb, inode);
  return new TextDecoder().decode(bytes);
};
harden(readSymbolicLink);
