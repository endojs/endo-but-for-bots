// @ts-check
import test from '@endo/ses-ava/test.js';

import {
  ABI_VERSION,
  EXPORTS,
  MAX_RESULT_BYTES,
  STATUS,
  TAG,
  WASI_FUNCTIONS,
  WasiExit,
  commits,
  decodeParams,
  encodeRows,
  makeExports,
  makeHostImports,
  makeWasiImports,
} from '../src/ironhorse/wasm/host-abi.mjs';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** @param {number} x */
const f64 = x => {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setFloat64(0, x, true);
  return [...bytes];
};

// The vectors the Rust test `the_encoding_is_the_documented_one` in
// rust/engine/ironhorse-store-do/src/wire.rs pins.
const PARAMS_VECTOR = Uint8Array.from([
  TAG.NULL,
  TAG.NUMBER,
  ...f64(7),
  TAG.BLOB,
  1,
  0,
  0,
  0,
  9,
  TAG.TEXT,
  1,
  0,
  0,
  0,
  'a'.charCodeAt(0),
]);
const ROWS_VECTOR = Uint8Array.from([1, 0, 0, 0, 1, 0, 0, 0, TAG.NULL]);

/**
 * The guest's half, for round trips: decode rows as the Rust side does.
 *
 * @param {Uint8Array} bytes
 */
const decodeRowsForTest = bytes => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 0;
  const u32 = () => {
    const n = view.getUint32(at, true);
    at += 4;
    return n;
  };
  const rows = [];
  for (let r = u32(); r > 0; r -= 1) {
    const row = [];
    for (let c = u32(); c > 0; c -= 1) {
      const tag = bytes[at];
      at += 1;
      if (tag === TAG.NULL) row.push(null);
      else if (tag === TAG.NUMBER) {
        row.push(view.getFloat64(at, true));
        at += 8;
      } else {
        const len = u32();
        const payload = bytes.slice(at, at + len);
        at += len;
        row.push(tag === TAG.BLOB ? [...payload] : decoder.decode(payload));
      }
    }
    rows.push(row);
  }
  if (at !== bytes.length) throw Error('trailing bytes');
  return rows;
};

/**
 * The guest's half, for round trips: encode parameters as the Rust side
 * does.
 *
 * @param {Array<null | number | string | Uint8Array>} params
 */
const encodeParamsForTest = params => {
  const out = [];
  for (const value of params) {
    if (value === null) out.push(TAG.NULL);
    else if (typeof value === 'number') out.push(TAG.NUMBER, ...f64(value));
    else {
      const bytes = typeof value === 'string' ? encoder.encode(value) : value;
      const len = new Uint8Array(4);
      new DataView(len.buffer).setUint32(0, bytes.length, true);
      out.push(
        typeof value === 'string' ? TAG.TEXT : TAG.BLOB,
        ...len,
        ...bytes,
      );
    }
  }
  return Uint8Array.from(out);
};

test('the wire encoding is the one the Rust side pins', t => {
  t.deepEqual(decodeParams(PARAMS_VECTOR), [null, 7, Uint8Array.of(9), 'a']);
  t.deepEqual(encodeRows([[null]]), ROWS_VECTOR);
  t.deepEqual(
    [...encodeRows([[null, 7, Uint8Array.of(9), 'a']])],
    [1, 0, 0, 0, 4, 0, 0, 0, ...PARAMS_VECTOR],
  );
  t.deepEqual(encodeRows([]), Uint8Array.of(0, 0, 0, 0));
  t.deepEqual(decodeParams(new Uint8Array(0)), []);
});

