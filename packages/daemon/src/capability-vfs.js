// @ts-check

import { E } from '@endo/far';
import harden from '@endo/harden';

/**
 * @import { VFS, VFSStat, VFSDirEntry } from '../../genie/src/tools/vfs.js'
 */

/**
 * Create a VFS adapter backed by a Mount exo capability.
 *
 * This bridges the Genie tool system's VFS interface to an Endo Mount
 * capability.  All filesystem access goes through the Mount's
 * confinement, deny patterns, and revocation — no ambient authority.
 *
 * @param {object} mount - An EndoMount exo (or remote reference).
 * @returns {VFS}
 */
export const makeCapabilityVFS = mount => {
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

    readdir(dirPath, opts = {}) {
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
              const subPath = segments.length > 0 ? `${dirPath}/${name}` : name;
              const subIter = vfs.readdir(subPath, opts);
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
    },
  };

  return harden(vfs);
};
harden(makeCapabilityVFS);
