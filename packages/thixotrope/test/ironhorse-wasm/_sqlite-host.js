// @ts-check
// A host for the wasm Ironhorse worker over `node:sqlite`: `host-abi.mjs`
// plus one database file, with every export call inside one transaction
// (`BEGIN IMMEDIATE` ... `COMMIT`, or `ROLLBACK` unless the status says
// commit), prepared statements cached by their SQL text, and integer
// columns read back as numbers. Nothing here depends on the test runner.
import { getRandomValues } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import {
  STATUS,
  makeExports,
  makeHostImports,
  makeWasiImports,
} from '../../src/ironhorse/wasm/host-abi.mjs';

/** @import { StatementSync } from 'node:sqlite' */
/** @import { OpenOptions } from '../../src/ironhorse/wasm/host-abi.mjs' */

/** Where `rust/thixotrope-ironhorse-wasm/build.py` leaves the module. */
export const MODULE_PATH =
  process.env.THIXOTROPE_IRONHORSE_WASM ||
  fileURLToPath(
    new URL(
      '../../../../target/wasm32-wasip1/release/thixotrope_ironhorse_wasm.wasm',
      import.meta.url,
    ),
  );

/** @param {string} path */
export const compileModule = path =>
  readFile(path).then(bytes => WebAssembly.compile(bytes));

/**
 * One database file and the statement executor over it.
 *
 * @param {string} path
 */
export const openDatabase = path => {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode=DELETE');
  /** @type {Map<string, StatementSync>} */
  const statements = new Map();
  /** Counts every statement run, for fault injection. */
  let executed = 0;
  /** @type {((sql: string, count: number) => void) | undefined} */
  let fault;
  /**
   * @param {string} sql
   * @param {unknown[]} params
   */
  const exec = (sql, params) => {
    executed += 1;
    if (fault) fault(sql, executed);
    let statement = statements.get(sql);
    if (statement === undefined) {
      statement = db.prepare(sql);
      statement.setReturnArrays(true);
      statements.set(sql, statement);
    }
    return /** @type {any} */ (statement.all(.../** @type {any[]} */ (params)));
  };
  return {
    db,
    exec,
    /** @param {((sql: string, count: number) => void) | undefined} hook */
    setFault: hook => {
      fault = hook;
      executed = 0;
    },
    close: () => db.close(),
  };
};

/**
 * Instantiate the module over a database: the host imports, the WASI shim,
 * and the export wrapper.
 *
 * @param {WebAssembly.Module} module
 * @param {ReturnType<typeof openDatabase>} database
 */
export const instantiateWorker = async (module, database) => {
  /** @type {string[]} */
  const logs = [];
  /** @type {WebAssembly.Memory | undefined} */
  let memory;
  const getMemory = () => {
    if (memory === undefined) throw Error('the instance has no memory yet');
    return memory;
  };
  /** @param {Uint8Array} bytes */
  const random = bytes => {
    // A guest view is never over a SharedArrayBuffer: the module's memory
    // is not shared.
    getRandomValues(/** @type {Uint8Array<ArrayBuffer>} */ (bytes));
  };
  const log = (/** @type {string} */ line) => logs.push(line);
  const instance = await WebAssembly.instantiate(module, {
    env: makeHostImports({ getMemory, exec: database.exec, random, log }),
    wasi_snapshot_preview1: makeWasiImports({
      getMemory,
      random,
      nowNs: () => process.hrtime.bigint(),
      log,
    }),
  });
  memory = /** @type {WebAssembly.Memory} */ (instance.exports.memory);
  const exports = makeExports(instance);

  /**
   * One export call inside one transaction.
   *
   * @template {{ status: number }} T
   * @param {() => T} call
   * @param {number[]} commits the statuses that commit
   * @param {boolean} [keep] false to roll back even a committing status
   * @returns {T}
   */
  const transact = (call, commits, keep = true) => {
    database.db.exec('BEGIN IMMEDIATE');
    let answer;
    try {
      answer = call();
    } catch (error) {
      database.db.exec('ROLLBACK');
      throw error;
    }
    database.db.exec(
      keep && commits.includes(answer.status) ? 'COMMIT' : 'ROLLBACK',
    );
    return answer;
  };
  const ok = [STATUS.OK];
  return {
    instance,
    exports,
    logs,
    memoryBytes: () => getMemory().buffer.byteLength,
    /**
     * @param {OpenOptions} options
     * @param {boolean} [keep]
     */
    open: (options, keep) => transact(() => exports.open(options), ok, keep),
    /**
     * @param {string} name
     * @param {string} source
     * @param {boolean} [keep]
     */
    boot: (name, source, keep) =>
      transact(() => exports.boot(name, source), ok, keep),
    /** @param {boolean} [keep] */
    ready: keep => transact(() => exports.ready(), ok, keep),
    /**
     * @param {string} line
     * @param {boolean} [keep]
     */
    request: (line, keep) =>
      transact(() => exports.request(line), [STATUS.OK, STATUS.CLOSE], keep),
    /** @param {boolean} [keep] */
    close: keep => transact(() => exports.close(), ok, keep),
  };
};
