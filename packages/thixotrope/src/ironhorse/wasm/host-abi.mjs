// @ts-check
// This module runs outside SES (in the Node shell and in a Durable Object),
// where `harden` does not exist, so its exports are frozen with
// `Object.freeze` instead. It imports nothing and uses no Node global: it is
// copied as a single file beside the module and must also load in workerd.
//
// The JavaScript half of the export ABI of `rust/thixotrope-ironhorse-wasm`
// (its crate documentation is the specification): the value encoding of
// `ironhorse_store_do::wire` from the host's side, the `env` and
// `wasi_snapshot_preview1` import objects, and a marshalling wrapper over
// the raw exports.
//
// Every address or length a wasm `i32` carries arrives in JavaScript as a
// signed number, so each one is read back as unsigned. Linear memory can grow
// during any export, which detaches the previous `memory.buffer`, so no view
// of it is kept across a call: every access re-reads `getMemory().buffer`.

export const ABI_VERSION = 1;

/** The statuses the exports answer; see the crate documentation. */
export const STATUS = Object.freeze({
  OK: 0,
  ERROR: 1,
  /** `ih_request` only: close was requested; there is no message. */
  CLOSE: 1,
  UNWIND: 2,
  /** `ih_request` only: the crank failed; the message is the fatal line. */
  FATAL: 3,
  /** `ih_request` only: refused before anything ran. */
  REFUSED: 4,
});

/** The value tags of the wire encoding. */
export const TAG = Object.freeze({ NULL: 0, NUMBER: 1, BLOB: 2, TEXT: 3 });

/**
 * The WASI functions the module imports, exactly the list `build.py`
 * verifies. The import object holds these and nothing else, so a module
 * that imported any other function would fail to instantiate (a `LinkError`
 * naming it) rather than meet a silent stand-in.
 */
export const WASI_FUNCTIONS = Object.freeze([
  'fd_write',
  'random_get',
  'clock_time_get',
  'environ_get',
  'environ_sizes_get',
  'proc_exit',
]);

/** The most error text a failed statement hands the guest. */
const MAX_ERROR_BYTES = 64 * 1024;

/**
 * A wasm `i32` that carries an address or a length, read as the unsigned
 * value it is.
 *
 * @param {number} n
 */
const u32 = n => (n < 0 ? n + 2 ** 32 : n);

const encoder = new TextEncoder();
const strictDecoder = new TextDecoder('utf-8', { fatal: true });
const lenientDecoder = new TextDecoder('utf-8');

/** @param {unknown} error */
const errorText = error =>
  error instanceof Error ? error.message : String(error);

/**
 * @typedef {null | number | bigint | string | ArrayBuffer | ArrayBufferView} Column
 * A result column as a host's SQL driver returns it.
 */

/**
 * @typedef {null | number | string | unknown} Param
 * A decoded parameter: `null`, a number, a string, or whatever `bindBlob`
 * made of a blob.
 */

/**
 * A growable byte buffer for one encoding.
 */
const makeWriter = () => {
  let bytes = new Uint8Array(256);
  let view = new DataView(bytes.buffer);
  let at = 0;
  /** @param {number} n */
  const need = n => {
    if (at + n <= bytes.length) return;
    let size = bytes.length * 2;
    while (size < at + n) size *= 2;
    const grown = new Uint8Array(size);
    grown.set(bytes.subarray(0, at));
    bytes = grown;
    view = new DataView(bytes.buffer);
  };
  return {
    /** @param {number} n */
    u8: n => {
      need(1);
      bytes[at] = n;
      at += 1;
    },
    /** @param {number} n */
    u32: n => {
      if (!Number.isInteger(n) || n < 0 || n > 0xffff_ffff) {
        throw RangeError(`a length of ${n} does not fit the wire's u32`);
      }
      need(4);
      view.setUint32(at, n, true);
      at += 4;
    },
    /** @param {number} x */
    f64: x => {
      need(8);
      view.setFloat64(at, x, true);
      at += 8;
    },
    /** @param {Uint8Array} b */
    bytes: b => {
      need(b.length);
      bytes.set(b, at);
      at += b.length;
    },
    done: () => bytes.slice(0, at),
  };
};

