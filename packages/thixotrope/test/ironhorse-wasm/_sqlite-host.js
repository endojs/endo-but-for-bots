// @ts-check
// A host for the wasm Ironhorse worker over `node:sqlite`: `host-abi.mjs`
// plus one database file, prepared statements cached by their SQL text, and
// integer columns read back as numbers. Every export call runs inside a
// transaction (`BEGIN IMMEDIATE`, then `COMMIT` only when `commits` from
// `host-abi.mjs` permits it, else `ROLLBACK`); a fresh worker's opening is
// one transaction from the fresh open through ready, as the ABI requires.
// The database is opened, and statements run, by the shell's own opener and
// executor. Nothing here depends on the test runner.
import { getRandomValues } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import {
  commits,
  makeExports,
  makeHostImports,
  makeWasiImports,
} from '../../src/ironhorse/wasm/host-abi.mjs';
import {
  makeExecutor,
  openHeapDatabase,
} from '../../src/ironhorse/wasm/shell.mjs';

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
  const db = openHeapDatabase(DatabaseSync, path);
  const execute = makeExecutor(db);
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
    return execute(sql, params);
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
  let randomFails = false;
  /** @param {Uint8Array} bytes */
  const random = bytes => {
    // A guest view is never over a SharedArrayBuffer: the module's memory
    // is not shared.
    getRandomValues(/** @type {Uint8Array<ArrayBuffer>} */ (bytes));
  };
  /**
   * The commit tokens' randomness, which `failRandom` can break. The WASI
   * shim keeps its own: std draws from it once, for its hash keys.
   *
   * @param {Uint8Array} bytes
   */
  const hostRandom = bytes => {
    if (randomFails) throw Error('the host randomness is unavailable');
    random(bytes);
  };
  const log = (/** @type {string} */ line) => logs.push(line);
  const instance = await WebAssembly.instantiate(module, {
    env: makeHostImports({
      getMemory,
      exec: database.exec,
      random: hostRandom,
      log,
    }),
    wasi_snapshot_preview1: makeWasiImports({
      getMemory,
      random,
      nowNs: () => process.hrtime.bigint(),
      log,
    }),
  });
  memory = /** @type {WebAssembly.Memory} */ (instance.exports.memory);
  const exports = makeExports(instance);

  /** Whether a fresh worker's opening holds a transaction open. */
  let opening = false;
  /** @param {boolean} commit */
  const end = commit => {
    opening = false;
    database.db.exec(commit ? 'COMMIT' : 'ROLLBACK');
  };

  /**
   * One export call inside a transaction: its own, or the opening's.
   *
   * @template {{ status: number }} T
   * @param {string} name the export, as `commits` names it
   * @param {() => T} call
   * @param {boolean} [keep] false to roll back even a committing status
   * @param {boolean} [starts] whether this call is a fresh open
   * @returns {T}
   */
  const transact = (name, call, keep = true, starts = false) => {
    const held = opening || starts;
    if (!opening) database.db.exec('BEGIN IMMEDIATE');
    let answer;
    try {
      answer = call();
    } catch (error) {
      end(false);
      throw error;
    }
    const permitted = keep && commits(name, answer.status);
    if (!held) {
      end(permitted);
    } else if (!permitted || name === 'ready') {
      end(permitted);
    } else {
      opening = true;
    }
    return answer;
  };
  return {
    instance,
    exports,
    logs,
    memoryBytes: () => getMemory().buffer.byteLength,
    /** @param {boolean} fails whether the host's randomness throws */
    failRandom: fails => {
      randomFails = fails;
    },
    /**
     * A fresh open begins the opening's transaction, which `ready` ends.
     *
     * @param {OpenOptions} options
     * @param {boolean} [keep]
     */
    open: (options, keep) =>
      transact('open', () => exports.open(options), keep, options.fresh),
    /**
     * @param {string} name
     * @param {string} source
     * @param {boolean} [keep]
     */
    boot: (name, source, keep) =>
      transact('boot', () => exports.boot(name, source), keep),
    /** @param {boolean} [keep] */
    ready: keep => transact('ready', () => exports.ready(), keep),
    /**
     * @param {string} line
     * @param {boolean} [keep]
     */
    request: (line, keep) =>
      transact('request', () => exports.request(line), keep),
    /** @param {boolean} [keep] */
    close: keep => transact('close', () => exports.close(), keep),
  };
};