test('rows and parameters round trip', t => {
  const rows = [
    [null, 0, -1, 0xffff_ffff, Number.MAX_SAFE_INTEGER, -(2 ** 53) + 1],
    [],
    [new Uint8Array(0), Uint8Array.of(0, 1, 2, 255), '', 'é\u{1F600}'],
    [3n, -(2n ** 53n) + 1n],
  ];
  t.deepEqual(decodeRowsForTest(encodeRows(rows)), [
    rows[0],
    [],
    [[], [0, 1, 2, 255], '', 'é\u{1F600}'],
    [3, -(2 ** 53) + 1],
  ]);
  const params = [null, 0, 2 ** 60, 'é', Uint8Array.of(1, 2)];
  t.deepEqual(decodeParams(encodeParamsForTest(params)), params);
});

test('blobs are accepted as an ArrayBuffer or any view', t => {
  const backing = Uint8Array.of(9, 1, 2, 3, 9);
  const expected = decodeRowsForTest(encodeRows([[Uint8Array.of(1, 2, 3)]]));
  for (const blob of [
    Uint8Array.of(1, 2, 3).buffer,
    new Uint8Array(backing.buffer, 1, 3),
    new DataView(backing.buffer, 1, 3),
  ]) {
    t.deepEqual(decodeRowsForTest(encodeRows([[blob]])), expected);
  }
  const int16 = new Int16Array([0x0201]);
  t.deepEqual(decodeRowsForTest(encodeRows([[int16]])), [[[1, 2]]]);
});

test('bindBlob chooses what a blob parameter becomes', t => {
  const [blob] = decodeParams(encodeParamsForTest([Uint8Array.of(4, 5)]), {
    bindBlob: bytes => bytes.slice().buffer,
  });
  t.true(blob instanceof ArrayBuffer);
  t.deepEqual([...new Uint8Array(/** @type {ArrayBuffer} */ (blob))], [4, 5]);
  // The default is a copy, not a view of the encoding.
  const encoded = encodeParamsForTest([Uint8Array.of(6)]);
  const [copy] = decodeParams(encoded);
  encoded[5] = 0;
  t.deepEqual(copy, Uint8Array.of(6));
});

test('result columns outside the domain are refused, naming the column', t => {
  for (const [value, message] of /** @type {const} */ ([
    [0.5, /^row 1 column 2: 0\.5 is not a safe integer$/],
    [NaN, /^row 1 column 2: NaN is not a safe integer$/],
    [Infinity, /is not a safe integer/],
    [2 ** 53, /^row 1 column 2: 9007199254740992 is not a safe integer$/],
    [2n ** 53n, /^row 1 column 2: 9007199254740992n is not a safe integer$/],
    [-(2n ** 53n), /is not a safe integer/],
    [undefined, /^row 1 column 2: cannot encode a value of type undefined$/],
    [{}, /^row 1 column 2: cannot encode a value of type object$/],
    [[1], /cannot encode a value of type object/],
    [true, /cannot encode a value of type boolean/],
    [Symbol('s'), /cannot encode a value of type symbol/],
  ])) {
    const rows = /** @type {any} */ ([[], [null, 1, value]]);
    t.throws(() => encodeRows(rows), { message }, String(message));
  }
  t.throws(() => encodeRows(/** @type {any} */ ([[], 'x'])), {
    message: /^row 1 is not an array$/,
  });
  t.throws(() => encodeRows(/** @type {any} */ ('x')), {
    message: /^rows must be an array$/,
  });
});

test('malformed parameters are refused', t => {
  t.throws(() => decodeParams(Uint8Array.of(TAG.NUMBER, 0, 0)), {
    message: /^parameters: truncated$/,
  });
  t.throws(() => decodeParams(Uint8Array.of(TAG.BLOB, 9, 0, 0, 0, 1)), {
    message: /^parameters: truncated$/,
  });
  t.throws(() => decodeParams(Uint8Array.of(4)), {
    message: /^parameters: unknown value tag 4$/,
  });
  t.throws(() => decodeParams(Uint8Array.of(TAG.TEXT, 1, 0, 0, 0, 0xff)), {
    instanceOf: TypeError,
  });
});

/**
 * Guest memory with a bump allocator, as an instance would have.
 */
