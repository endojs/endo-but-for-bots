// @ts-check
/* eslint-disable no-await-in-loop */
/**
 * Build a `Cursor` exo over a backend's `list(dirPath)` async
 * iterable. The Cursor owns its position; `read(limit)` returns a
 * bounded page, `stream()` returns a `PassableReader<DirEntry>`,
 * `toArray()` drains the rest.
 *
 * Entries are augmented with a synthesized `qid` so legacy
 * consumers (9p-server's `Treaddir` reads `{ name, qid }`) work
 * unchanged against any wrapBackend-built `Filesystem`.
 *
 * @import { FsBackend, DirEntry, NodeKind } from '../backend-types.js'
 * @import { Cursor, DirectoryEntry, Qid } from '../types.js'
 */

import { makeExo } from '@endo/exo';
import { q } from '@endo/errors';
import { readerFromIterator } from '@endo/exo-stream/reader-from-iterator.js';

import { CursorInterface } from '../type-guards.js';
import { toSafeNumber } from './helpers.js';
import { synthQid } from './qid.js';

/**
 * @param {object} opts
 * @param {FsBackend} opts.backend
 * @param {string[]} opts.dirPath
 * @param {<K extends NodeKind>(path: string[], kind: K) => Qid<K>} [opts.qidOf]
 *   optional QID synthesizer (defaults to the path-hash `synthQid`).
 *   wrap-backend passes its content-address-aware `qidOf` so a listing
 *   entry's `qid` matches the one a later `lookup(name).getQid()` would
 *   return (e.g. a git OID rather than a path hash).
 */
export const makeCursorExo = ({ backend, dirPath, qidOf = synthQid }) => {
  /** @type {AsyncIterator<DirEntry> | null} */
  let iter = null;
  let exhausted = false;
  let closed = false;

  const ensureIter = () => {
    if (iter === null) {
      iter = backend.list(dirPath)[Symbol.asyncIterator]();
    }
    return iter;
  };

  // Augment each backend entry with a synthesized `qid` for legacy
  // consumers. `DirectoryEntry` correlates `kind` and `qid.type`, so
  // build each arm with its literal kind rather than the backend
  // entry's unnarrowed one.
  /**
   * @param {DirEntry} entry
   * @returns {DirectoryEntry}
   */
  const augment = entry => {
    const path = [...dirPath, entry.name];
    return entry.kind === 'directory'
      ? harden({
          name: entry.name,
          kind: 'directory',
          qid: qidOf(path, 'directory'),
        })
      : harden({ name: entry.name, kind: 'file', qid: qidOf(path, 'file') });
  };

  return makeExo('Cursor', CursorInterface, {
    async read(limit) {
      if (exhausted) return harden({ entries: [], atEnd: true });
      const max = limit === undefined ? Infinity : toSafeNumber(limit, 'limit');
      const it = ensureIter();
      /** @type {DirectoryEntry[]} */
      const entries = [];
      let atEnd = false;
      while (entries.length < max) {
        const step = await it.next();
        if (step.done) {
          atEnd = true;
          exhausted = true;
          break;
        }
        entries.push(augment(step.value));
      }
      return harden({ entries, atEnd });
    },
    async stream() {
      if (exhausted) {
        return readerFromIterator(
          (async function* empty() {
            // intentionally empty
          })(),
        );
      }
      const it = ensureIter();
      const generator = async function* () {
        for (;;) {
          const step = await it.next();
          if (step.done) {
            exhausted = true;
            return;
          }
          yield augment(step.value);
        }
      };
      return readerFromIterator(generator());
    },
    async toArray() {
      if (exhausted) return harden([]);
      const it = ensureIter();
      /** @type {DirectoryEntry[]} */
      const out = [];
      for (;;) {
        const step = await it.next();
        if (step.done) {
          exhausted = true;
          break;
        }
        out.push(augment(step.value));
      }
      return harden(out);
    },
    async skip(n) {
      if (closed) return;
      const count = toSafeNumber(n, 'n');
      const it = ensureIter();
      for (let i = 0; i < count; i += 1) {
        const step = await it.next();
        if (step.done) {
          exhausted = true;
          return;
        }
      }
    },
    async rewind() {
      if (closed) return;
      iter = null;
      exhausted = false;
    },
    async close() {
      if (closed) return;
      closed = true;
      exhausted = true;
      const current = iter;
      iter = null;
      // Let the backend iterator release any resource it holds (e.g.
      // an open directory handle on a lazy/streaming backing) by
      // running its `return()` cleanup. Best-effort.
      if (current !== null && typeof current.return === 'function') {
        await current.return(undefined).catch(() => {});
      }
    },
    help(method) {
      if (method === undefined) {
        return 'Cursor: paged directory listing — read(limit) | stream() | toArray() | skip(n) | rewind().';
      }
      return `No documentation available for method ${q(method)}.`;
    },
  });
};
harden(makeCursorExo);
