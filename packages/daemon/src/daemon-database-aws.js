// @ts-check

/**
 * DynamoDB-backed storage engine for the Endo daemon: the third engine
 * behind the `DaemonDatabase` interface, alongside `better-sqlite3`
 * (`daemon-database-node.js`) and the XS-on-Rust rusqlite shim
 * (`better-sqlite3-xs.js`).  Design: `designs/endo-daemon-aws-storage.md`.
 *
 * `DaemonDatabase` consumers are synchronous (`pet-store.js` iterates
 * `listPetStoreEntries` without awaiting; `daemon.js` uses `getAgentKey`
 * and `listRetention` return values directly), and DynamoDB is
 * unavoidably asynchronous, so this engine serves the synchronous
 * surface from an in-memory mirror: an async warm boot scans the whole
 * table into memory, every read answers from the mirror, and every
 * mutation applies to the mirror synchronously and flushes to DynamoDB
 * through a serialized write-behind queue.  `flushed()` is the drain
 * point; a flush that fails after retries calls `onFlushError` and
 * poisons the queue, because a mirror that has diverged from the table
 * must not keep acknowledging writes.
 *
 * The engine consumes a narrow, pre-authorized `DynamoTablePowers`
 * capability rather than an SDK client, so this module carries no AWS
 * dependency and no ambient authority; the SDK adapter lives in
 * `daemon-aws-sdk.js`.
 */

import harden from '@endo/harden';
import { q } from '@endo/errors';
import { makeSerialJobs } from './serial-jobs.js';

/** @import { Formula } from './types.js' */
/** @import { DaemonDatabase } from './daemon-database.js' */

/**
 * A capability bound to one DynamoDB table (or a faithful emulation).
 * Values are strings; keys are `{ pk, sk }` string pairs.  `get`,
 * `query`, and `scan` are strongly consistent.  `transact` applies all
 * of its writes atomically or none of them.
 *
 * @typedef {object} DynamoTablePowers
 * @property {(args: {
 *   pk: string,
 *   sk: string,
 *   value: string,
 *   ifAbsent?: boolean,
 * }) => Promise<{ applied: boolean }>} put
 * @property {(args: { pk: string, sk: string }) => Promise<string | undefined>} get
 * @property {(args: { pk: string, sk: string }) => Promise<void>} delete
 * @property {(args: { pk: string, cursor?: string }) => Promise<{
 *   items: Array<{ sk: string, value: string }>,
 *   cursor?: string,
 * }>} query
 * @property {(args: { cursor?: string }) => Promise<{
 *   items: Array<{ pk: string, sk: string, value: string }>,
 *   cursor?: string,
 * }>} scan
 * @property {(args: {
 *   deletes: Array<{ pk: string, sk: string }>,
 *   puts: Array<{ pk: string, sk: string, value: string }>,
 * }) => Promise<void>} transact
 */

// Partition names, one per SQLite table of `daemon-database.js`.
const STATE = 'state';
const FORMULA = 'formula';
const AGENT_KEY = 'agentKey';
const REMOTE_AGENT_KEY = 'remoteAgentKey';
const PET_STORE = 'petStore';
const RETENTION = 'retention';
const SYNCED = 'synced';
const SYNCED_META = 'syncedMeta';

const FLUSH_ATTEMPTS = 3;

/**
 * Composite sort keys join components with `:`, which cannot appear in
 * any component (store numbers, public keys, and formula numbers are
 * hex; pet names match the daemon's pet-name pattern; store types are
 * a fixed kebab-case enum).
 *
 * @param {Array<string>} components
 */
const joinKey = components => components.join(':');

/**
 * @param {object} args
 * @param {DynamoTablePowers} args.tablePowers
 * @param {(error: Error) => void} [args.onFlushError] - Called once when
 * a write-behind flush fails after retries.  The daemon flavour should
 * treat this as fatal: the mirror and the table have diverged.
 * @returns {Promise<DaemonDatabase & {
 *   flushed: () => Promise<void>,
 * }>}
 */
