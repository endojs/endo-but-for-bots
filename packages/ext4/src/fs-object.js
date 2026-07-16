// @ts-check
import { makeExo } from '@endo/exo';
import { encodeBase64 } from '@endo/base64';
import { mapReader } from '@endo/stream';
import { makeReaderPump } from '@endo/exo-stream/reader-pump.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { makeError, q, X } from '@endo/errors';
import {
  ReadableTreeInterface,
  ReadableBlobRangeInterface,
} from '@endo/platform/fs/lite';

import { makeExt4Reader, normalizeSegments } from './reader.js';

/** @import { BlockDevice } from '@endo/block-device' */
/** @import { Ext4Reader } from './reader.js' */
/** @import { Inode } from './inode.js' */

const STREAM_CHUNK = 65_536;

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

/**
 * Wrap a file (or symlink) inode as an Endo `ReadableBlob` with the
 * content-addressed range-read surface (`getInfo` / `fetch`). `fetch` is
 * the lazy primitive: it reads exactly the requested byte window, faulting
 * in only the blocks (and, under LUKS, only the sectors) that window
 * touches. `text` / `json` / `streamBase64` read the whole blob.
 *
 * @param {Ext4Reader} reader
 * @param {Inode} inode
 * @returns {import('@endo/exo').Guarded<any>}
 */
const makeBlob = (reader, inode) => {
  const readWhole = async () =>
    inode.isSymbolicLink
      ? textEncoder.encode(await reader.readSymlink(inode))
      : reader.readContents(inode);

  /**
   * @param {number} offset
   * @param {number} length
   */
  const readRange = async (offset, length) => {
    if (inode.isFile) {
      return reader.readRange(inode, offset, length);
    }
    const whole = await readWhole();
    return whole.slice(offset, offset + length);
  };

  async function* byteChunks() {
    if (inode.isFile) {
      for (let offset = 0; offset < inode.size; offset += STREAM_CHUNK) {
        const length = Math.min(STREAM_CHUNK, inode.size - offset);
        yield reader.readRange(inode, offset, length);
      }
    } else {
      yield readWhole();
    }
  }

  return makeExo('Ext4Blob', ReadableBlobRangeInterface, {
    help: method =>
      method === undefined
        ? 'Ext4Blob: a lazily-read file. Use fetch(offset, length) for windowed reads, or text()/json()/streamBase64() for the whole file.'
        : `No documentation for method ${q(method)}.`,
    getInfo: async () => {
      const bytes = await readWhole();
      return harden({
        algorithm: 'sha256',
        hash: encodeBase64(sha256(bytes)),
        size: bytes.length,
      });
    },
    fetch: async (offset, length) => readRange(Number(offset), Number(length)),
    text: async () => textDecoder.decode(await readWhole()),
    json: async () => JSON.parse(textDecoder.decode(await readWhole())),
    streamBase64: synPromise => {
      const pump = makeReaderPump(mapReader(byteChunks(), encodeBase64));
      return pump(/** @type {any} */ (synPromise));
    },
  });
};

/**
 * Wrap a directory inode as an Endo `ReadableTree`: `has` / `list` /
 * `lookup` over a path relative to this directory. `lookup` mints a child
 * `ReadableTree` for a subdirectory or a `ReadableBlob` for a file,
 * deferring all I/O until the child is used.
 *
 * @param {Ext4Reader} reader
 * @param {Inode} inode
 * @returns {import('@endo/exo').Guarded<any>}
 */
const makeTree = (reader, inode) => {
  /**
   * @param {string[]} segments
   * @returns {Promise<Inode | undefined>}
   */
  const walk = async segments => {
    let current = inode;
    for (const segment of segments) {
      if (!current.isDirectory) {
        return undefined;
      }
      // eslint-disable-next-line no-await-in-loop
      const entries = await reader.listDirectory(current);
      const match = entries.find(e => e.name === segment);
      if (match === undefined) {
        return undefined;
      }
      // eslint-disable-next-line no-await-in-loop
      current = await reader.getInode(match.ino);
    }
    return current;
  };

  return makeExo('Ext4Tree', ReadableTreeInterface, {
    help: method =>
      method === undefined
        ? 'Ext4Tree: a read-only directory. has(...path), list(...path), lookup(name|path).'
        : `No documentation for method ${q(method)}.`,
    has: async (...path) => (await walk(normalizeSegments(path))) !== undefined,
    list: async (...path) => {
      const target =
        path.length === 0 ? inode : await walk(normalizeSegments(path));
      if (target === undefined) {
        throw makeError(X`No such directory ${q(path)}`);
      }
      if (!target.isDirectory) {
        throw makeError(X`Not a directory: ${q(path)}`);
      }
      const entries = await reader.listDirectory(target);
      return harden(entries.map(e => e.name));
    },
    lookup: async pathArg => {
      const target = await walk(normalizeSegments(pathArg));
      if (target === undefined) {
        throw makeError(X`No such path ${q(pathArg)}`);
      }
      return target.isDirectory
        ? makeTree(reader, target)
        : makeBlob(reader, target);
    },
  });
};

/**
 * Mount a read-only ext2/3/4 filesystem from a block device as an Endo fs
 * object — a `ReadableTree` rooted at the filesystem root. Composed under
 * `@endo/luks`'s decrypting device and `@endo/block-device`'s file device,
 * this is the top of a fully lazy "raw device → LUKS → ext4 → fs object"
 * stack: each `lookup`/`fetch` reads only the bytes it needs.
 *
 * @param {BlockDevice} device
 * @returns {Promise<import('@endo/exo').Guarded<any>>}
 */
export const makeExt4Filesystem = async device => {
  const reader = await makeExt4Reader(device);
  return makeTree(reader, reader.root);
};
harden(makeExt4Filesystem);
