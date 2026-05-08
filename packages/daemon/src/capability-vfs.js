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
      const mountStat = await E(mount).stat(segments);
      return harden({
        size: mountStat.size,
        mtime: new Date().toISOString(),
        type: /** @type {'file' | 'directory'} */ (mountStat.type),
      });
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
            const subSegments = [...segments, name];
            // eslint-disable-next-line no-await-in-loop
            const entryStat = await E(mount).stat(subSegments);
            /** @type {VFSDirEntry} */
            const entry = harden({
              name,
              type: /** @type {'file' | 'directory'} */ (entryStat.type),
              size: entryStat.size,
            });
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

    sep: '/',

    join(...parts) {
      const filtered = parts.filter(p => p.length > 0);
      if (filtered.length === 0) {
        return '.';
      }
      const joined = filtered.join('/').replace(/\/+/g, '/');
      // Preserve a leading slash, drop a trailing one (unless joined === '/').
      const trimmed = joined.length > 1 ? joined.replace(/\/$/, '') : joined;
      return trimmed;
    },

    relative(from, to) {
      const fromSegs = from.split('/').filter(s => s.length > 0);
      const toSegs = to.split('/').filter(s => s.length > 0);
      let common = 0;
      while (
        common < fromSegs.length &&
        common < toSegs.length &&
        fromSegs[common] === toSegs[common]
      ) {
        common += 1;
      }
      const up = fromSegs.slice(common).map(() => '..');
      const down = toSegs.slice(common);
      const parts = [...up, ...down];
      return parts.length === 0 ? '' : parts.join('/');
    },

    resolve(...paths) {
      // Mount confines all paths under its root, so `resolve` returns a
      // path relative to that root.  Absolute inputs reset the
      // accumulator; otherwise we append.  The mount layer enforces
      // confinement when the resolved path is used.
      let acc = [];
      for (const p of paths) {
        if (p.length === 0) {
          // eslint-disable-next-line no-continue
          continue;
        }
        if (p.startsWith('/')) {
          acc = p.split('/').filter(s => s.length > 0);
        } else {
          for (const seg of p.split('/')) {
            if (seg.length === 0 || seg === '.') {
              // eslint-disable-next-line no-continue
              continue;
            }
            if (seg === '..') {
              acc.pop();
            } else {
              acc.push(seg);
            }
          }
        }
      }
      return acc.length === 0 ? '/' : `/${acc.join('/')}`;
    },
  };

  return harden(vfs);
};
harden(makeCapabilityVFS);
