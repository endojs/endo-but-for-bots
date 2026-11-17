// @ts-check
/**
 * The adapter's context cache (M1b W1b.2; architecture D-9, section 4.5;
 * designs/m1b-interfaces.md sections 6.5 and 9). One per adapter
 * incarnation; one entry per session presence (S2 (d): one presence per vat
 * object per incarnation).
 *
 * An entry is the session's records from the compaction boundary
 * (`start`, M1b: 0) up to `count`, the text of every staged field in them,
 * and `epoch`. On each `prepare(session, request)`:
 *
 * - `{ count, epoch }` equal to `request.base`: apply `request.append`.
 * - `count === base.count + append.length` and the cached tail has the
 *   append's kind/turnId sequence: the same round 0 sent again; apply
 *   nothing.
 * - same epoch, `count < base.count`: pull the missing records from
 *   `p<count>` (the session sent `append: []` because the records did not
 *   fit a frame, or a request was never run here), then apply `append`.
 * - otherwise (no entry: first round, restart, eviction; another epoch):
 *   rebuild from the boundary (`page()` with no cursor) and keep only
 *   records **below `base.count`**, then apply `append`. A reopen after an
 *   unannounced restart (contract 7.1 case 3) sends round 0 again with
 *   `base` unchanged while its `TurnStarted` is already in the log: taking
 *   it from a page and again from `append` would project it twice.
 *
 * Staged fields are resolved while the next page is pulled, in whole
 * batches of `blobResolveBatch` (64) handles per manager crank as pages
 * bring them (`BlobStore.resolveMany`; the remainder after the last page),
 * and read in process. Then the records are projected (`projection.js`).
 *
 * Failures: a page call that breaks (the session vat is lost, or anything
 * else from the vat) abandons the round: `isAbandoned(error)` is true and
 * the provider sends nothing. A blob that cannot be resolved or read fails
 * the round with `textOf.stagingFailed`. Either way the entry is dropped,
 * so the next round rebuilds.
 *
 * Retained state is bounded: at most `maxSessions` entries and
 * `maxTextUnits` UTF-16 units of loaded text across them, least recently
 * prepared first out. The entry being prepared is kept while others can go;
 * when it alone is over `maxTextUnits` it is dropped once its projection is
 * built (M1b follow-ups, J-9365: it was kept whatever its size), so that
 * session rebuilds at its next round.
 *
 * Each prepare has its own timing record (J-9365: one record was shared, so
 * two sessions preparing at once reset and added into each other's).
 *
 * Provenance (J-9364): a staged field is read as the session's own
 * (`store.read(blob, session)`); a record that names another session's
 * blob fails the round with `texts.blobNotOwned`.
 *
 * Node only.
 */
/* eslint-disable import/no-relative-packages -- guest/ is its own private package */
import { E } from '@endo/far';
import { performance } from 'node:perf_hooks';

import { limits } from '../../../guest/lib/limits.js';
import { blobsOf } from '../../../guest/session/staging.js';
/* eslint-enable import/no-relative-packages */
import { projectRecords } from './projection.js';
import { projectionHooks } from './projection-hooks.js';

/** Errors that mean "abandon the round; send nothing to the provider". */
const abandoned = new WeakSet();

/** @param {unknown} error */
export const isAbandoned = error =>
  typeof error === 'object' && error !== null && abandoned.has(error);
harden(isAbandoned);

/** Milliseconds, for the timing of one prepare. */
const clock = () => performance.now();

/** @param {unknown} error */
const messageOf = error =>
  /** @type {Error} */ (error)?.message ?? String(error);

/**
 * @typedef {object} Entry
 * @property {number} epoch
 * @property {number} start absolute index of `records[0]`
 * @property {any[]} records
 * @property {Map<any, string>} texts blob presence -> its text
 * @property {number} textUnits
 *
 * @typedef {object} CacheStats
 * @property {number} appends
 * @property {number} duplicates
 * @property {number} gapPulls
 * @property {number} rebuilds
 * @property {number} pages
 * @property {number} pagedRecords
 * @property {number} blobsRead
 * @property {number} evictions
 * @property {number} oversize prepared entries dropped for their own size
 * @property {number} failures
 * @property {number} abandons
 */

/**
 * @param {object} options
 * @param {{ resolveMany: (blobs: readonly any[]) => Promise<void>, read: (blob: any, owner?: any) => Promise<string> }} options.store
 * @param {readonly import('./projection-hooks.js').ProjectionHook[]} [options.hooks]
 * @param {number} [options.maxSessions]
 * @param {number} [options.maxTextUnits]
 * @param {number} [options.readsInFlight] blob files read at once
 */