const makeFakeGuest = () => {
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 8 });
  let next = 16;
  /** @param {number} len */
  const alloc = len => {
    const ptr = next;
    next += len + 1;
    return ptr;
  };
  /** @param {Uint8Array} bytes */
  const write = bytes => {
    const ptr = alloc(bytes.length);
    new Uint8Array(memory.buffer, ptr, bytes.length).set(bytes);
    return ptr;
  };
  return { memory, alloc, write };
};

test('host_exec answers rows through host_take, re-reading memory after growth', t => {
  const guest = makeFakeGuest();
  /** @type {Array<[string, unknown[]]>} */
  const seen = [];
  const imports = makeHostImports({
    getMemory: () => guest.memory,
    exec: (sql, params) => {
      seen.push([sql, params]);
      // A host call may not grow the guest's memory, but an export between
      // two imports may; the shim must not have kept the old buffer.
      guest.memory.grow(1);
      return [[1, 'two', Uint8Array.of(3)]];
    },
    random: () => {},
    log: () => {},
  });
  const sql = encoder.encode('SELECT ?1');
  const params = encodeParamsForTest([5, 'x']);
  const status = imports.host_exec(
    guest.write(sql),
    sql.length,
    guest.write(params),
    params.length,
  );
  t.deepEqual(seen, [['SELECT ?1', [5, 'x']]]);
  t.is(status, encodeRows([[1, 'two', Uint8Array.of(3)]]).length);
  guest.memory.grow(1);
  // A destination in the newest page, past the size of every earlier buffer.
  const dst = 2 * 65_536 + 100;
  t.is(imports.host_take(dst, status), status);
  t.deepEqual(
    decodeRowsForTest(new Uint8Array(guest.memory.buffer, dst, status).slice()),
    [[1, 'two', [3]]],
  );
  // What was pending is cleared by the take.
  t.is(imports.host_take(dst, 100), 0);
});

test('a throwing exec is answered with a negative code and pending text', t => {
  const guest = makeFakeGuest();
  const imports = makeHostImports({
    getMemory: () => guest.memory,
    exec: () => {
      throw Error('SQLITE_FULL: é');
    },
    random: () => {},
    log: () => {},
  });
  const sql = encoder.encode('INSERT');
  const code = imports.host_exec(guest.write(sql), sql.length, 0, 0);
  const text = encoder.encode('SQLITE_FULL: é');
  t.is(code, -1 - text.length);
  const dst = guest.alloc(text.length);
  t.is(imports.host_take(dst, text.length), text.length);
  t.is(
    decoder.decode(new Uint8Array(guest.memory.buffer, dst, text.length)),
    'SQLITE_FULL: é',
  );
});

test('every failure inside host_exec becomes a code, never an exception', t => {
  const guest = makeFakeGuest();
  /** @type {() => unknown} */
  let answer = () => [];
  const imports = makeHostImports({
    getMemory: () => guest.memory,
    exec: () => /** @type {any} */ (answer()),
    random: () => {},
    log: () => {},
  });
  const sql = encoder.encode('SELECT');
  const sqlPtr = guest.write(sql);
  /** @param {number} code */
  const pendingText = code => {
    const len = -1 - code;
    const dst = guest.alloc(len);
    imports.host_take(dst, len);
    return decoder.decode(new Uint8Array(guest.memory.buffer, dst, len));
  };
  // A column the wire cannot carry.
  answer = () => [[0.25]];
  let code = imports.host_exec(sqlPtr, sql.length, 0, 0);
  t.is(pendingText(code), 'row 0 column 0: 0.25 is not a safe integer');
  // Malformed parameters.
  const bad = guest.write(Uint8Array.of(7));
  code = imports.host_exec(sqlPtr, sql.length, bad, 1);
  t.is(pendingText(code), 'parameters: unknown value tag 7');
  // A region outside memory, and an address past 2^31 (a negative i32).
  code = imports.host_exec(-16, 4, 0, 0);
  t.regex(pendingText(code), /outside linear memory/);
  // A thrown non-Error.
  answer = () => {
    // eslint-disable-next-line no-throw-literal
    throw 'plain';
  };
  t.is(pendingText(imports.host_exec(sqlPtr, sql.length, 0, 0)), 'plain');
  // A very long text is cut to 64 KiB at a character boundary.
  guest.memory.grow(2);
  answer = () => {
    throw Error('é'.repeat(40_000));
  };
  code = imports.host_exec(sqlPtr, sql.length, 0, 0);
  t.is(-1 - code, 65_536);
  t.is(pendingText(code), 'é'.repeat(32_768));
  // host_take into memory it cannot reach copies nothing rather than throw.
  answer = () => [[1]];
  code = imports.host_exec(sqlPtr, sql.length, 0, 0);
  t.true(code > 0);
  t.is(imports.host_take(guest.memory.buffer.byteLength - 2, code), 0);
});

