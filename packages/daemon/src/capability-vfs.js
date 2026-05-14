// @ts-check

import { E } from '@endo/far';
import harden from '@endo/harden';

/**
 * @import { VFS, VFSStat, VFSDirEntry } from '../../genie/src/tools/vfs.js'
 */

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
   * Inner implementation of readdir that tracks recursion depth.
   * Refuses to descend past MAX_READDIR_DEPTH.
   *
   * @param {string} dirPath
   * @param {{ recursive?: boolean }} opts
   * @param {number} depth
   * @returns {AsyncIterable<VFSDirEntry>}
   */
  const readdirImpl = (dirPath, opts, depth) => {
    const segments = dirPath.split('/').filter(s => s.length > 0);
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
              size: 0,
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
      const segments = filePath.split('/').filter(s => s.length > 0);
      const exists = await E(mount).has(...segments);
      if (!exists) {
        throw new Error(`ENOENT: no such file or directory: ${filePath}`);
      }
      // Try to list — if it succeeds, it's a directory.
      try {
        await E(mount).list(...segments);
        return harden({
          size: 0,
          mtime: new Date().toISOString(),
          type: /** @type {const} */ ('directory'),
        });
      } catch {
        // Not a directory — assume file.
        const text = await E(mount).readText(segments);
        return harden({
          size: text.length,
          mtime: new Date().toISOString(),
          type: /** @type {const} */ ('file'),
        });
      }
    },

    async readFile(filePath) {
      const segments =
        typeof filePath === 'string'
          ? filePath.split('/').filter(s => s.length > 0)
          : filePath;
      return E(mount).readText(segments);
    },

    createReadStream(filePath, _opts) {
      // Return an async iterable that yields the file content as a
      // single UTF-8 chunk.  Mount doesn't support byte-range reads
      // natively, so this is a simple adapter.
      const segments = filePath.split('/').filter(s => s.length > 0);
      return harden({
        async *[Symbol.asyncIterator]() {
          const text = await E(mount).readText(segments);
          yield new TextEncoder().encode(text);
        },
      });
    },

    async writeFile(filePath, content) {
      const segments = filePath.split('/').filter(s => s.length > 0);
      await E(mount).writeText(segments, content);
    },

    async mkdir(filePath, opts = {}) {
      const segments = filePath.split('/').filter(s => s.length > 0);
      const exists = await E(mount).has(...segments);
      if (exists) {
        if (opts.recursive) {
          return false;
        }
        throw new Error(`EEXIST: directory already exists: ${filePath}`);
      }
      await E(mount).makeDirectory(segments);
      return true;
    },

    async unlink(filePath) {
      const segments = filePath.split('/').filter(s => s.length > 0);
      await E(mount).remove(segments);
    },

    async rmdir(filePath) {
      const segments = filePath.split('/').filter(s => s.length > 0);
      await E(mount).remove(segments);
    },

    async rm(filePath, _opts) {
      const segments = filePath.split('/').filter(s => s.length > 0);
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