export const makeDaemonDatabaseAws = async ({
  tablePowers,
  onFlushError = error => {
    console.error('Endo daemon AWS database flush failed', error);
  },
}) => {
  // The in-memory mirror, keyed exactly as the table is.
  /** @type {Map<string, Map<string, string>>} */
  const mirror = new Map();

  /** @param {string} pk */
  const providePartition = pk => {
    let partition = mirror.get(pk);
    if (partition === undefined) {
      partition = new Map();
      mirror.set(pk, partition);
    }
    return partition;
  };

  /**
   * @param {string} pk
   * @param {string} sk
   */
  const mirrorGet = (pk, sk) => mirror.get(pk)?.get(sk);

  /**
   * Sorted entries of one partition, so listings are deterministic
   * (SQLite listings are unordered; sorted is a compatible refinement).
   *
   * @param {string} pk
   * @returns {Array<[string, string]>}
   */
  const mirrorList = pk => {
    const partition = mirror.get(pk);
    if (partition === undefined) {
      return [];
    }
    return [...partition.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
  };

  // Warm boot: scan the whole table into the mirror.  The structured
  // state is small (formulas, keys, names; blobs live in the content
  // store), so a full mirror is cheap, generalizing the load-into-a-
  // multimap pattern `pet-store.js` already uses.
  // No synchronous preamble.
  await null;

  /** @type {string | undefined} */
  let bootCursor;
  do {
    // eslint-disable-next-line no-await-in-loop
    const page = await tablePowers.scan({ cursor: bootCursor });
    for (const { pk, sk, value } of page.items) {
      providePartition(pk).set(sk, value);
    }
    bootCursor = page.cursor;
  } while (bootCursor !== undefined);

  // The write-behind queue.  Remote writes apply in mutation order; a
  // flush that fails after retries poisons the queue and escalates.
  const flushJobs = makeSerialJobs();
  /** @type {Error | undefined} */
  let flushFailure;

  /** @param {() => Promise<void>} flushOp */
  const enqueueFlush = flushOp => {
    void flushJobs
      .enqueue(async () => {
        await null;
        if (flushFailure !== undefined) {
          return;
        }
        /** @type {Error | undefined} */
        let lastError;
        for (let attempt = 0; attempt < FLUSH_ATTEMPTS; attempt += 1) {
          try {
            // eslint-disable-next-line no-await-in-loop
            await flushOp();
            return;
          } catch (error) {
            lastError = /** @type {Error} */ (error);
          }
        }
        flushFailure = lastError;
        onFlushError(/** @type {Error} */ (lastError));
      })
      .catch(() => {});
  };

  const flushed = () =>
    flushJobs.enqueue(async () => {
      if (flushFailure !== undefined) {
        throw flushFailure;
      }
    });

  /**
   * @param {string} pk
   * @param {string} sk
   * @param {string} value
   */
  const writeThrough = (pk, sk, value) => {
    providePartition(pk).set(sk, value);
    enqueueFlush(async () => {
      await tablePowers.put({ pk, sk, value });
    });
  };

  /**
   * @param {string} pk
   * @param {string} sk
   */
  const deleteThrough = (pk, sk) => {
    mirror.get(pk)?.delete(sk);
    enqueueFlush(async () => {
      await tablePowers.delete({ pk, sk });
    });
  };

  // -- Formula operations --

  /** @param {string} formulaNumber */
  const hasFormula = formulaNumber => {
    return mirrorGet(FORMULA, formulaNumber) !== undefined;
  };

  /** @param {string} formulaNumber */
  const readFormula = formulaNumber => {
    const row = mirrorGet(FORMULA, formulaNumber);
    if (row === undefined) {
      throw new ReferenceError(
        `No formula exists for number ${q(formulaNumber)}`,
      );
    }
    try {
      const { node, body } = JSON.parse(row);
      return { node, formula: JSON.parse(body) };
    } catch (error) {
      throw new TypeError(
        `Corrupt formula for number ${q(formulaNumber)}: ${/** @type {Error} */ (error).message}`,
      );
    }
  };

  /**
   * @param {string} formulaNumber
   * @param {string} nodeNumber
   * @param {Formula} formula
   */
  const writeFormula = (formulaNumber, nodeNumber, formula) => {
    writeThrough(
      FORMULA,
      formulaNumber,
      JSON.stringify({ node: nodeNumber, body: JSON.stringify(formula) }),
    );
  };

  /** @param {string} formulaNumber */
  const deleteFormula = formulaNumber => {
    deleteThrough(FORMULA, formulaNumber);
  };

  const listFormulas = () => {
    return mirrorList(FORMULA).map(([number, row]) => ({
      number,
      node: /** @type {{node: string}} */ (JSON.parse(row)).node,
    }));
  };

  /**
   * @param {string} nodeNumber
   * @returns {string[]}
   */
  const listFormulaNumbersByNode = nodeNumber => {
    return listFormulas()
      .filter(({ node }) => node === nodeNumber)
      .map(({ number }) => number);
  };

  // -- Daemon state --

  /** @param {string} key */
  const getState = key => {
    return mirrorGet(STATE, key);
  };

  /**
   * @param {string} key
   * @param {string} value
   */
  const setState = (key, value) => {
    writeThrough(STATE, key, value);
  };

  // -- Agent key operations --

  /**
   * @param {string} publicKey
   * @param {string} privateKey
   * @param {string} agentId
   */
  const writeAgentKey = (publicKey, privateKey, agentId) => {
    writeThrough(AGENT_KEY, publicKey, JSON.stringify({ privateKey, agentId }));
  };

  /** @param {string} publicKey */
  const getAgentKey = publicKey => {
    const row = mirrorGet(AGENT_KEY, publicKey);
    if (row === undefined) {
      return undefined;
    }
    const { privateKey, agentId } = JSON.parse(row);
    return { publicKey, privateKey, agentId };
  };

  /** @param {string} publicKey */
  const hasAgentKey = publicKey => {
    return mirrorGet(AGENT_KEY, publicKey) !== undefined;
  };

  const listAgentKeys = () => {
    return mirrorList(AGENT_KEY).map(([publicKey, row]) => {
      const { privateKey, agentId } = JSON.parse(row);
      return { publicKey, privateKey, agentId };
    });
  };

  /** @param {string} publicKey */
  const deleteAgentKey = publicKey => {
    deleteThrough(AGENT_KEY, publicKey);
  };

  // -- Remote agent key operations --

  /**
   * @param {string} publicKey
   * @param {string} daemonNode
   */
  const writeRemoteAgentKey = (publicKey, daemonNode) => {
    writeThrough(REMOTE_AGENT_KEY, publicKey, daemonNode);
  };

  /** @param {string} publicKey */
  const getRemoteAgentKey = publicKey => {
    return mirrorGet(REMOTE_AGENT_KEY, publicKey);
  };

  // -- Pet store operations --

  /**
   * @param {string} storeNumber
   * @param {string} storeType
   */
  const petStorePrefix = (storeNumber, storeType) =>
    `${joinKey([storeNumber, storeType])}:`;

  /**
   * @param {string} storeNumber
   * @param {string} storeType
   * @param {string} name
   * @param {string} formulaId
   */
  const writePetStoreEntry = (storeNumber, storeType, name, formulaId) => {
    writeThrough(PET_STORE, joinKey([storeNumber, storeType, name]), formulaId);
  };

  /**
   * @param {string} storeNumber
   * @param {string} storeType
   * @param {string} name
   */
  const deletePetStoreEntry = (storeNumber, storeType, name) => {
    deleteThrough(PET_STORE, joinKey([storeNumber, storeType, name]));
  };

  /**
   * @param {string} storeNumber
   * @param {string} storeType
   * @param {string} fromName
   * @param {string} toName
   */
  const renamePetStoreEntry = (storeNumber, storeType, fromName, toName) => {
    const fromKey = joinKey([storeNumber, storeType, fromName]);
    const toKey = joinKey([storeNumber, storeType, toName]);
    const partition = providePartition(PET_STORE);
    const formulaId = partition.get(fromKey);
    if (formulaId === undefined) {
      // Match the SQLite engine, which clears the target name even
      // when the source name is absent.
      deleteThrough(PET_STORE, toKey);
      return;
    }
    partition.delete(fromKey);
    partition.set(toKey, formulaId);
    // The atomic delete-plus-put preserves what SQLite's two-statement
    // rename gets from its transaction: no observer of the table can
    // see the graph with both names or neither.
    enqueueFlush(async () => {
      await tablePowers.transact({
        deletes: [{ pk: PET_STORE, sk: fromKey }],
        puts: [{ pk: PET_STORE, sk: toKey, value: formulaId }],
      });
    });
  };

  /**
   * @param {string} storeNumber
   * @param {string} storeType
   * @returns {Array<{name: string, formulaId: string}>}
   */
  const listPetStoreEntries = (storeNumber, storeType) => {
    const prefix = petStorePrefix(storeNumber, storeType);
    return mirrorList(PET_STORE)
      .filter(([sk]) => sk.startsWith(prefix))
      .map(([sk, formulaId]) => ({
        name: sk.slice(prefix.length),
        formulaId,
      }));
  };

  /**
   * @param {string} storeNumber
   * @param {string} storeType
   */
  const deletePetStore = (storeNumber, storeType) => {
    const prefix = petStorePrefix(storeNumber, storeType);
    const partition = providePartition(PET_STORE);
    const doomed = [...partition.keys()].filter(sk => sk.startsWith(prefix));
    for (const sk of doomed) {
      partition.delete(sk);
    }
    enqueueFlush(async () => {
      await tablePowers.transact({
        deletes: doomed.map(sk => ({ pk: PET_STORE, sk })),
        puts: [],
      });
    });
  };

  // -- Retention operations --

  /**
   * @param {string} guestPublicKey
   * @param {string} formulaNumber
   */
  const writeRetention = (guestPublicKey, formulaNumber) => {
    writeThrough(RETENTION, joinKey([guestPublicKey, formulaNumber]), '1');
  };

  /**
   * @param {string} guestPublicKey
   * @param {string} formulaNumber
   */
  const deleteRetention = (guestPublicKey, formulaNumber) => {
    deleteThrough(RETENTION, joinKey([guestPublicKey, formulaNumber]));
  };

  /**
   * @param {string} guestPublicKey
   * @returns {Array<{formulaNumber: string}>}
   */
  const listRetention = guestPublicKey => {
    const prefix = `${guestPublicKey}:`;
    return mirrorList(RETENTION)
      .filter(([sk]) => sk.startsWith(prefix))
      .map(([sk]) => ({ formulaNumber: sk.slice(prefix.length) }));
  };

  /**
   * @param {string} guestPublicKey
   * @returns {string[]} The doomed sort keys, mirror-side.
   */
  const clearRetentionMirror = guestPublicKey => {
    const prefix = `${guestPublicKey}:`;
    const partition = providePartition(RETENTION);
    const doomed = [...partition.keys()].filter(sk => sk.startsWith(prefix));
    for (const sk of doomed) {
      partition.delete(sk);
    }
    return doomed;
  };

  /**
   * @param {string} guestPublicKey
   * @param {string[]} formulaNumbers
   */
  const replaceRetention = (guestPublicKey, formulaNumbers) => {
    const doomed = clearRetentionMirror(guestPublicKey);
    const partition = providePartition(RETENTION);
    const puts = formulaNumbers.map(formulaNumber => {
      const sk = joinKey([guestPublicKey, formulaNumber]);
      partition.set(sk, '1');
      return { pk: RETENTION, sk, value: '1' };
    });
    const deletes = doomed
      .filter(sk => !puts.some(put => put.sk === sk))
      .map(sk => ({ pk: RETENTION, sk }));
    enqueueFlush(async () => {
      await tablePowers.transact({ deletes, puts });
    });
  };

  /** @param {string} guestPublicKey */
  const deleteAllRetention = guestPublicKey => {
    const doomed = clearRetentionMirror(guestPublicKey);
    enqueueFlush(async () => {
      await tablePowers.transact({
        deletes: doomed.map(sk => ({ pk: RETENTION, sk })),
        puts: [],
      });
    });
  };

  // -- Synced store operations --

  /**
   * @param {string} storeNumber
   * @param {string} name
   * @param {string | null} locator
   * @param {number} timestamp
   * @param {string} writer
   */
  const writeSyncedEntry = (storeNumber, name, locator, timestamp, writer) => {
    writeThrough(
      SYNCED,
      joinKey([storeNumber, name]),
      JSON.stringify({ locator, timestamp, writer }),
    );
  };

  /**
   * @param {string} storeNumber
   * @param {string} name
   */
  const deleteSyncedEntry = (storeNumber, name) => {
    deleteThrough(SYNCED, joinKey([storeNumber, name]));
  };

  /**
   * @param {string} storeNumber
   * @returns {Array<{name: string, locator: string | null, timestamp: number, writer: string}>}
   */
  const listSyncedEntries = storeNumber => {
    const prefix = `${storeNumber}:`;
    return mirrorList(SYNCED)
      .filter(([sk]) => sk.startsWith(prefix))
      .map(([sk, row]) => {
        const { locator, timestamp, writer } = JSON.parse(row);
        return { name: sk.slice(prefix.length), locator, timestamp, writer };
      });
  };

  /** @param {string} storeNumber */
  const deleteAllSyncedEntries = storeNumber => {
    const prefix = `${storeNumber}:`;
    const partition = providePartition(SYNCED);
    const doomed = [...partition.keys()].filter(sk => sk.startsWith(prefix));
    for (const sk of doomed) {
      partition.delete(sk);
    }
    enqueueFlush(async () => {
      await tablePowers.transact({
        deletes: doomed.map(sk => ({ pk: SYNCED, sk })),
        puts: [],
      });
    });
  };

  /**
   * @param {string} storeNumber
   * @returns {{localClock: number, remoteAckedClock: number}}
   */
  const getSyncedMeta = storeNumber => {
    const row = mirrorGet(SYNCED_META, storeNumber);
    if (row === undefined) {
      return { localClock: 0, remoteAckedClock: 0 };
    }
    return JSON.parse(row);
  };

  /**
   * @param {string} storeNumber
   * @param {number} localClock
   * @param {number} remoteAckedClock
   */
  const setSyncedMeta = (storeNumber, localClock, remoteAckedClock) => {
    writeThrough(
      SYNCED_META,
      storeNumber,
      JSON.stringify({ localClock, remoteAckedClock }),
    );
  };

  /** @param {string} storeNumber */
  const deleteSyncedMeta = storeNumber => {
    deleteThrough(SYNCED_META, storeNumber);
  };

  const close = () => {
    // Drain the write-behind queue.  `DaemonDatabase['close']` is
    // fire-and-forget for the SQLite engines; callers that need the
    // drain point await `flushed()` explicitly.
    void flushed();
  };

  return harden({
    // The SQLite engines expose their engine handle as `db`; this
    // engine has none.  No consumer outside `daemon-database.js`
    // touches `.db` (see the design's phase-2 note on making the field
    // engine-private).
    db: /** @type {any} */ (undefined),
    close,
    flushed,
    hasFormula,
    writeFormula,
    readFormula,
    deleteFormula,
    listFormulas,
    listFormulaNumbersByNode,
    getState,
    setState,
    writeAgentKey,
    getAgentKey,
    hasAgentKey,
    listAgentKeys,
    deleteAgentKey,
    writeRemoteAgentKey,
    getRemoteAgentKey,
    writePetStoreEntry,
    deletePetStoreEntry,
    renamePetStoreEntry,
    listPetStoreEntries,
    deletePetStore,
    writeRetention,
    deleteRetention,
    listRetention,
    replaceRetention,
    deleteAllRetention,
    writeSyncedEntry,
    deleteSyncedEntry,
    listSyncedEntries,
    deleteAllSyncedEntries,
    getSyncedMeta,
    setSyncedMeta,
    deleteSyncedMeta,
  });
};
harden(makeDaemonDatabaseAws);
