// @ts-check
/* eslint-disable no-await-in-loop */
/**
 * Build a `Cursor` exo over a backend's `list(dirPath)` async
 * iterable. The Cursor owns its position; `read(limit)` returns a
 * bounded page, `stream()` returns a `PassableReader<DirEntry>`,
 * `toArray()` drains the rest. Stream termination releases that listing;
 * rewind obtains a new listing only after prior cleanup succeeds.
 * Close fences all consumers immediately and retains failed cleanup for retry.
 * Resourceful backend iterators must retain failed cleanup for a retry and
 * return done:true only after release completes. A return method may be absent
 * only when the iterator owns no separate cleanup. An async generator whose
 * finally throws does not by itself provide this retry guarantee.
 *
 * Entries are augmented with a synthesized `qid` so legacy
 * consumers (9p-server's `Treaddir` reads `{ name, qid }`) work
 * unchanged against any wrapBackend-built `Filesystem`.
 *
 * @import { FsBackend, DirEntry, NodeKind } from '../backend-types.js'
 * @import { Cursor, DirectoryEntry, Qid } from '../types.js'
 */

import { makeExo } from '@endo/exo';
import { Fail, q } from '@endo/errors';
import { readerFromIterator } from '@endo/exo-stream/reader-from-iterator.js';

import { CursorInterface } from '../type-guards.js';
import { toSafeNumber } from './helpers.js';
import { synthQid } from './qid.js';

// A directory entry is a yielded value; undefined is only the terminal value.
/** @type {typeof readerFromIterator<DirectoryEntry, undefined>} */
const readerFromDirectoryEntries = readerFromIterator;

/**
 * @param {object} opts
 * @param {Pick<FsBackend, 'list'>} opts.backend
 * @param {string[]} opts.dirPath
 * @param {<K extends NodeKind>(path: string[], kind: K) => Qid<K>} [opts.qidOf]
 *   optional QID synthesizer (defaults to the path-hash `synthQid`).
 *   wrap-backend passes its content-address-aware `qidOf` so a listing
 *   entry's `qid` matches the one a later `lookup(name).getQid()` would
 *   return (e.g. a git OID rather than a path hash).
 */
export const makeCursorExo = ({ backend, dirPath, qidOf = synthQid }) => {
  /**
   * One backend listing. Streams capture this owner, so an old reader cannot
   * consume or release a listing installed by rewind.
   * @typedef {object} Listing
   * @property {AsyncIterator<DirEntry> | null} iterator
   * @property {Promise<void>} pending
   * @property {Promise<void> | undefined} releasing
   * @property {boolean} fenced
   * @property {boolean} exhausted
   */
  /** @returns {Listing} */
  const makeListing = () => ({
    iterator: null,
    pending: Promise.resolve(),
    releasing: undefined,
    fenced: false,
    exhausted: false,
  });
  let listing = makeListing();
  let closed = false;
  /** @type {Promise<void> | undefined} */
  let rewinding;
  const done = harden({ done: /** @type {const} */ (true), value: undefined });

  /**
   * Serialize pulls shared by paged and streaming consumers. Closing fences
   * queued pulls immediately, but waits for a backend next already issued.
   * @param {Listing} owner
   * @returns {Promise<IteratorResult<DirEntry>>}
   */
  const pull = owner => {
    const result = owner.pending.then(async () => {
      if (closed || owner.fenced || owner.exhausted) return done;
      owner.iterator ??= backend.list(dirPath)[Symbol.asyncIterator]();
      const step = await owner.iterator.next();
      if (step.done) owner.exhausted = true;
      return closed || owner.fenced ? done : step;
    });
    owner.pending = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  /** @param {Listing} owner */
  const release = owner => {
    owner.fenced = true;
    if (owner.releasing) return owner.releasing;
    const attempt = (async () => {
      await owner.pending;
      if (owner.iterator?.return) {
        const result = await owner.iterator.return(undefined);
        result.done || Fail`Cursor listing cleanup has not completed`;
      }
      owner.iterator = null;
      owner.exhausted = true;
    })();
    owner.releasing = attempt;
    void attempt.catch(() => {
      if (owner.releasing === attempt) owner.releasing = undefined;
    });
    return attempt;
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
      const owner = listing;
      if (closed || owner.fenced || owner.exhausted) {
        return harden({ entries: [], atEnd: true });
      }
      const max = limit === undefined ? Infinity : toSafeNumber(limit, 'limit');
      /** @type {DirectoryEntry[]} */
      const entries = [];
      let atEnd = false;
      while (entries.length < max) {
        const step = await pull(owner);
        if (step.done) {
          atEnd = true;
          break;
        }
        entries.push(augment(step.value));
      }
      return harden({ entries, atEnd });
    },
    async stream() {
      const owner = listing;
      // Explicit return forwarding also works before the first pull. An async
      // generator's return before next would never enter its finally block.
      return readerFromDirectoryEntries(
        harden({
          /** @returns {Promise<IteratorResult<DirectoryEntry, undefined>>} */
          next: async () => {
            const step = await pull(owner);
            if (step.done) {
              await release(owner);
              return done;
            }
            return harden({ done: false, value: augment(step.value) });
          },
          return: async () => {
            await release(owner);
            return done;
          },
        }),
      );
    },
    async toArray() {
      const owner = listing;
      /** @type {DirectoryEntry[]} */
      const out = [];
      for (;;) {
        const step = await pull(owner);
        if (step.done) break;
        out.push(augment(step.value));
      }
      return harden(out);
    },
    async skip(n) {
      if (closed) return;
      const count = toSafeNumber(n, 'n');
      const owner = listing;
      for (let i = 0; i < count; i += 1) {
        if ((await pull(owner)).done) return;
      }
    },
    async rewind() {
      if (closed) return;
      if (rewinding) {
        await rewinding;
        return;
      }
      const owner = listing;
      const attempt = (async () => {
        await release(owner);
        if (!closed) listing = makeListing();
      })();
      rewinding = attempt;
      void attempt.then(
        () => {
          if (rewinding === attempt) rewinding = undefined;
        },
        () => {
          if (rewinding === attempt) rewinding = undefined;
        },
      );
      await attempt;
    },
    async close() {
      closed = true;
      await release(listing);
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
