// @ts-check
import { assertReadRange } from './assert.js';

/** @import { BlockDevice } from './types.js' */

/**
 * Wrap a `BlockDevice` with a fixed-size page cache. Filesystem and
 * decryption layers re-read the same metadata sectors repeatedly (the
 * superblock, group descriptors, an inode table block); caching those
 * pages turns N decrypt-and-fault round-trips into one. The cache is a
 * simple LRU keyed by page index, holding at most `maxPages` pages.
 *
 * Page reads at the tail of the device are clamped to the device size, so
 * the last (possibly partial) page is cached without over-reading.
 *
 * @param {BlockDevice} device
 * @param {object} [options]
 * @param {number} [options.pageSize] Bytes per cached page (default 64 KiB,
 *   rounded up to a multiple of the device sector size).
 * @param {number} [options.maxPages] Maximum resident pages.
 * @returns {BlockDevice}
 */
export const makeCachingBlockDevice = (
  device,
  { pageSize = 65_536, maxPages = 256 } = {},
) => {
  const { sectorSize } = device;
  // Align page size up to a whole number of sectors.
  const alignedPageSize = Math.max(
    sectorSize,
    Math.ceil(pageSize / sectorSize) * sectorSize,
  );
  /** @type {Map<number, Uint8Array>} LRU: insertion order is eviction order. */
  const pages = new Map();
  let cachedSize;

  const sizeOf = async () => {
    if (cachedSize === undefined) {
      cachedSize = await device.getSize();
    }
    return cachedSize;
  };

  /**
   * @param {number} pageIndex
   * @param {number} size
   */
  const loadPage = async (pageIndex, size) => {
    const existing = pages.get(pageIndex);
    if (existing !== undefined) {
      // Refresh LRU recency.
      pages.delete(pageIndex);
      pages.set(pageIndex, existing);
      return existing;
    }
    const pageStart = pageIndex * alignedPageSize;
    const pageLength = Math.min(alignedPageSize, size - pageStart);
    const page = await device.read(pageStart, pageLength);
    pages.set(pageIndex, page);
    if (pages.size > maxPages) {
      // Evict least-recently-used (first key in insertion order).
      const oldest = pages.keys().next().value;
      if (oldest !== undefined) {
        pages.delete(oldest);
      }
    }
    return page;
  };

  return harden({
    sectorSize,
    getSize: sizeOf,
    read: async (offset, length) => {
      const size = await sizeOf();
      assertReadRange(offset, length, size);
      const out = new Uint8Array(length);
      let cursor = offset;
      let written = 0;
      while (written < length) {
        const pageIndex = Math.floor(cursor / alignedPageSize);
        const pageStart = pageIndex * alignedPageSize;
        // eslint-disable-next-line no-await-in-loop
        const page = await loadPage(pageIndex, size);
        const within = cursor - pageStart;
        const take = Math.min(page.length - within, length - written);
        out.set(page.subarray(within, within + take), written);
        written += take;
        cursor += take;
      }
      return out;
    },
  });
};
harden(makeCachingBlockDevice);