/**
 * The bytes of a blob column, without copying.
 *
 * @param {ArrayBuffer | ArrayBufferView} value
 */
const blobBytes = value =>
  ArrayBuffer.isView(value)
    ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    : new Uint8Array(value);

/**
 * A statement's rows, encoded for the guest: a u32 row count, then per row a
 * u32 column count and its values. A number must be a safe integer (the
 * store writes no floating point, and a double past 2^53 may already have
 * been rounded); a bigint must be safe too; a blob is an `ArrayBuffer` or any
 * view. Anything else is an error naming the row and column.
 *
 * @param {ReadonlyArray<ReadonlyArray<Column>>} rows
 * @returns {Uint8Array}
 */
export const encodeRows = rows => {
  if (!Array.isArray(rows)) throw TypeError('rows must be an array');
  const out = makeWriter();
  out.u32(rows.length);
  rows.forEach((row, r) => {
    if (!Array.isArray(row)) throw TypeError(`row ${r} is not an array`);
    out.u32(row.length);
    row.forEach((value, c) => {
      const where = `row ${r} column ${c}`;
      if (value === null) {
        out.u8(TAG.NULL);
      } else if (typeof value === 'number') {
        if (!Number.isSafeInteger(value)) {
          throw RangeError(`${where}: ${value} is not a safe integer`);
        }
        out.u8(TAG.NUMBER);
        out.f64(value);
      } else if (typeof value === 'bigint') {
        if (
          value > BigInt(Number.MAX_SAFE_INTEGER) ||
          value < BigInt(Number.MIN_SAFE_INTEGER)
        ) {
          throw RangeError(`${where}: ${value}n is not a safe integer`);
        }
        out.u8(TAG.NUMBER);
        out.f64(Number(value));
      } else if (typeof value === 'string') {
        const bytes = encoder.encode(value);
        out.u8(TAG.TEXT);
        out.u32(bytes.length);
        out.bytes(bytes);
      } else if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
        const bytes = blobBytes(value);
        out.u8(TAG.BLOB);
        out.u32(bytes.length);
        out.bytes(bytes);
      } else {
        const kind = value === undefined ? 'undefined' : typeof value;
        throw TypeError(`${where}: cannot encode a value of type ${kind}`);
      }
    });
  });
  return out.done();
};

/**
 * A fresh copy of a blob parameter's bytes: the default `bindBlob`.
 *
 * @param {Uint8Array} bytes
 */
const copyBlob = bytes => bytes.slice();

/**
 * A statement's parameters, decoded from the guest's encoding: a sequence of
 * values. A number is the f64 the guest sent (always an exact integer); text
 * must be UTF-8; `bindBlob` receives a view of each blob's bytes, valid only
 * during the call, and answers what the host binds (default: a fresh
 * `Uint8Array` copy; a Durable Object wants an `ArrayBuffer`). A malformed
 * encoding throws.
 *
 * @param {Uint8Array} bytes
 * @param {{ bindBlob?: (bytes: Uint8Array) => unknown }} [options]
 * @returns {Param[]}
 */
export const decodeParams = (bytes, { bindBlob = copyBlob } = {}) => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  /** @type {Param[]} */
  const params = [];
  let at = 0;
  /** @param {number} n */
  const take = n => {
    if (at + n > bytes.length) throw RangeError('parameters: truncated');
    const start = at;
    at += n;
    return start;
  };
  while (at < bytes.length) {
    const tag = bytes[take(1)];
    if (tag === TAG.NULL) {
      params.push(null);
    } else if (tag === TAG.NUMBER) {
      params.push(view.getFloat64(take(8), true));
    } else if (tag === TAG.BLOB || tag === TAG.TEXT) {
      const len = view.getUint32(take(4), true);
      const start = take(len);
      const payload = bytes.subarray(start, start + len);
      params.push(
        tag === TAG.BLOB ? bindBlob(payload) : strictDecoder.decode(payload),
      );
    } else {
      throw RangeError(`parameters: unknown value tag ${tag}`);
    }
  }
  return params;
};

