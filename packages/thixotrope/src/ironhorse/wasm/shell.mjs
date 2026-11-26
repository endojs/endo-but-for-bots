// @ts-check
// The Node shell of the WebAssembly Ironhorse worker: what
// `rust/thixotrope-ironhorse-worker` is for the native engine, over the same
// core compiled to `thixotrope_ironhorse_wasm.wasm`. The launcher
// (`rust/thixotrope-ironhorse-wasm-launcher`) takes the shared lease and
// execs Node on this file as
//
//   shell.mjs --lease-fd=N heap.sqlite PROFILE LEASE LIMITS_JSON [boot.js ...]
//
// It runs outside SES and imports only Node builtins and `./host-abi.mjs`;
// the module and that file are its siblings wherever it is installed (the
// staged directory, or a state directory's private runtime copy), under the
// names the launcher checks for.
//
// What a host can observe matches the native worker: the ready line, reply
// and fatal lines on fd 1 exactly as the core wrote them, nothing else on
// fd 1, exit 0 after a clean close and exit 1 with one `worker failed: ...`
// line on stderr otherwise. The heap is one SQLite file in rollback-journal
// mode, written only inside the host transactions the module's ABI
// prescribes (see the crate documentation of `rust/thixotrope-ironhorse-wasm`).
import { getRandomValues } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  STATUS,
  commits,
  makeExports,
  makeHostImports,
  makeWasiImports,
} from './host-abi.mjs';

/** @import { DatabaseSync, StatementSync } from 'node:sqlite' */
/** @import { Column, Param } from './host-abi.mjs' */

/**
 * The oldest Node this shell runs on. `node:sqlite` loads without a flag
 * from 22.13.0, and `StatementSync#setReturnArrays`, which the row encoding
 * reads, exists from 22.16.0 (both from Node's changelog). The module's
 * exception handling uses the standard exnref encoding; Node 22.16.0 and
 * every later 22.x release carry the same V8 (12.4.254.21), which accepts
 * that encoding without a flag. Node 23 is refused by the feature check
 * below rather than by number where it lacks `setReturnArrays`.
 */
export const MIN_NODE_VERSION = '22.16.0';

/**
 * Why this Node cannot run the shell, or `undefined` if it can.
 *
 * @param {string} version as `process.version` spells it, `v` included
 */
export const nodeVersionProblem = version => {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) return `unrecognized Node version ${JSON.stringify(version)}`;
  const found = match.slice(1, 4).map(Number);
  const wanted = MIN_NODE_VERSION.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    if (found[i] > wanted[i]) return undefined;
    if (found[i] < wanted[i]) {
      return `Node ${version} is too old for the wasm Ironhorse worker, which needs Node ${MIN_NODE_VERSION} or later (node:sqlite with StatementSync#setReturnArrays, and WebAssembly exception handling without a flag); set THIXOTROPE_NODE to a newer node`;
    }
  }
  return undefined;
};

const encoder = new TextEncoder();
const strictDecoder = new TextDecoder('utf-8', { fatal: true });

/** The module beside this file, under the name the launcher checks for. */
export const MODULE_URL = new URL(
  './thixotrope_ironhorse_wasm.wasm',
  import.meta.url,
);

/** The SQLite file header every database starts with. */
const SQLITE_MAGIC = 'SQLite format 3\0';
/** What `ironhorse-store-do` writes under store 0, key `stamp`. */
const STAMP = 'IRON';

const sleepCell = { cell: /** @type {Int32Array | undefined} */ (undefined) };
/**
 * Block the thread for `ms` milliseconds without using the CPU.
 *
 * @param {number} ms
 */
const sleep = ms => {
  if (sleepCell.cell === undefined) {
    sleepCell.cell = new Int32Array(new SharedArrayBuffer(4));
  }
  Atomics.wait(sleepCell.cell, 0, 0, ms);
};

/** @param {unknown} error */
const codeOf = error =>
  /** @type {NodeJS.ErrnoException} */ (error)?.code ?? undefined;

