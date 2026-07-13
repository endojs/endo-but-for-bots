// @ts-check

/**
 * Single-file JSON portrait store with atomic tmp+rename replacement,
 * the same discipline as Goblins' syrup store and goblin-chat's
 * state-store. Deltas merge in memory and rewrite the whole file;
 * suitable for small heaps (the SQLite store scales past it).
 *
 * Filesystem powers are injected so the package stays platform-free:
 * pass `{ readFile, writeFile, rename }` from `node:fs/promises` (or
 * equivalents).
 */

import harden from '@endo/harden';
import { Fail } from '@endo/errors';

import { mergeDelta } from './memory.js';

/**
 * @import { PortraitStore, StoredGraph, StoredDelta } from '../types.js'
 */

/**
 * @typedef {object} FileStorePowers
 * @property {(path: string) => Promise<string | Uint8Array>} readFile
 * @property {(path: string, text: string) => Promise<void>} writeFile
 * @property {(from: string, to: string) => Promise<void>} rename
 */

/**
 * @param {string} path
 * @param {FileStorePowers} powers
 * @returns {Promise<PortraitStore>}
 */
export const makeFilePortraitStore = async (path, powers) => {
  const { readFile, writeFile, rename } = powers;
  /** @type {StoredGraph | undefined} */
  let current;
  let writeCount = 0;

  await null;
  try {
    const text = await readFile(path);
    const parsed = JSON.parse(
      typeof text === 'string' ? text : new TextDecoder().decode(text),
    );
    parsed.formatVersion === 1 ||
      Fail`unsupported portrait file format in ${path}`;
    current = harden(parsed);
  } catch (err) {
    if (/** @type {{ code?: string }} */ (err).code !== 'ENOENT') {
      throw err;
    }
  }

  const persist = async () => {
    writeCount += 1;
    const tmpPath = `${path}.tmp-${writeCount}`;
    await writeFile(tmpPath, JSON.stringify(current));
    await rename(tmpPath, path);
  };

  return harden({
    graphAndSlots: async () => current,
    /** @param {number} slot */
    objectPortrait: async slot =>
      current === undefined ? undefined : current.portraits[String(slot)],
    /** @param {StoredGraph} graph */
    saveGraph: async graph => {
      current = graph;
      await persist();
    },
    /** @param {StoredDelta} delta */
    saveDelta: async delta => {
      current = mergeDelta(current, delta);
      await persist();
    },
    close: async () => {},
  });
};
harden(makeFilePortraitStore);