/**
 * A view of guest memory, refused rather than clamped when it lies outside.
 *
 * @param {WebAssembly.Memory} memory
 * @param {number} ptr
 * @param {number} len
 */
const region = (memory, ptr, len) => {
  const buffer = memory.buffer;
  if (ptr + len > buffer.byteLength) {
    throw RangeError(`guest region ${ptr}+${len} is outside linear memory`);
  }
  return new Uint8Array(buffer, ptr, len);
};

/**
 * @typedef {object} HostImportOptions
 * @property {() => WebAssembly.Memory} getMemory the instance's memory, read
 *   afresh on every call
 * @property {(sql: string, params: Param[]) => ReadonlyArray<ReadonlyArray<Column>>} exec
 *   runs one statement and answers its rows, or throws
 * @property {(bytes: Uint8Array) => void} random fills the view with
 *   cryptographic randomness
 * @property {(line: string) => void} log takes one diagnostic line
 * @property {(bytes: Uint8Array) => unknown} [bindBlob] see `decodeParams`
 */

/**
 * The `env` import object. A statement that throws (in decoding, in `exec`
 * or in encoding its rows) is answered `-1 - n` with its error text pending,
 * never as a JavaScript exception through the guest's frame. `host_take` and
 * `host_log` swallow their own failures too (a short copy is a failed
 * statement to the guest). `random` alone may throw: the host's randomness
 * failing is a host defect, and the guest cannot continue without tokens, so
 * the exception surfaces from the export call and the host drops the
 * instance.
 *
 * @param {HostImportOptions} options
 */
export const makeHostImports = ({
  getMemory,
  exec,
  random,
  log,
  bindBlob = copyBlob,
}) => {
  /** @type {Uint8Array} */
  let pending = new Uint8Array(0);
  return Object.freeze({
    /**
     * @param {number} sqlPtr
     * @param {number} sqlLen
     * @param {number} paramsPtr
     * @param {number} paramsLen
     */
    host_exec: (sqlPtr, sqlLen, paramsPtr, paramsLen) => {
      try {
        const memory = getMemory();
        const sql = strictDecoder.decode(
          region(memory, u32(sqlPtr), u32(sqlLen)),
        );
        const params = decodeParams(
          region(memory, u32(paramsPtr), u32(paramsLen)),
          { bindBlob },
        );
        const encoded = encodeRows(exec(sql, params));
        if (encoded.length > 0x7fff_ffff) {
          throw RangeError(`a result of ${encoded.length} bytes`);
        }
        pending = encoded;
        return encoded.length;
      } catch (error) {
        let text = encoder.encode(errorText(error));
        if (text.length > MAX_ERROR_BYTES) {
          let cut = MAX_ERROR_BYTES;
          // Cut at a character boundary.
          while (cut > 0 && text[cut] >= 0x80 && text[cut] < 0xc0) cut -= 1;
          text = text.slice(0, cut);
        }
        pending = text;
        return -1 - text.length;
      }
    },
    /**
     * @param {number} dst
     * @param {number} cap
     */
    host_take: (dst, cap) => {
      const taken = pending;
      pending = new Uint8Array(0);
      try {
        const n = Math.min(taken.length, u32(cap));
        region(getMemory(), u32(dst), n).set(taken.subarray(0, n));
        return n;
      } catch {
        return 0;
      }
    },
    /**
     * @param {number} ptr
     * @param {number} len
     */
    host_log: (ptr, len) => {
      try {
        log(lenientDecoder.decode(region(getMemory(), u32(ptr), u32(len))));
      } catch {
        // A diagnostic that cannot be delivered is dropped.
      }
    },
    /**
     * @param {number} dst
     * @param {number} len
     */
    host_random: (dst, len) => {
      // `crypto.getRandomValues` fills at most 65,536 bytes per call.
      const bytes = region(getMemory(), u32(dst), u32(len));
      for (let at = 0; at < bytes.length; at += 65_536) {
        random(bytes.subarray(at, at + 65_536));
      }
    },
  });
};

