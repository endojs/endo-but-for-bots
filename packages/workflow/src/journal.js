// @ts-check

/**
 * The durable, hash-chained run journal over a writable virtual-file-
 * system directory (`@endo/platform/fs/extended` verbs: `lookup`,
 * `list`, `write`, `makeDirectory`, `move`, `remove`).
 *
 * Layout under a run's directory:
 *
 * ```
 * <runDirectory>/
 *   events/
 *     00000001.json     # one record per file, write-then-move atomic
 *   snapshot.json       # { throughSeq, state } refreshed periodically
 * ```
 *
 * Each record's `prev` field is the lowercase hex SHA-256 of the
 * previous record's canonical bytes (empty string for the first), so an
 * exported journal is verifiable as an unbroken chain independent of
 * the engine that produced it.
 *
 * Atomic replacement is write-then-`move` within one directory, the
 * contract established by the `@endo/reminder` store: the backing may
 * be a host directory, an in-memory tree, or a daemon mount.
 */

import harden from '@endo/harden';
import { E } from '@endo/eventual-send';
import { makeError, q, X } from '@endo/errors';
import { encodeHex } from '@endo/hex';
import { sha256 } from '@endo/sha256';

/** @import { JournalEventInput, JournalRecord, RunJournal } from './types.js' */

const EVENTS_DIRECTORY = 'events';
const SNAPSHOT_NAME = 'snapshot.json';
// Eight digits deliberately cap a run at 10**8 events.
const SEQ_DIGITS = 8;

const textEncoder = new TextEncoder();

/** @param {unknown} error */
const isEnoent = error =>
  /ENOENT/u.test(String((error && /** @type {Error} */ (error).message) || ''));

/**
 * Deterministic JSON with lexicographically sorted object keys, so a
 * record's hash does not depend on property insertion order.
 *
 * @param {unknown} value
 * @returns {string}
 */
export const canonicalJson = value => {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value)
      .filter(([, propertyValue]) => propertyValue !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(
        ([key, propertyValue]) =>
          `${JSON.stringify(key)}:${canonicalJson(propertyValue)}`,
      );
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
};
harden(canonicalJson);

/**
 * @param {unknown} record
 * @returns {string} lowercase hex SHA-256 of the record's canonical bytes
 */
export const hashRecord = record => {
  return encodeHex(sha256(textEncoder.encode(canonicalJson(record))));
};
harden(hashRecord);

/**
 * Verify a journal's hash chain. Returns the first broken seq, or
 * `undefined` when the chain is unbroken.
 *
 * @param {JournalRecord[]} records
 * @returns {number | undefined}
 */
export const findChainBreak = records => {
  let prev = '';
  let expectedSeq = records.length > 0 ? records[0].seq : 1;
  for (const record of records) {
    if (record.seq !== expectedSeq || record.prev !== prev) {
      return record.seq;
    }
    prev = hashRecord(record);
    expectedSeq += 1;
  }
  return undefined;
};
harden(findChainBreak);

/** @param {number} seq */
const segmentName = seq => `${String(seq).padStart(SEQ_DIGITS, '0')}.json`;

/**
 * Provide the durable journal for one run.
 *
 * @param {import('@endo/eventual-send').ERef<any>} runDirectory writable
 *   directory cap for this run
 * @param {object} options
 * @param {string} options.runId
 * @param {() => number} options.now timestamp source, injected so the
 *   interpreter core stays clock-free
 * @param {(suffix: string) => void} [options.warn] corrupt-entry reporter;
 *   defaults to `console.warn` on stderr-adjacent diagnostics
 * @returns {Promise<RunJournal>}
 */
export const provideRunJournal = async (runDirectory, { runId, now, warn }) => {
  await null;
  const report =
    warn ??
    (message => {
      // Diagnostics are stderr-only per the repository's discipline.
      console.warn(`[workflow] ${message}`);
    });
  const eventsDirectory = await E(runDirectory).makeDirectory(
    EVENTS_DIRECTORY,
    {},
  );

  /**
   * @param {import('@endo/eventual-send').ERef<any>} directory
   * @param {string} name
   * @param {unknown} value
   */
  const atomicWrite = async (directory, name, value) => {
    const temporaryName = `.tmp.${name}`;
    await E(directory).write(temporaryName, `${canonicalJson(value)}\n`);
    await E(directory).move(temporaryName, name);
  };

  /**
   * @param {import('@endo/eventual-send').ERef<any>} directory
   * @param {string} name
   */
  const readJson = async (directory, name) => {
    await null;
    let file;
    try {
      file = await E(directory).lookup(name);
    } catch (error) {
      if (isEnoent(error)) {
        return undefined;
      }
      throw error;
    }
    const blob = await E(file).snapshot();
    return E(blob).json();
  };

  // Load every existing record, in segment order.
  /** @type {JournalRecord[]} */
  const loaded = [];
  {
    const cursor = await E(eventsDirectory).list();
    const entries = await E(cursor).toArray();
    const names = entries
      .filter(
        (/** @type {{ name: string, kind: string }} */ { name, kind }) =>
          kind === 'file' && /^\d{8}\.json$/u.test(name),
      )
      .map((/** @type {{ name: string }} */ { name }) => name)
      .sort();
    for (const name of names) {
      /** @type {unknown} */
      let record;
      try {
        // eslint-disable-next-line no-await-in-loop
        record = await readJson(eventsDirectory, name);
      } catch (_error) {
        record = undefined;
      }
      if (record === undefined) {
        // A skipped segment breaks the chain check below, which is the
        // intended failure: a journal with a hole is not trustworthy.
        report(`skipping unreadable journal segment ${name} of run ${runId}`);
      } else {
        loaded.push(/** @type {JournalRecord} */ (record));
      }
    }
    const broken = findChainBreak(loaded);
    if (broken !== undefined) {
      throw makeError(
        X`Journal chain of run ${q(runId)} breaks at seq ${q(broken)}`,
      );
    }
  }

  let lastSeq = loaded.length > 0 ? loaded[loaded.length - 1].seq : 0;
  let tailHash = loaded.length > 0 ? hashRecord(loaded[loaded.length - 1]) : '';

  /** @type {RunJournal['append']} */
  const append = async events => {
    await null;
    /** @type {JournalRecord[]} */
    const appended = [];
    for (const event of events) {
      lastSeq += 1;
      const seq = lastSeq;
      /** @type {JournalRecord} */
      const record = harden({
        ...event,
        ...(event.type === 'effect.issued'
          ? { idempotencyKey: `${runId}:${seq}:${event.as}` }
          : {}),
        seq,
        at: now(),
        prev: tailHash,
      });
      // eslint-disable-next-line no-await-in-loop
      await atomicWrite(eventsDirectory, segmentName(seq), record);
      tailHash = hashRecord(record);
      loaded.push(record);
      appended.push(record);
    }
    return harden(appended);
  };

  /** @type {RunJournal['records']} */
  const records = () => harden([...loaded]);

  /** @type {RunJournal['readFrom']} */
  const readFrom = fromSeq =>
    harden(loaded.filter(record => record.seq >= fromSeq));

  /** @type {RunJournal['writeSnapshot']} */
  const writeSnapshot = async snapshot => {
    await atomicWrite(runDirectory, SNAPSHOT_NAME, snapshot);
  };

  /** @type {RunJournal['readSnapshot']} */
  const readSnapshot = async () => {
    return readJson(runDirectory, SNAPSHOT_NAME);
  };

  return harden({
    append,
    records,
    readFrom,
    writeSnapshot,
    readSnapshot,
  });
};
harden(provideRunJournal);