test('host_log and host_random', t => {
  const guest = makeFakeGuest();
  /** @type {string[]} */
  const lines = [];
  /** @type {number[]} */
  const fills = [];
  const imports = makeHostImports({
    getMemory: () => guest.memory,
    exec: () => [],
    random: bytes => {
      fills.push(bytes.length);
      bytes.fill(7);
    },
    log: line => {
      lines.push(line);
      if (line === 'boom') throw Error('the log is gone');
    },
  });
  const line = encoder.encode('panic: é');
  imports.host_log(guest.write(line), line.length);
  const boom = encoder.encode('boom');
  imports.host_log(guest.write(boom), boom.length);
  t.deepEqual(lines, ['panic: é', 'boom']);
  guest.memory.grow(1);
  const dst = guest.alloc(70_000);
  t.is(imports.host_random(dst, 70_000), 0);
  t.deepEqual(fills, [65_536, 70_000 - 65_536]);
  t.true(new Uint8Array(guest.memory.buffer, dst, 70_000).every(b => b === 7));
});

test('the WASI imports are exactly the checked-in list', t => {
  const guest = makeFakeGuest();
  /** @type {string[]} */
  const lines = [];
  const wasi = makeWasiImports({
    getMemory: () => guest.memory,
    random: bytes => bytes.fill(1),
    nowNs: id => BigInt(id) * 1000n + 5n,
    log: line => lines.push(line),
  });
  t.deepEqual(Object.keys(wasi).sort(), [...WASI_FUNCTIONS].sort());
  t.true(Object.isFrozen(wasi));

  const view = () => new DataView(guest.memory.buffer);
  const text = encoder.encode('thread panicked');
  const textPtr = guest.write(text);
  const iovs = guest.alloc(16);
  view().setUint32(iovs, textPtr, true);
  view().setUint32(iovs + 4, 6, true);
  view().setUint32(iovs + 8, textPtr + 6, true);
  view().setUint32(iovs + 12, text.length - 6, true);
  const nwritten = guest.alloc(4);
  t.is(wasi.fd_write(2, iovs, 2, nwritten), 0);
  t.is(view().getUint32(nwritten, true), text.length);
  t.deepEqual(lines, ['fd2: thread panicked']);
  t.is(wasi.fd_write(3, iovs, 2, nwritten), 8);
  t.is(wasi.fd_write(1, iovs, 0, nwritten), 0);

  const out = guest.alloc(8);
  t.is(wasi.clock_time_get(1, 0n, out), 0);
  t.is(view().getBigUint64(out, true), 1005n);
  const sizes = guest.alloc(8);
  view().setUint32(sizes, 9, true);
  view().setUint32(sizes + 4, 9, true);
  t.is(wasi.environ_sizes_get(sizes, sizes + 4), 0);
  t.is(view().getUint32(sizes, true), 0);
  t.is(view().getUint32(sizes + 4, true), 0);
  t.is(wasi.environ_get(), 0);
  const random = guest.alloc(4);
  t.is(wasi.random_get(random, 4), 0);
  t.deepEqual(
    [...new Uint8Array(guest.memory.buffer, random, 4)],
    [1, 1, 1, 1],
  );
  t.is(wasi.random_get(guest.memory.buffer.byteLength, 4), 29);
  const error = t.throws(() => wasi.proc_exit(3), { instanceOf: WasiExit });
  t.is(/** @type {WasiExit} */ (error).code, 3);
});

