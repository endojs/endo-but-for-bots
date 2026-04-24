// @ts-check
/* global Buffer */
/* eslint-disable no-await-in-loop */

import fs from 'node:fs';
import path from 'node:path';
import harden from '@endo/harden';
import { makeExo } from '@endo/exo';
import { E } from '@endo/far';

import { DirectoryInterface, ReadableTreeInterface } from '../fs/interfaces.js';
import { checkinTree } from '../fs/checkin.js';
import { checkoutTree } from '../fs/checkout.js';
import { makeRefReader } from '../fs/ref-reader.js';
import { makeFile } from './file.js';
import { makeTreeWriter } from './tree-writer.js';

/** @import { SnapshotStore } from '../fs/types.js' */

const ALWAYS_IGNORED = harden(new Set(['.git']));

/**
 * Creates a mutable Directory Exo backed by a local filesystem directory.
 *
 * @param {string} dirPath - Absolute path to the directory.
 * @param {object} [options]
 * @param {SnapshotStore} [options.store] - Snapshot store for snapshot().
 * @param {Set<string>} [options.ignored] - Directory entries to ignore.
 * @returns {object}
 */
export const makeDirectory = (dirPath, options = {}) => {
  const { store, ignored = ALWAYS_IGNORED } = options;

  /**
   * @param {string} currentPath
   * @returns {object}
   */
  const makeDir = currentPath => {
    /**
     * @param {string[]} segments
     * @returns {string}
     */
    const resolve = segments => path.join(currentPath, ...segments);

    /**
     * @param {...string} names
     * @returns {Promise<boolean>}
     */
    const has = async (...names) => {
      if (names.length === 0) return true;
      const target = resolve(names);
      try {
        await fs.promises.access(target);
        return true;
      } catch {
        return false;
      }
    };

    /**
     * @param {...string} subpath
     * @returns {Promise<string[]>}
     */
    const list = async (...subpath) => {
      const target = subpath.length > 0 ? resolve(subpath) : currentPath;
      const entries = await fs.promises.readdir(target, {
        withFileTypes: true,
      });
      return entries
        .filter(
          entry =>
            !ignored.has(entry.name) &&
            !entry.isSymbolicLink() &&
            (entry.isFile() || entry.isDirectory()),
        )
        .map(entry => entry.name)
        .sort();
    };

    /**
     * Resolve a path to a mutable File or Directory.
     *
     * @param {string | string[]} pathArg
     * @returns {Promise<object>}
     */
    const lookupMutable = async pathArg => {
      const segments = typeof pathArg === 'string' ? [pathArg] : pathArg;
      const [head, ...tail] = segments;
      const fullPath = path.join(currentPath, head);
      const stat = await fs.promises.stat(fullPath);

      /** @type {any} */
      let child;
      if (stat.isDirectory()) {
        child = makeDir(fullPath);
      } else {
        child = makeFile(fullPath, { store });
      }

      if (tail.length === 0) return child;
      /** @type {any} */
      let current = child;
      for (const name of tail) {
        current = await current.lookup(name);
      }
      return current;
    };

    /**
     * Resolve a path to a read-only ReadableBlob or ReadableTree.
     *
     * @param {string | string[]} pathArg
     * @returns {Promise<object>}
     */
    // eslint-disable-next-line no-unused-vars
    const lookupReadOnly = async pathArg => {
      const segments = typeof pathArg === 'string' ? [pathArg] : pathArg;
      const [head, ...tail] = segments;
      const fullPath = path.join(currentPath, head);
      const stat = await fs.promises.stat(fullPath);

      /** @type {any} */
      let child;
      if (stat.isDirectory()) {
        child = makeReadOnlyDir(fullPath);
      } else {
        child = makeFile(fullPath, { store }).readOnly();
      }

      if (tail.length === 0) return child;
      /** @type {any} */
      let current = child;
      for (const name of tail) {
        current = await current.lookup(name);
      }
      return current;
    };

    /**
     * @param {string} readOnlyPath
     * @returns {object}
     */
    const makeReadOnlyDir = readOnlyPath =>
      makeExo(
        'ReadableTree',
        ReadableTreeInterface,
        /** @type {any} */ ({
          has: async (...names) => {
            if (names.length === 0) return true;
            const target = path.join(readOnlyPath, ...names);
            try {
              await fs.promises.access(target);
              return true;
            } catch {
              return false;
            }
          },
          list: async (...subpath) => {
            const target =
              subpath.length > 0
                ? path.join(readOnlyPath, ...subpath)
                : readOnlyPath;
            const entries = await fs.promises.readdir(target, {
              withFileTypes: true,
            });
            return entries
              .filter(
                entry =>
                  !ignored.has(entry.name) &&
                  !entry.isSymbolicLink() &&
                  (entry.isFile() || entry.isDirectory()),
              )
              .map(entry => entry.name)
              .sort();
          },
          lookup: async pathArg => {
            const segments = typeof pathArg === 'string' ? [pathArg] : pathArg;
            const [head, ...tail] = segments;
            const fullPath = path.join(readOnlyPath, head);
            const stat = await fs.promises.stat(fullPath);

            /** @type {any} */
            let child;
            if (stat.isDirectory()) {
              child = makeReadOnlyDir(fullPath);
            } else {
              child = makeFile(fullPath, { store }).readOnly();
            }

            if (tail.length === 0) return child;
            /** @type {any} */
            let current = child;
            for (const name of tail) {
              current = await current.lookup(name);
            }
            return current;
          },
        }),
      );

    /** @type {object | undefined} */
    let readOnlyFacet;

    return makeExo(
      'Directory',
      DirectoryInterface,
      /** @type {any} */ ({
        has,
        list,
        lookup: lookupMutable,

        /**
         * Write a ReadableBlob or ReadableTree to a path within this
         * directory.
         *
         * @param {string[]} pathSegments
         * @param {unknown} value - Remotable ReadableBlob or ReadableTree.
         */
        write: async (pathSegments, value) => {
          const target = resolve(pathSegments);
          const parentDir = path.dirname(target);
          await fs.promises.mkdir(parentDir, { recursive: true });

          // Detect whether value is a tree or blob.
          // eslint-disable-next-line no-underscore-dangle
          const methods = await E(
            /** @type {any} */ (value),
          ).__getMethodNames__();
          if (methods.includes('list')) {
            // Tree — checkout recursively.
            await fs.promises.mkdir(target, { recursive: true });
            const writer = makeTreeWriter(target);
            await checkoutTree(value, writer);
          } else {
            // Blob — stream content to file.
            const readerRef = E(
              /** @type {import('../fs/types.js').ReadableBlob} */ (value),
            ).streamBase64();
            const reader = makeRefReader(/** @type {any} */ (readerRef));
            /** @type {Uint8Array[]} */
            const chunks = [];
            for await (const chunk of reader) {
              chunks.push(chunk);
            }
            await fs.promises.writeFile(target, Buffer.concat(chunks));
          }
        },

        /**
         * @param {string[]} pathSegments
         */
        remove: async pathSegments => {
          const target = resolve(pathSegments);
          await fs.promises.rm(target, { recursive: true });
        },

        /**
         * @param {string[]} from
         * @param {string[]} to
         */
        move: async (from, to) => {
          const source = resolve(from);
          const dest = resolve(to);
          const destParent = path.dirname(dest);
          await fs.promises.mkdir(destParent, { recursive: true });
          await fs.promises.rename(source, dest);
        },

        /**
         * @param {string[]} from
         * @param {string[]} to
         */
        copy: async (from, to) => {
          const source = resolve(from);
          const dest = resolve(to);
          const destParent = path.dirname(dest);
          await fs.promises.mkdir(destParent, { recursive: true });
          await fs.promises.cp(source, dest, { recursive: true });
        },

        /**
         * @param {string[]} pathSegments
         * @returns {Promise<object>}
         */
        makeDirectory: async pathSegments => {
          const target = resolve(pathSegments);
          await fs.promises.mkdir(target, { recursive: true });
          return makeDir(target);
        },

        readOnly: () => {
          if (!readOnlyFacet) {
            readOnlyFacet = makeReadOnlyDir(currentPath);
          }
          return readOnlyFacet;
        },

        snapshot: async () => {
          if (!store) {
            throw new Error('No snapshot store provided');
          }
          const readOnlyTree = makeReadOnlyDir(currentPath);
          const { sha256 } = await checkinTree(readOnlyTree, store);
          return store.loadTree(sha256);
        },
      }),
    );
  };

  return makeDir(dirPath);
};
harden(makeDirectory);