/**
 * Write every byte to a descriptor, in order, whether it is blocking or
 * not. A full non-blocking pipe answers `EAGAIN`; the writer then sleeps
 * (backing off to 50 ms) instead of spinning, and resumes where the last
 * partial write stopped.
 *
 * @param {number} fd
 * @param {Uint8Array} bytes
 */
export const writeAll = (fd, bytes) => {
  let at = 0;
  let wait = 1;
  while (at < bytes.length) {
    try {
      at += writeSync(fd, bytes, at, bytes.length - at);
      wait = 1;
    } catch (error) {
      const code = codeOf(error);
      if (code === 'EAGAIN' || code === 'EWOULDBLOCK') {
        sleep(wait);
        wait = Math.min(wait * 2, 50);
      } else if (code !== 'EINTR') {
        throw error;
      }
    }
  }
};

/**
 * A reader of `\n`-terminated lines from a descriptor, as raw bytes: lines
 * may arrive split across reads at any byte (inside a UTF-8 sequence too,
 * since nothing is decoded here), and a last line without a terminator is
 * still a line. As Rust's `BufRead::lines` does for the native worker, a
 * `\r` before the `\n` is dropped with it. Answers `undefined` at end of
 * input. Reads only as far as the next line needs, apart from what one read
 * returns beyond it.
 *
 * @param {number} fd
 */
export const makeLineReader = fd => {
  let buffer = new Uint8Array(64 * 1024);
  let start = 0;
  let end = 0;
  /** Where the search for a terminator resumes: bytes before it hold none. */
  let scanned = 0;
  let eof = false;
  /** @returns {Uint8Array | undefined} */
  const next = () => {
    for (;;) {
      const found = buffer.subarray(scanned, end).indexOf(0x0a);
      if (found >= 0) {
        const at = scanned + found;
        const stop = at > start && buffer[at - 1] === 0x0d ? at - 1 : at;
        const line = buffer.slice(start, stop);
        start = at + 1;
        scanned = start;
        return line;
      }
      scanned = end;
      if (eof) {
        if (start === end) return undefined;
        const line = buffer.slice(start, end);
        start = end;
        scanned = end;
        return line;
      }
      if (start > 0) {
        buffer.copyWithin(0, start, end);
        end -= start;
        scanned -= start;
        start = 0;
      }
      if (end === buffer.length) {
        const grown = new Uint8Array(buffer.length * 2);
        grown.set(buffer.subarray(0, end));
        buffer = grown;
      }
      let wait = 1;
      for (;;) {
        try {
          const n = readSync(fd, buffer, end, buffer.length - end, null);
          if (n === 0) eof = true;
          end += n;
          break;
        } catch (error) {
          const code = codeOf(error);
          if (code === 'EAGAIN' || code === 'EWOULDBLOCK') {
            sleep(wait);
            wait = Math.min(wait * 2, 50);
          } else if (code !== 'EINTR') {
            throw error;
          }
        }
      }
    }
  };
  return Object.freeze({ next });
};

/**
 * One diagnostic line on stderr. A failure to write it is dropped: stderr
 * is not part of the protocol.
 *
 * @param {string} line
 */
const diagnose = line => {
  try {
    writeAll(2, encoder.encode(line.endsWith('\n') ? line : `${line}\n`));
  } catch {
    // Nothing more can be reported.
  }
};

/**
 * Why `path`, an existing file, is not a heap this engine wrote, judged from
 * its first 100 bytes without opening it as a database (so a foreign file
 * is never touched); `undefined` if it may be one. A heap of this engine is
 * an SQLite database in rollback-journal mode; the native worker's is in
 * WAL mode, which the header records in bytes 18 and 19.
 *
 * @param {string} path
 */