/**
 * A fake instance over a JS bump allocator, recording what it was called
 * with.
 *
 * @param {{ version?: number, status?: number, message?: string }} [options]
 */
const makeFakeInstance = ({ version = 1, status = 0, message = 'm' } = {}) => {
  const guest = makeFakeGuest();
  /** @type {unknown[][]} */
  const calls = [];
  /** @type {Array<[number, number]>} */
  const freed = [];
  /** Live guest allocations, by address, with their lengths. */
  const live = new Map();
  /**
   * @param {number} ptr
   * @param {number} len
   */
  const read = (ptr, len) =>
    decoder.decode(new Uint8Array(guest.memory.buffer, ptr, len));
  const bytes = encoder.encode(message);
  /** @param {string} name */
  const answering =
    name =>
    /** @param {number[]} args */
    (...args) => {
      const strings = [];
      for (let i = name === 'ih_open' ? 2 : 0; i < args.length; i += 2) {
        strings.push(read(args[i], args[i + 1]));
      }
      calls.push([
        name,
        ...args.slice(0, name === 'ih_open' ? 2 : 0),
        ...strings,
      ]);
      return status;
    };
  const exports = {
    memory: guest.memory,
    ih_abi_version: () => version,
    /** @param {number} len */
    ih_alloc: len => {
      const ptr = guest.alloc(len);
      live.set(ptr, len);
      return ptr;
    },
    /**
     * @param {number} ptr
     * @param {number} len
     */
    ih_free: (ptr, len) => {
      if (live.get(ptr) !== len) throw Error(`bad free ${ptr} ${len}`);
      live.delete(ptr);
      freed.push([ptr, len]);
    },
    ih_message_len: () => bytes.length,
    /**
     * @param {number} dst
     * @param {number} cap
     */
    ih_message_copy: (dst, cap) => {
      const n = Math.min(cap, bytes.length);
      new Uint8Array(guest.memory.buffer, dst, n).set(bytes.subarray(0, n));
      return n;
    },
    ih_open: answering('ih_open'),
    ih_boot: answering('ih_boot'),
    ih_ready: answering('ih_ready'),
    ih_request: answering('ih_request'),
    ih_close: answering('ih_close'),
  };
  const instance = /** @type {WebAssembly.Instance} */ (
    /** @type {unknown} */ ({ exports })
  );
  return { instance, calls, freed, live };
};

test('makeExports marshals arguments, frees them and reads the message', t => {
  const { instance, calls, freed } = makeFakeInstance({ message: 'é line\n' });
  const exports = makeExports(instance);
  t.deepEqual(exports.open({ fresh: true, profile: 'p', limits: '{}' }), {
    status: STATUS.OK,
    message: 'é line\n',
  });
  t.deepEqual(exports.boot('boot.js', '1;'), {
    status: STATUS.OK,
    message: 'é line\n',
  });
  exports.ready();
  exports.request('{"source":"1"}');
  exports.close();
  t.deepEqual(calls, [
    ['ih_open', 1, 0, 'p', '{}'],
    ['ih_boot', 'boot.js', '1;'],
    ['ih_ready'],
    ['ih_request', '{"source":"1"}'],
    ['ih_close'],
  ]);
  // Two arguments each for open and boot, one for the request, then the
  // message buffers.
  t.is(
    freed.filter(([, len]) => len !== encoder.encode('é line\n').length).length,
    5,
  );
  const buffer = exports.put('abc');
  t.is(buffer.len, 3);
  buffer.free();
  buffer.free();
  t.is(freed.filter(([ptr]) => ptr === buffer.ptr).length, 1);
  t.is(exports.takeMessage(), 'é line\n');
});