/** What `proc_exit` throws: the guest asked to end the process. */
export class WasiExit extends Error {
  /** @param {number} code */
  constructor(code) {
    super(`the module called proc_exit(${code})`);
    this.name = 'WasiExit';
    this.code = code;
  }
}
Object.freeze(WasiExit);
Object.freeze(WasiExit.prototype);

const ERRNO_SUCCESS = 0;
const ERRNO_BADF = 8;
const ERRNO_INVAL = 28;
const ERRNO_IO = 29;

/**
 * @typedef {object} WasiImportOptions
 * @property {() => WebAssembly.Memory} getMemory
 * @property {(bytes: Uint8Array) => void} random
 * @property {(clockId: number) => bigint} nowNs nanoseconds on the given
 *   WASI clock (0 realtime, 1 monotonic)
 * @property {(line: string) => void} log takes what the module writes to
 *   fd 1 and fd 2
 */

/**
 * The `wasi_snapshot_preview1` import object: exactly `WASI_FUNCTIONS`.
 * Arguments and the environment are empty; output to fd 1 and 2 goes to
 * `log`, never to the process's own streams; any other fd is `EBADF`.
 *
 * @param {WasiImportOptions} options
 */
export const makeWasiImports = ({ getMemory, random, nowNs, log }) => {
  const view = () => new DataView(getMemory().buffer);
  /**
   * @param {number} ptr
   * @param {number} value
   */
  const setU32 = (ptr, value) => view().setUint32(u32(ptr), value, true);
  return Object.freeze({
    /**
     * @param {number} fd
     * @param {number} iovs
     * @param {number} iovsLen
     * @param {number} nwrittenPtr
     */
    fd_write: (fd, iovs, iovsLen, nwrittenPtr) => {
      if (fd !== 1 && fd !== 2) return ERRNO_BADF;
      try {
        const memory = getMemory();
        const parts = [];
        let written = 0;
        for (let i = 0; i < u32(iovsLen); i += 1) {
          const entry = new DataView(memory.buffer);
          const ptr = entry.getUint32(u32(iovs) + 8 * i, true);
          const len = entry.getUint32(u32(iovs) + 8 * i + 4, true);
          parts.push(region(memory, ptr, len).slice());
          written += len;
        }
        const bytes = new Uint8Array(written);
        let at = 0;
        for (const part of parts) {
          bytes.set(part, at);
          at += part.length;
        }
        setU32(nwrittenPtr, written);
        try {
          log(`fd${fd}: ${lenientDecoder.decode(bytes)}`);
        } catch {
          // A diagnostic that cannot be delivered is dropped.
        }
        return ERRNO_SUCCESS;
      } catch {
        return ERRNO_INVAL;
      }
    },
    /**
     * @param {number} ptr
     * @param {number} len
     */
    random_get: (ptr, len) => {
      try {
        const bytes = region(getMemory(), u32(ptr), u32(len));
        for (let at = 0; at < bytes.length; at += 65_536) {
          random(bytes.subarray(at, at + 65_536));
        }
        return ERRNO_SUCCESS;
      } catch {
        return ERRNO_IO;
      }
    },
    /**
     * @param {number} clockId
     * @param {bigint} _precision
     * @param {number} timePtr
     */
    clock_time_get: (clockId, _precision, timePtr) => {
      try {
        const now = nowNs(clockId);
        view().setBigUint64(u32(timePtr), now, true);
        return ERRNO_SUCCESS;
      } catch {
        return ERRNO_INVAL;
      }
    },
    /**
     * @param {number} countPtr
     * @param {number} sizePtr
     */
    environ_sizes_get: (countPtr, sizePtr) => {
      try {
        setU32(countPtr, 0);
        setU32(sizePtr, 0);
        return ERRNO_SUCCESS;
      } catch {
        return ERRNO_INVAL;
      }
    },
    environ_get: () => ERRNO_SUCCESS,
    /** @param {number} code */
    proc_exit: code => {
      throw new WasiExit(code);
    },
  });
};