export const heapHeaderProblem = path => {
  const header = new Uint8Array(100);
  const fd = openSync(path, 'r');
  let n = 0;
  try {
    while (n < header.length) {
      const read = readSync(fd, header, n, header.length - n, n);
      if (read === 0) break;
      n += read;
    }
  } finally {
    closeSync(fd);
  }
  const magic = new TextDecoder().decode(header.subarray(0, 16));
  if (n < header.length || magic !== SQLITE_MAGIC) {
    return `heap file ${path} is not an SQLite database, so not a heap of the wasm Ironhorse worker; refusing to open it`;
  }
  if (header[18] !== 1 || header[19] !== 1) {
    return `heap file ${path} is an SQLite database in WAL mode, which this engine never writes (a native Ironhorse worker's heap?); refusing to open it`;
  }
  return undefined;
};

/**
 * The statement executor over one open database: statements are prepared
 * once per SQL text, rows come back as arrays, integers as JavaScript
 * numbers (an integer past 2^53 throws instead of rounding), and blobs are
 * bound as the `Uint8Array` copies `host-abi.mjs` makes.
 *
 * @param {DatabaseSync} db
 */
export const makeExecutor = db => {
  /** @type {Map<string, StatementSync>} */
  const statements = new Map();
  /**
   * @param {string} sql
   * @param {Param[]} params
   * @returns {Column[][]}
   */
  const exec = (sql, params) => {
    let statement = statements.get(sql);
    if (statement === undefined) {
      statement = db.prepare(sql);
      statement.setReturnArrays(true);
      statement.setReadBigInts(false);
      statements.set(sql, statement);
    }
    return /** @type {Column[][]} */ (
      /** @type {unknown} */ (statement.all(.../** @type {any[]} */ (params)))
    );
  };
  return exec;
};

/**
 * Open a heap file for this engine: `journal_mode=DELETE`, read back and
 * required, and `synchronous=FULL`. With `own`, the file must already be
 * this engine's: an SQLite database in rollback-journal mode whose
 * `ih_meta` holds the `IRON` stamp. A file that is not is refused before
 * any statement could write to it, and the database is closed again.
 *
 * @param {typeof DatabaseSync} Database
 * @param {string} path
 * @param {{ own?: boolean }} [options]
 */
export const openHeapDatabase = (Database, path, { own = false } = {}) => {
  if (own) {
    const problem = heapHeaderProblem(path);
    if (problem) throw Error(problem);
  }
  const db = new Database(path);
  try {
    if (own) {
      const foreign = `heap file ${path} is an SQLite database without the wasm Ironhorse worker's stamp, so not a heap of this engine; refusing to open it`;
      const table = db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ih_meta'",
        )
        .get();
      if (table === undefined) throw Error(foreign);
      let stamp;
      try {
        stamp = db
          .prepare(
            "SELECT value FROM ih_meta WHERE store = 0 AND key = 'stamp'",
          )
          .get()?.value;
      } catch {
        throw Error(foreign);
      }
      if (
        !(stamp instanceof Uint8Array) ||
        new TextDecoder().decode(stamp) !== STAMP
      ) {
        throw Error(foreign);
      }
    }
    const mode = db.prepare('PRAGMA journal_mode=DELETE').get()?.journal_mode;
    if (mode !== 'delete') {
      throw Error(
        `heap file ${path}: journal_mode=DELETE answered ${JSON.stringify(mode)}`,
      );
    }
    db.exec('PRAGMA synchronous=FULL');
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
};

/**
 * Instantiate the module over a statement executor: the `env` imports, the
 * WASI imports, and the export wrapper. Diagnostics from the module go to
 * `log`, never to fd 1.
 *
 * @param {WebAssembly.Module} module
 * @param {{
 *   exec: (sql: string, params: Param[]) => ReadonlyArray<ReadonlyArray<Column>>,
 *   log: (line: string) => void,
 * }} options
 */