test('a close request has no message; other statuses do', t => {
  const closing = makeExports(
    makeFakeInstance({ status: STATUS.CLOSE }).instance,
  );
  t.deepEqual(closing.request('{"op":"close"}'), {
    status: STATUS.CLOSE,
    message: '',
  });
  // Only a request's CLOSE has no message.
  t.deepEqual(closing.boot('b', ''), { status: STATUS.CLOSE, message: 'm' });
  const failing = makeExports(
    makeFakeInstance({ status: STATUS.ERROR }).instance,
  );
  t.deepEqual(failing.request('{}'), { status: STATUS.ERROR, message: 'm' });
  const fatal = makeExports(
    makeFakeInstance({ status: STATUS.FATAL }).instance,
  );
  t.deepEqual(fatal.request('{}'), { status: STATUS.FATAL, message: 'm' });
  const empty = makeExports(
    makeFakeInstance({ status: STATUS.OK, message: '' }).instance,
  );
  t.deepEqual(empty.close(), { status: STATUS.OK, message: '' });
});

test('makeExports refuses another ABI version', t => {
  t.is(ABI_VERSION, 1);
  t.throws(() => makeExports(makeFakeInstance({ version: 2 }).instance), {
    message: /^the module's ABI is version 2, not 1$/,
  });
});

test('one rule decides every commit', t => {
  t.deepEqual(EXPORTS, ['open', 'boot', 'ready', 'request', 'close']);
  t.is(STATUS.CLOSE, 5);
  t.not(STATUS.CLOSE, STATUS.ERROR);
  const statuses = [-1, 0, 1, 2, 3, 4, 5, 6];
  for (const name of EXPORTS) {
    for (const status of statuses) {
      const expected =
        status === STATUS.OK || (name === 'request' && status === STATUS.CLOSE);
      t.is(commits(name, status), expected, `${name} answering ${status}`);
    }
  }
  // A failed close never commits.
  t.false(commits('close', STATUS.ERROR));
  t.throws(() => commits('ih_close', 0), { message: /^no export ih_close/ });
});

test('guest allocations balance after every call', t => {
  const { instance, live } = makeFakeInstance({ message: 'reply\n' });
  const exports = makeExports(instance);
  for (let i = 0; i < 10; i += 1) {
    exports.open({ fresh: i % 2 === 0, profile: 'p', limits: '{}' });
    exports.boot('boot.js', 'source');
    exports.ready();
    exports.request('{"source":"1"}');
    exports.close();
    t.is(exports.takeMessage(), 'reply\n');
  }
  t.is(live.size, 0);
});

test('a throwing random is a non-zero answer, never an exception', t => {
  const guest = makeFakeGuest();
  let fail = true;
  const imports = makeHostImports({
    getMemory: () => guest.memory,
    exec: () => [],
    random: bytes => {
      if (fail) throw Error('no entropy');
      bytes.fill(3);
    },
    log: () => {},
  });
  const dst = guest.alloc(16);
  t.is(imports.host_random(dst, 16), 1);
  fail = false;
  t.is(imports.host_random(dst, 16), 0);
  t.true(new Uint8Array(guest.memory.buffer, dst, 16).every(b => b === 3));
  // A region outside memory fails the same way.
  t.is(imports.host_random(guest.memory.buffer.byteLength - 4, 16), 1);
});