/**
 * @typedef {object} Answer
 * @property {number} status one of `STATUS`
 * @property {string} message the pending message, or `''` when the status
 *   has none
 */

/**
 * @typedef {object} OpenOptions
 * @property {boolean} fresh begin an empty store, or resume a stored one
 * @property {boolean} [lazy] resume lazily
 * @property {string} profile the runtime profile
 * @property {string} limits the worker-limits JSON
 */

/**
 * A wrapper over an instance's raw exports: arguments are copied into guest
 * buffers and freed after the call, and the answer is `{ status, message }`.
 * An exception from an export (a trap, or `random` failing) propagates
 * unchanged, without freeing anything: the host must drop the instance.
 *
 * @param {WebAssembly.Instance} instance
 */
export const makeExports = instance => {
  const raw = /** @type {Record<string, any>} */ (instance.exports);
  const memory = /** @type {WebAssembly.Memory} */ (raw.memory);
  const version = u32(raw.ih_abi_version());
  if (version !== ABI_VERSION) {
    throw Error(`the module's ABI is version ${version}, not ${ABI_VERSION}`);
  }

  /**
   * Copy bytes or text into a fresh guest buffer.
   *
   * @param {Uint8Array | string} data
   */
  const put = data => {
    const bytes = typeof data === 'string' ? encoder.encode(data) : data;
    const len = bytes.length;
    const ptr = u32(raw.ih_alloc(len));
    if (ptr === 0) throw RangeError(`ih_alloc(${len}) refused`);
    region(memory, ptr, len).set(bytes);
    let freed = false;
    return Object.freeze({
      ptr,
      len,
      free: () => {
        if (freed) return;
        freed = true;
        raw.ih_free(ptr, len);
      },
    });
  };

  /** The pending message, as text. */
  const takeMessage = () => {
    const len = u32(raw.ih_message_len());
    if (len === 0) return '';
    const ptr = u32(raw.ih_alloc(len));
    if (ptr === 0) throw RangeError(`ih_alloc(${len}) refused`);
    const n = u32(raw.ih_message_copy(ptr, len));
    const text = lenientDecoder.decode(region(memory, ptr, n).slice());
    raw.ih_free(ptr, len);
    return text;
  };

  /**
   * @param {(...args: number[]) => number} call
   * @param {Array<Uint8Array | string>} args
   * @param {(status: number) => boolean} [hasMessage]
   * @returns {Answer}
   */
  const invoke = (call, args, hasMessage = () => true) => {
    const buffers = args.map(put);
    const status = call(...buffers.flatMap(({ ptr, len }) => [ptr, len]));
    for (const buffer of buffers) buffer.free();
    return Object.freeze({
      status,
      message: hasMessage(status) ? takeMessage() : '',
    });
  };

  return Object.freeze({
    memory,
    put,
    takeMessage,
    /** @param {OpenOptions} options */
    open: ({ fresh, lazy = false, profile, limits }) =>
      invoke(
        (...ptrs) => raw.ih_open(fresh ? 1 : 0, lazy ? 1 : 0, ...ptrs),
        [profile, limits],
      ),
    /**
     * @param {string} name
     * @param {string | Uint8Array} source
     */
    boot: (name, source) => invoke(raw.ih_boot, [name, source]),
    ready: () => invoke(raw.ih_ready, []),
    /** @param {string} line one request, without its line terminator */
    request: line =>
      invoke(raw.ih_request, [line], status => status !== STATUS.CLOSE),
    close: () => invoke(raw.ih_close, []),
  });
};