export const instantiateModule = async (module, { exec, log }) => {
  /** @type {WebAssembly.Memory | undefined} */
  let memory;
  const getMemory = () => {
    if (memory === undefined) throw Error('the instance has no memory yet');
    return memory;
  };
  /** @param {Uint8Array} bytes */
  const random = bytes => {
    // The module's memory is never shared, so no view is over a
    // SharedArrayBuffer.
    getRandomValues(/** @type {Uint8Array<ArrayBuffer>} */ (bytes));
  };
  /** @param {number} clockId */
  const nowNs = clockId =>
    clockId === 0 ? BigInt(Date.now()) * 1_000_000n : process.hrtime.bigint();
  const instance = await WebAssembly.instantiate(module, {
    env: makeHostImports({ getMemory, exec, random, log }),
    wasi_snapshot_preview1: makeWasiImports({ getMemory, random, nowNs, log }),
  });
  memory = /** @type {WebAssembly.Memory} */ (instance.exports.memory);
  return { instance, exports: makeExports(instance) };
};

/** A failure whose text is the whole `worker failed:` line's. */
class WorkerFailure extends Error {}

/**
 * @param {string[]} argv the arguments after the script
 */
const parseArguments = argv => {
  const usage =
    'usage: thixotrope-ironhorse-wasm-shell.mjs --lease-fd=N heap.sqlite profile lease limits-json [boot.js ...]';
  const [leaseFlag, heap, profile, lease, limits, ...boots] = argv;
  const match = /^--lease-fd=(\d+)$/.exec(leaseFlag ?? '');
  if (!match) throw new WorkerFailure(usage);
  if (heap === undefined) throw new WorkerFailure(usage);
  if (profile === undefined)
    throw new WorkerFailure('runtime profile required');
  if (lease === undefined)
    throw new WorkerFailure('worker lease path required');
  if (limits === undefined) throw new WorkerFailure('worker limits required');
  return { leaseFd: Number(match[1]), heap, profile, lease, limits, boots };
};

/**
 * The descriptor the launcher passed must be open on the lease file. It is
 * never closed: the shared lock on it lasts as long as this process.
 *
 * @param {number} fd
 * @param {string} lease
 */
const assertLease = (fd, lease) => {
  let held;
  try {
    held = fstatSync(fd);
  } catch (error) {
    throw new WorkerFailure(
      `lease descriptor ${fd}: ${/** @type {Error} */ (error).message}`,
    );
  }
  const named = statSync(lease);
  if (held.dev !== named.dev || held.ino !== named.ino) {
    throw new WorkerFailure(`lease descriptor ${fd} is not open on ${lease}`);
  }
};

/**
 * The worker process: open or create the heap, boot or resume, serve
 * request lines until close or end of input. Answers the exit code; every
 * failure has been reported on stderr by then.
 *
 * @param {string[]} argv the arguments after the script
 * @returns {Promise<number>}
 */
