// @ts-check

import { E } from '@endo/far';
import harden from '@endo/harden';

/**
 * @import { VFS, VFSReadStreamOptions, VFSStat, VFSDirEntry } from '../../genie/src/tools/vfs.js'
 */

const textEncoder = new TextEncoder();

/**
 * @param {string} text
 * @returns {Uint8Array}
 */
const encodeText = text => textEncoder.encode(text);
harden(encodeText);

/**
 * Normalize a POSIX path: collapse `.`, resolve `..`, drop empty segments.
 *
 * Throws if `..` would escape the root (i.e. when popping above the start).
 *
 * @param {string} p
 * @returns {string}
 */
const normalizePosix = p => {
  const parts = p.split('/').filter(s => s.length > 0 && s !== '.');
  /** @type {string[]} */
  const out = [];
  for (const part of parts) {
    if (part === '..') {
      if (out.length === 0) {
        throw new Error(`Invalid path: escapes root: ${p}`);
      }
      out.pop();
    } else {
      out.push(part);
    }
  }
  return out.join('/');
};

/**
 * Maximum directory recursion depth for `readdir({ recursive: true })`.
 *
 * Matches the daemon-side `MAX_CHECKIN_DEPTH` cap (see checkinTree in
 * packages/platform/src/fs/checkin.js).  Bounds the walk so an
 * adversarial Mount layout (symlink loop reachable only via a
 * capability that exposes follows) cannot drive the iterator
 * unboundedly.  Mount's own assertConfined catches realpath escapes,
 * but the recursive walk would still revisit the cycle until exhausted
 * without an explicit cap.
 */
export const MAX_READDIR_DEPTH = 64;

/**
 * Create a VFS adapter backed by a Mount exo capability.
 *
 * This bridges the Genie tool system's VFS interface to an Endo Mount
 * capability.  All filesystem access goes through the Mount's
 * confinement, deny patterns, and revocation: no ambient authority.
 *
 * @param {object} mount - An EndoMount exo (or remote reference).
 * @returns {VFS}
 */