test('the text of any thrown value is read without throwing', t => {
  const guest = makeFakeGuest();
  /** @type {() => unknown} */
  let thrown = () => null;
  const imports = makeHostImports({
    getMemory: () => guest.memory,
    exec: () => {
      throw thrown();
    },
    random: () => {},
    log: () => {},
  });
  /** @param {number} code */
  const pendingText = code => {
    const len = -1 - code;
    const dst = guest.alloc(len);
    imports.host_take(dst, len);
    return decoder.decode(new Uint8Array(guest.memory.buffer, dst, len));
  };
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  const unreadable = 'a host error whose text cannot be read';
  for (const [value, text] of /** @type {Array<[() => unknown, string]>} */ ([
    [() => Object.create(null), unreadable],
    [() => Symbol('sym'), 'Symbol(sym)'],
    [() => proxy, unreadable],
    [
      () =>
        Object.create(Error.prototype, {
          message: {
            get() {
              throw Error('getter');
            },
          },
        }),
      unreadable,
    ],
    [
      () => ({
        toString() {
          throw Error('toString');
        },
      }),
      unreadable,
    ],
  ])) {
    thrown = value;
    let code = 0;
    t.notThrows(() => {
      code = imports.host_exec(0, 0, 0, 0);
    });
    t.true(code < 0);
    t.is(pendingText(code), text);
  }
});

test('sparse rows are refused, not misframed', t => {
  // eslint-disable-next-line no-sparse-arrays
  const holed = [[1, , 3], [2]];
  t.throws(() => encodeRows(/** @type {any} */ (holed)), {
    message: /^row 0 column 1: cannot encode a value of type undefined$/,
  });
  // eslint-disable-next-line no-sparse-arrays
  const trailing = [[1, ,], [2]];
  t.is(trailing[0].length, 2);
  t.throws(() => encodeRows(/** @type {any} */ (trailing)), {
    message: /^row 0 column 1: cannot encode/,
  });
  // eslint-disable-next-line no-sparse-arrays
  const outer = [[1], , [2]];
  t.throws(() => encodeRows(/** @type {any} */ (outer)), {
    message: /^row 1 is not an array$/,
  });
});

test('long error text is cut inside no character', t => {
  const guest = makeFakeGuest();
  guest.memory.grow(2);
  /** @type {string} */
  let text = '';
  const imports = makeHostImports({
    getMemory: () => guest.memory,
    exec: () => {
      throw Error(text);
    },
    random: () => {},
    log: () => {},
  });
  // A cut at 65,536 bytes lands on the third byte of a three-byte
  // character, and on the fourth of a four-byte one.
  for (const [prefix, char, keep] of /** @type {const} */ ([
    ['aa', '€', 21_844],
    ['a', '\u{1F600}', 16_383],
  ])) {
    text = prefix + char.repeat(30_000);
    const code = imports.host_exec(0, 0, 0, 0);
    const expected = prefix + char.repeat(keep);
    const bytes = encoder.encode(expected).length;
    t.true(bytes < 65_536 && bytes > 65_536 - 4);
    t.is(-1 - code, bytes);
    const dst = guest.alloc(bytes);
    t.is(imports.host_take(dst, bytes), bytes);
    t.is(
      new TextDecoder('utf-8', { fatal: true }).decode(
        new Uint8Array(guest.memory.buffer, dst, bytes),
      ),
      expected,
    );
  }
});

test('a result longer than the cap is a failed statement', t => {
  t.is(MAX_RESULT_BYTES, 2 ** 31 - 1);
  const guest = makeFakeGuest();
  const rows = [[Uint8Array.of(1, 2, 3)]];
  const length = encodeRows(rows).length;
  const at = (/** @type {number} */ maxResultBytes) =>
    makeHostImports({
      getMemory: () => guest.memory,
      exec: () => rows,
      random: () => {},
      log: () => {},
      maxResultBytes,
    }).host_exec(0, 0, 0, 0);
  t.is(at(length), length);
  t.true(at(length - 1) < 0);
  for (const bad of [-1, 1.5, 2 ** 31]) {
    t.throws(() => at(bad), { message: /^maxResultBytes must be/ });
  }
});