export const main = async argv => {
  // The body starts in a turn of its own, whoever calls it.
  await null;
  /** @type {DatabaseSync | undefined} */
  let db;
  let inTransaction = false;
  /** The heap this process created and has not yet committed a boot to. */
  let unbooted = '';
  const rollback = () => {
    if (db && inTransaction) {
      inTransaction = false;
      db.exec('ROLLBACK');
    }
  };
  try {
    const versionProblem = nodeVersionProblem(process.version);
    if (versionProblem) throw new WorkerFailure(versionProblem);
    const { leaseFd, heap, profile, lease, limits, boots } =
      parseArguments(argv);
    assertLease(leaseFd, lease);
    const sqlite = await import('node:sqlite');
    if (typeof sqlite.StatementSync.prototype.setReturnArrays !== 'function') {
      throw new WorkerFailure(
        `Node ${process.version} lacks StatementSync#setReturnArrays; the wasm Ironhorse worker needs Node ${MIN_NODE_VERSION} or later`,
      );
    }
    const module = await WebAssembly.compile(readFileSync(MODULE_URL));

    // As the native worker decides: a heap is fresh when its file does not
    // exist yet.
    const fresh = !existsSync(heap);
    if (fresh) unbooted = heap;
    try {
      db = openHeapDatabase(sqlite.DatabaseSync, heap, { own: !fresh });
    } catch (error) {
      throw new WorkerFailure(/** @type {Error} */ (error).message);
    }
    const open = db;
    const { exports } = await instantiateModule(module, {
      exec: makeExecutor(open),
      log: diagnose,
    });
    const begin = () => {
      open.exec('BEGIN IMMEDIATE');
      inTransaction = true;
    };
    const commit = () => {
      inTransaction = false;
      open.exec('COMMIT');
    };
    /**
     * The message of an answer that permits a commit; any other answer is
     * the worker's failure, and the catch below rolls back. The decision is
     * `host-abi.mjs`'s, as for every call.
     *
     * @param {string} name the export, as `commits` names it
     * @param {{ status: number, message: string }} answer
     */
    const required = (name, answer) => {
      if (!commits(name, answer.status)) {
        throw new WorkerFailure(answer.message);
      }
      return answer.message;
    };

    // A fresh heap is opened, booted and made ready in one transaction, so
    // a boot that fails leaves no heap behind: the next start is fresh
    // again rather than a resume of a machine that never booted.
    begin();
    required('open', exports.open({ fresh, lazy: false, profile, limits }));
    if (fresh) {
      for (const boot of boots) {
        let source;
        try {
          source = readFileSync(boot);
        } catch (error) {
          throw new WorkerFailure(
            `boot file ${boot}: ${/** @type {Error} */ (error).message}`,
          );
        }
        required('boot', exports.boot(boot, source));
      }
    } else {
      commit();
      begin();
    }
    const readyLine = required('ready', exports.ready());
    commit();
    unbooted = '';
    writeAll(1, encoder.encode(readyLine));

    const lines = makeLineReader(0);
    for (;;) {
      const line = lines.next();
      if (line === undefined) break;
      let request;
      try {
        request = strictDecoder.decode(line);
      } catch {
        // The native worker's line reader refuses the same way.
        throw new WorkerFailure('stream did not contain valid UTF-8');
      }
      begin();
      const { status, message } = exports.request(request);
      if (commits('request', status)) {
        // A reply, or close requested, which has none.
        if (status === STATUS.CLOSE) {
          commit();
          break;
        }
        writeAll(1, encoder.encode(message));
        commit();
      } else if (status === STATUS.FATAL) {
        // The fatal line is written, the crank rolled back, and no further
        // export is called: the worker is dead and close would refuse.
        writeAll(1, encoder.encode(message));
        rollback();
        let text = message.trim();
        try {
          text = String(JSON.parse(text).message);
        } catch {
          // The fatal line is the core's JSON; report it whole if not.
        }
        throw new WorkerFailure(text);
      } else {
        // Refused or unwound: no reply, and no further export call.
        throw new WorkerFailure(message);
      }
    }
    begin();
    required('close', exports.close());
    commit();
    db = undefined;
    open.close();
    return 0;
  } catch (error) {
    try {
      rollback();
    } catch {
      // The process is about to exit, which releases the database's lock;
      // an uncommitted transaction never reaches the file.
    }
    try {
      db?.close();
    } catch {
      // As above.
    }
    if (unbooted) {
      rmSync(unbooted, { force: true });
      rmSync(`${unbooted}-journal`, { force: true });
    }
    const text =
      error instanceof WorkerFailure
        ? error.message
        : `${/** @type {Error} */ (error)?.name ?? 'Error'}: ${/** @type {Error} */ (error)?.message ?? String(error)}`;
    diagnose(`worker failed: ${text}`);
    return 1;
  }
};

/** Whether this file is the program Node was started on. */
const isMain = () => {
  const script = process.argv[1];
  if (!script) return false;
  try {
    return (
      realpathSync(script) === realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
};

if (isMain()) {
  // Every write was synchronous, so nothing is left buffered at exit.
  void main(process.argv.slice(2)).then(code => process.exit(code));
}