export const makeContextCache = ({
  store,
  hooks = projectionHooks,
  maxSessions = 32,
  maxTextUnits = 128 * 1024 * 1024,
  readsInFlight = 32,
}) => {
  /** session -> entry, least recently prepared first. @type {Map<any, Entry>} */
  const entries = new Map();
  /** session -> the tail of its prepares (one at a time per session). */
  const tails = new WeakMap();
  let textUnits = 0;
  /**
   * @typedef {{ pages: number, pageMs: number, waitResolveMs: number, readMs: number, blobs: number }} Timing
   *   where one prepare's time went (copied into its projection)
   */
  /** @returns {Timing} */
  const newTiming = () => ({
    pages: 0,
    pageMs: 0,
    waitResolveMs: 0,
    readMs: 0,
    blobs: 0,
  });
  /** @type {CacheStats} */
  const counts = {
    appends: 0,
    duplicates: 0,
    gapPulls: 0,
    rebuilds: 0,
    pages: 0,
    pagedRecords: 0,
    blobsRead: 0,
    evictions: 0,
    oversize: 0,
    failures: 0,
    abandons: 0,
  };

  /** @param {any} session */
  const evict = session => {
    const entry = entries.get(session);
    if (entry === undefined) return;
    entries.delete(session);
    textUnits -= entry.textUnits;
  };

  /** @param {any} keep */
  const trim = keep => {
    for (const session of [...entries.keys()]) {
      if (entries.size <= maxSessions && textUnits <= maxTextUnits) return;
      if (session !== keep) {
        evict(session);
        counts.evictions += 1;
      }
    }
  };

  /**
   * After a prepare: the entry just used goes too when it alone is over
   * the bound (J-9365).
   * @param {any} session
   */
  const trimPrepared = session => {
    const entry = entries.get(session);
    if (entry !== undefined && entry.textUnits > maxTextUnits) {
      evict(session);
      counts.evictions += 1;
      counts.oversize += 1;
    }
  };

  /**
   * Read the staged texts of `records` the entry does not have yet, after
   * the resolutions in flight (`resolving`).
   * @param {Entry} entry
   * @param {readonly any[]} records
   * @param {Timing} timing
   * @param {any} session whose blobs these must be
   * @param {Promise<void>[]} [resolving]
   */
  const loadTexts = async (entry, records, timing, session, resolving = []) => {
    /** @type {any[]} */
    const missing = [];
    const seen = new Set();
    for (const record of records) {
      for (const blob of blobsOf(record)) {
        if (!entry.texts.has(blob) && !seen.has(blob)) {
          seen.add(blob);
          missing.push(blob);
        }
      }
    }
    // Pages started resolving their handles already; this finds the rest
    // (an append's handles are usually bound here: no manager call).
    const waited = clock();
    await Promise.all(resolving);
    await store.resolveMany(missing);
    timing.waitResolveMs += clock() - waited;
    const reading = clock();
    let next = 0;
    const worker = async () => {
      while (next < missing.length) {
        const blob = missing[next];
        next += 1;
        // eslint-disable-next-line no-await-in-loop
        const text = await store.read(blob, session);
        entry.texts.set(blob, text);
        entry.textUnits += text.length;
        textUnits += text.length;
        counts.blobsRead += 1;
      }
    };
    const workers = [];
    for (let i = 0; i < Math.min(readsInFlight, missing.length); i += 1) {
      workers.push(worker());
    }
    await Promise.all(workers);
    timing.readMs += clock() - reading;
    timing.blobs += missing.length;
  };

  /**
   * Pull records from `cursor` (undefined: the boundary) until index `until`;
   * records at or past `until` are dropped. Each page's handles start
   * resolving while the next page is pulled.
   * @param {any} context the session's ContextSource
   * @param {string | undefined} cursor
   * @param {number} until
   * @param {number | undefined} expectFrom
   * @param {Timing} timing
   */
  const pull = async (context, cursor, until, expectFrom, timing) => {
    /** @type {any[]} */
    const got = [];
    /** @type {Promise<void>[]} */
    const resolving = [];
    /** Handles not yet sent to the manager: sent in whole batches of 64. */
    /** @type {any[]} */
    let unsent = [];
    /** @param {number} least */
    const resolveSome = least => {
      while (unsent.length >= least && unsent.length > 0) {
        const batch = unsent.slice(0, limits.blobResolveBatch);
        unsent = unsent.slice(limits.blobResolveBatch);
        const settled = store.resolveMany(batch);
        // Observed by loadTexts; never an unhandled rejection meanwhile.
        settled.catch(() => {});
        resolving.push(settled);
      }
    };
    let from = -1;
    let at = cursor;
    for (;;) {
      /** @type {any} */
      let page;
      const asked = clock();
      try {
        // eslint-disable-next-line no-await-in-loop
        page = await E(context).page(...(at === undefined ? [] : [at]));
      } catch (error) {
        const lost = Error(`context page failed: ${messageOf(error)}`);
        abandoned.add(lost);
        throw lost;
      }
      counts.pages += 1;
      timing.pages += 1;
      timing.pageMs += clock() - asked;
      if (from < 0) {
        from = page.from;
        if (expectFrom !== undefined && from !== expectFrom) {
          throw Error(`context page starts at ${from}, not ${expectFrom}`);
        }
        if (from > until) {
          throw Error(`context boundary ${from} is past the base ${until}`);
        }
      } else if (page.from !== from + got.length) {
        throw Error('context pages are not contiguous');
      }
      const take = page.records.slice(
        0,
        Math.max(0, until - (from + got.length)),
      );
      got.push(...take);
      counts.pagedRecords += take.length;
      for (const record of take) unsent.push(...blobsOf(record));
      resolveSome(limits.blobResolveBatch);
      if (from + got.length >= until) break;
      if (page.next === undefined) {
        throw Error(
          `the session has ${from + got.length} records, not ${until}`,
        );
      }
      at = page.next;
    }
    resolveSome(1);
    return { from, records: got, resolving };
  };

  /**
   * @typedef {{ turnId: string, base: { count: number, epoch: number }, append: any[], context?: any }} CacheRequest
   *   the parts of a RoundRequest the cache reads
   */

  /**
   * @param {any} session
   * @param {CacheRequest} request
   * @param {Timing} timing
   */
  const update = async (session, request, timing) => {
    const { base, append, context } = request;
    let entry = entries.get(session);
    if (entry !== undefined) {
      // Most recently prepared last.
      entries.delete(session);
      entries.set(session, entry);
    }
    const count = entry === undefined ? -1 : entry.start + entry.records.length;
    if (entry !== undefined && entry.epoch === base.epoch) {
      if (count === base.count) {
        entry.records.push(...append);
        counts.appends += 1;
        await loadTexts(entry, append, timing, session);
        return entry;
      }
      if (
        count === base.count + append.length &&
        base.count >= entry.start &&
        append.every((/** @type {any} */ record, /** @type {number} */ i) => {
          const kept = /** @type {Entry} */ (entry).records[
            base.count - /** @type {Entry} */ (entry).start + i
          ];
          return kept.kind === record.kind && kept.turnId === record.turnId;
        })
      ) {
        counts.duplicates += 1;
        return entry;
      }
      if (count < base.count && context !== undefined) {
        counts.gapPulls += 1;
        const gap = await pull(context, `p${count}`, base.count, count, timing);
        entry.records.push(...gap.records, ...append);
        await loadTexts(
          entry,
          [...gap.records, ...append],
          timing,
          session,
          gap.resolving,
        );
        return entry;
      }
    }
    evict(session);
    counts.rebuilds += 1;
    /** @type {Entry} */
    const fresh = {
      epoch: base.epoch,
      start: base.count,
      records: [],
      texts: new Map(),
      textUnits: 0,
    };
    /** @type {Promise<void>[]} */
    let resolving = [];
    if (context !== undefined) {
      // Without a source (an M1a request) only the append is known.
      const pulled = await pull(
        context,
        undefined,
        base.count,
        undefined,
        timing,
      );
      fresh.start = pulled.from;
      fresh.records.push(...pulled.records);
      resolving = pulled.resolving;
    }
    fresh.records.push(...append);
    entries.set(session, fresh);
    entry = fresh;
    await loadTexts(fresh, fresh.records, timing, session, resolving);
    return fresh;
  };

  /**
   * @param {any} session
   * @param {CacheRequest} request
   */
  const prepareNow = async (session, request) => {
    /** @type {Entry} */
    let entry;
    const timing = newTiming();
    try {
      entry = await update(session, request, timing);
    } catch (error) {
      evict(session);
      if (isAbandoned(error)) counts.abandons += 1;
      else counts.failures += 1;
      throw error;
    }
    trim(session);
    const projecting = clock();
    const projected = projectRecords(entry.records, {
      texts: entry.texts,
      hooks,
    });
    /** @type {Record<string, any>} */
    const projection = {
      ...projected,
      epoch: entry.epoch,
      count: entry.start + entry.records.length,
      timing: {
        ...timing,
        projectMs: clock() - projecting,
      },
    };
    const started = entry.records.findLast(
      record =>
        record.kind === 'turn-started' && record.turnId === request.turnId,
    );
    if (started !== undefined) {
      projection.input =
        typeof started.input === 'string'
          ? started.input
          : entry.texts.get(started.input.blob);
    }
    trimPrepared(session);
    return harden(projection);
  };

  return harden({
    /**
     * The projection for one RoundRequest of `session` (the Session
     * presence the endpoint serves); one at a time per session.
     * @param {any} session
     * @param {CacheRequest} request a RoundRequest
     * @returns {Promise<import('./projection.js').Projection>}
     */
    prepare: (session, request) => {
      const before = tails.get(session) ?? Promise.resolve();
      const result = before.then(() => prepareNow(session, request));
      tails.set(
        session,
        result.then(
          () => {},
          () => {},
        ),
      );
      return result;
    },
    evict,
    /** @param {any} session */
    has: session => entries.has(session),
    stats: () => harden({ ...counts, sessions: entries.size, textUnits }),
  });
};
harden(makeContextCache);