export const makeCapabilityVFS = mount => {
  /**
   * @param {string} filePath
   * @returns {string[]}
   */
  const pathSegments = filePath =>
    filePath.split('/').filter(s => s.length > 0);

  /**
   * @param {string[]} segments
   * @returns {Promise<boolean>}
   */
  const isDirectory = async segments => {
    try {
      await E(mount).list(...segments);
      return true;
    } catch {
      return false;
    }
  };

  /**
   * @param {string[]} segments
   * @returns {Promise<number>}
   */
  const fileSize = async segments => {
    const text = await E(mount).readText(segments);
    return encodeText(text).byteLength;
  };

  /**
   * @param {Uint8Array} bytes
   * @param {VFSReadStreamOptions} opts
   * @returns {Uint8Array}
   */
  const byteRange = (bytes, opts) => {
    const start = opts.start ?? 0;
    const end = opts.end ?? bytes.byteLength - 1;
    if (start < 0 || end < -1) {
      throw new RangeError('Byte range must not be negative');
    }
    if (end < start || start >= bytes.byteLength) {
      return new Uint8Array();
    }
    return bytes.slice(start, Math.min(end + 1, bytes.byteLength));
  };

  /**
   * Inner implementation of readdir that tracks recursion depth.
   * Refuses to descend past MAX_READDIR_DEPTH.
   *
   * @param {string} dirPath
   * @param {{ recursive?: boolean }} opts
   * @param {number} depth
   * @returns {AsyncIterable<VFSDirEntry>}
   */
  const readdirImpl = (dirPath, opts, depth) => {
    const segments = pathSegments(dirPath);
    return harden({
      async *[Symbol.asyncIterator]() {
        const entries = await E(mount).list(...segments);
        for (const name of entries) {
          /** @type {VFSDirEntry} */
          let entry;
          try {
            // eslint-disable-next-line no-await-in-loop
            const subSegments = [...segments, name];
            // eslint-disable-next-line no-await-in-loop
            const subEntries = await E(mount).list(...subSegments);
            // If list succeeds, it's a directory.
            void subEntries;
            entry = harden({
              name,
              type: /** @type {const} */ ('directory'),
              size: 0,
            });
          } catch {
            entry = harden({
              name,
              type: /** @type {const} */ ('file'),
              // eslint-disable-next-line no-await-in-loop
              size: await fileSize([...segments, name]),
            });
          }
          yield entry;

          // Recurse if requested and entry is a directory.
          if (opts.recursive && entry.type === 'directory') {
            if (depth + 1 >= MAX_READDIR_DEPTH) {
              throw new Error(
                `readdir recursion depth exceeded MAX_READDIR_DEPTH=${MAX_READDIR_DEPTH} at ${dirPath}/${name}`,
              );
            }
            const subPath = segments.length > 0 ? `${dirPath}/${name}` : name;
            const subIter = readdirImpl(subPath, opts, depth + 1);
            // eslint-disable-next-line no-await-in-loop
            for await (const subEntry of subIter) {
              yield harden({
                ...subEntry,
                name: `${name}/${subEntry.name}`,
              });
            }
          }
        }
      },
    });
  };

  /** @type {VFS} */
  const vfs = {
    async stat(filePath) {
      const segments = pathSegments(filePath);
      const exists = await E(mount).has(...segments);
      if (!exists) {
        throw new Error(`ENOENT: no such file or directory: ${filePath}`);
      }
      // Try to list. If it succeeds, it's a directory.
      if (await isDirectory(segments)) {
        return harden({
          size: 0,
          mtime: new Date().toISOString(),
          type: /** @type {const} */ ('directory'),
        });
      }
      // Not a directory, assume file.
      return harden({
        size: await fileSize(segments),
        mtime: new Date().toISOString(),
        type: /** @type {const} */ ('file'),
      });
    },

    async readFile(filePath) {
      const segments =
        typeof filePath === 'string' ? pathSegments(filePath) : filePath;
      return E(mount).readText(segments);
    },

    createReadStream(filePath, opts = {}) {
      const segments = pathSegments(filePath);
      return harden({
        async *[Symbol.asyncIterator]() {
          const text = await E(mount).readText(segments);
          const bytes = byteRange(encodeText(text), opts);
          if (bytes.byteLength > 0) {
            yield bytes;
          }
        },
      });
    },

    async writeFile(filePath, content) {
      const segments = pathSegments(filePath);
      await E(mount).writeText(segments, content);
    },

    async mkdir(filePath, opts = {}) {
      const segments = pathSegments(filePath);
      const exists = await E(mount).has(...segments);
      if (exists) {
        if (opts.recursive) {
          return false;
        }
        throw new Error(`EEXIST: directory already exists: ${filePath}`);
      }
      if (!opts.recursive && segments.length > 1) {
        const parentSegments = segments.slice(0, -1);
        const parentExists = await E(mount).has(...parentSegments);
        if (!parentExists) {
          throw new Error(`ENOENT: no such file or directory: ${filePath}`);
        }
        if (!(await isDirectory(parentSegments))) {
          throw new Error(`ENOTDIR: not a directory: ${filePath}`);
        }
      }
      await E(mount).makeDirectory(segments);
      return true;
    },

    async unlink(filePath) {
      const segments = pathSegments(filePath);
      if (await isDirectory(segments)) {
        throw new Error(
          `EISDIR: illegal operation on a directory: ${filePath}`,
        );
      }
      await E(mount).remove(segments);
    },

    async rmdir(filePath) {
      const segments = pathSegments(filePath);
      const entries = /** @type {string[]} */ (
        await E(mount).list(...segments)
      );
      if (entries.length > 0) {
        throw new Error(`ENOTEMPTY: directory not empty: ${filePath}`);
      }
      await E(mount).removeDirectory(segments);
    },

    async rm(filePath, opts = {}) {
      const segments = pathSegments(filePath);
      if (await isDirectory(segments)) {
        if (!opts.recursive) {
          throw new Error(
            `EISDIR: illegal operation on a directory: ${filePath}`,
          );
        }
        await E(mount).removeTree(segments);
        return;
      }
      await E(mount).remove(segments);
    },

    sep: '/',

    join(...parts) {
      return parts.join('/').replace(/\/+/g, '/');
    },

    relative(from, to) {
      const fromParts = normalizePosix(from).split('/').filter(Boolean);
      const toParts = normalizePosix(to).split('/').filter(Boolean);
      let i = 0;
      while (
        i < fromParts.length &&
        i < toParts.length &&
        fromParts[i] === toParts[i]
      ) {
        i += 1;
      }
      const up = fromParts.slice(i).map(() => '..');
      const down = toParts.slice(i);
      const joined = [...up, ...down].join('/');
      return joined.length > 0 ? joined : '.';
    },

    resolve(...paths) {
      // The Mount is the root; resolved paths stay under it.
      // Absolute segments reset to root, matching POSIX `path.resolve`.
      let current = '';
      for (const p of paths) {
        if (p.startsWith('/')) {
          current = p.slice(1);
        } else if (current.length > 0) {
          current = `${current}/${p}`;
        } else {
          current = p;
        }
      }
      return `/${normalizePosix(current)}`;
    },

    readdir(dirPath, opts = {}) {
      return readdirImpl(dirPath, opts, 0);
    },
  };

  return harden(vfs);
};
harden(makeCapabilityVFS);
