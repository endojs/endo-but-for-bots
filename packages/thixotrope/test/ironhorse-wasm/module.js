// @ts-check
// The wasm Ironhorse worker module under Node, over real SQLite, against the
// native worker where they should agree byte for byte. Needs the built module
// (`python3 rust/thixotrope-ironhorse-wasm/build.py`), the boot bundles
// (`yarn build:ironhorse-bundles`) and, for the comparisons, the native
// worker (`cargo build --locked --release -p thixotrope-ironhorse-worker`).
import test from 'ava';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import { STATUS } from '../../src/ironhorse/wasm/host-abi.mjs';
import {
  MODULE_PATH,
  compileModule,
  instantiateWorker,
  openDatabase,
} from './_sqlite-host.js';

/** @import { ExecutionContext } from 'ava' */

const NATIVE_WORKER =
  process.env.THIXOTROPE_IRONHORSE_WORKER ||
  fileURLToPath(
    new URL(
      '../../../../target/release/thixotrope-ironhorse-worker',
      import.meta.url,
    ),
  );
const BOOT_NAMES = ['boot.js', 'worker-peer.js'];
const BOOT_PATHS = BOOT_NAMES.map(name =>
  fileURLToPath(new URL(`../../dist-ironhorse/${name}`, import.meta.url)),
);
// The host's default limits (makeIronhorseLimits), as the engine passes them.
const LIMITS = JSON.stringify({
  crankBudget: '10000000',
  bootstrapBudget: '1000000000',
  slotCeiling: 1_000_000,
  chunkCeiling: 268_435_456,
  requestTimeoutMs: 60_000,
});
const PROFILE = 'thixotrope-wasm-module-test';
const READY = '{"features":["deliver-v1"],"op":"ready"}\n';

/** @param {unknown} value */
const result = value => `${JSON.stringify({ op: 'result', result: value })}\n`;
/** @param {Record<string, unknown>} request */
const line = request => JSON.stringify(request);

const module = await compileModule(MODULE_PATH);
const bootSources = await Promise.all(
  BOOT_PATHS.map(path => readFile(path, 'utf8')),
);
const hasNative = existsSync(NATIVE_WORKER);
const nativeTest = hasNative
  ? test.serial
  : (/** @type {string} */ title, /** @type {any} */ fn) =>
      test.serial.skip(
        `${title} (skipped: no native worker at ${NATIVE_WORKER})`,
        fn,
      );

/** @param {ExecutionContext} t */
const tempDir = async t => {
  const dir = await mkdtemp(join(tmpdir(), 'thix-wasm-module-'));
  t.teardown(() => rm(dir, { recursive: true, force: true }));
  return dir;
};

/**
 * A database and a new instance over it, both closed at teardown.
 *
 * @param {ExecutionContext} t
 * @param {string} path
 */
const startWasm = async (t, path) => {
  const database = openDatabase(path);
  let open = true;
  const closeDatabase = () => {
    if (open) {
      open = false;
      database.close();
    }
  };
  t.teardown(closeDatabase);
  const worker = await instantiateWorker(module, database);
  return { database, worker, closeDatabase };
};

/**
 * Open fresh, boot both bundles, and answer ready.
 *
 * @param {ExecutionContext} t
 * @param {Awaited<ReturnType<typeof startWasm>>['worker']} worker
 */
const bootFresh = (t, worker) => {
  /** @type {Record<string, number>} */
  const ms = {};
  let start = performance.now();
  t.deepEqual(worker.open({ fresh: true, profile: PROFILE, limits: LIMITS }), {
    status: STATUS.OK,
    message: '',
  });
  ms.open = performance.now() - start;
  BOOT_NAMES.forEach((name, i) => {
    start = performance.now();
    t.deepEqual(worker.boot(BOOT_PATHS[i], bootSources[i]), {
      status: STATUS.OK,
      message: '',
    });
    ms[name] = performance.now() - start;
  });
  start = performance.now();
  t.deepEqual(worker.ready(), { status: STATUS.OK, message: READY });
  ms.ready = performance.now() - start;
  return ms;
};

/**
 * Resume a stored worker and answer ready.
 *
 * @param {ExecutionContext} t
 * @param {Awaited<ReturnType<typeof startWasm>>['worker']} worker
 * @param {boolean} [lazy]
 */
const resume = (t, worker, lazy = false) => {
  t.deepEqual(
    worker.open({ fresh: false, lazy, profile: PROFILE, limits: LIMITS }),
    { status: STATUS.OK, message: '' },
  );
  t.deepEqual(worker.ready(), { status: STATUS.OK, message: READY });
};

/**
 * The reply lines of a worker that has answered ready, as a native worker
 * would write them: one per request, up to close, a fatal line or a
 * refusal. `ready` is prepended so that the two transcripts compare whole.
 *
 * @param {Awaited<ReturnType<typeof startWasm>>['worker']} worker
 * @param {string[]} requests
 */
const wasmTranscript = (worker, requests) => {
  const lines = [READY];
  for (const request of requests) {
    const { status, message } = worker.request(request);
    if (status === STATUS.CLOSE) {
      return { lines, closed: worker.close() };
    }
    lines.push(message);
    if (status !== STATUS.OK) return { lines, status };
  }
  return { lines };
};

/**
 * Run the native worker over a heap file with these request lines, then
 * end its input.
 *
 * @param {string} dir
 * @param {string} heap
 * @param {string[]} requests
 * @param {string} [profile]
 */
const runNative = (dir, heap, requests, profile = PROFILE) =>
  new Promise((resolve, reject) => {
    const child = spawn(
      NATIVE_WORKER,
      [heap, profile, join(dir, 'lease'), LIMITS, ...BOOT_PATHS],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      stdout += chunk;
    });
    child.stderr.on('data', chunk => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', code => {
      const lines = stdout.split(/(?<=\n)/).filter(text => text !== '');
      resolve({ lines, code, stderr });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(requests.map(request => `${request}\n`).join(''));
  });

/** @typedef {{ lines: string[], code: number | null, stderr: string }} NativeRun */

/**
 * A booted heap, made once per engine and copied for each test that does
 * not measure the boot itself.
 */
let wasmTemplate = '';
let nativeTemplate = '';
test.before(async t => {
  const dir = await mkdtemp(join(tmpdir(), 'thix-wasm-template-'));
  t.context = dir;
  const path = join(dir, 'wasm.sqlite');
  const database = openDatabase(path);
  try {
    const start = performance.now();
    const worker = await instantiateWorker(module, database);
    bootFresh(t, worker);
    t.log(
      `wasm instantiate and boot to ready: ${(performance.now() - start).toFixed(1)} ms`,
    );
    t.deepEqual(worker.close(), { status: STATUS.OK, message: '' });
  } finally {
    database.close();
  }
  wasmTemplate = path;
  if (hasNative) {
    nativeTemplate = join(dir, 'native.sqlite');
    const start = performance.now();
    const run = /** @type {NativeRun} */ (
      await runNative(dir, nativeTemplate, [line({ op: 'close' })])
    );
    t.deepEqual(run, { lines: [READY], code: 0, stderr: '' });
    t.log(
      `native process boot to close: ${(performance.now() - start).toFixed(1)} ms`,
    );
  }
});
test.after.always(t =>
  typeof t.context === 'string'
    ? rm(t.context, { recursive: true, force: true })
    : undefined,
);

/**
 * @param {ExecutionContext} t
 * @param {string} template
 */
const copyOf = async (t, template) => {
  const dir = await tempDir(t);
  const path = join(dir, 'heap.sqlite');
  await copyFile(template, path);
  return { dir, path };
};

/** @param {import('node:sqlite').DatabaseSync} db */
const manifest = db =>
  db
    .prepare("SELECT value FROM ih_meta WHERE store = 1 AND key = 'manifest'")
    .get()?.value;

test.serial('a fresh worker boots the real bundles to ready', async t => {
  t.timeout(300_000);
  const dir = await tempDir(t);
  let start = performance.now();
  const { worker } = await startWasm(t, join(dir, 'heap.sqlite'));
  const instantiate = performance.now() - start;
  const ms = bootFresh(t, worker);
  t.log(
    `instantiate ${instantiate.toFixed(1)} ms; ${Object.entries(ms)
      .map(([name, time]) => `${name} ${time.toFixed(1)} ms`)
      .join('; ')}`,
  );
  t.log(`wasm memory after boot: ${worker.memoryBytes()} bytes`);
  start = performance.now();
  t.deepEqual(worker.close(), { status: STATUS.OK, message: '' });
  t.log(`close ${(performance.now() - start).toFixed(1)} ms`);
  t.deepEqual(worker.logs, []);
});

test.serial(
  'requests: eval, deliver with outbound, malformed, close',
  async t => {
    t.timeout(120_000);
    const { path } = await copyOf(t, wasmTemplate);
    const { worker } = await startWasm(t, path);
    resume(t, worker);
    t.deepEqual(
      worker.request(line({ source: 'globalThis.kept = 41; kept + 1' })),
      {
        status: STATUS.OK,
        message: result('42'),
      },
    );
    const frame = { t: 'f', b64: 'AAEC' };
    t.deepEqual(
      worker.request(
        line({
          op: 'deliver',
          source: `thixotropeSend(${JSON.stringify(JSON.stringify(frame))}); kept`,
          drainBudget: '1000000',
        }),
      ),
      { status: STATUS.OK, message: result(JSON.stringify([frame])) },
    );
    const malformed = worker.request('{"source":');
    t.is(malformed.status, STATUS.OK);
    t.like(JSON.parse(malformed.message), { op: 'error' });
    t.true(malformed.message.endsWith('}\n'));
    t.deepEqual(worker.request(line({ source: 'kept' })), {
      status: STATUS.OK,
      message: result('41'),
    });
    t.deepEqual(worker.request(line({ op: 'close' })), {
      status: STATUS.CLOSE,
      message: '',
    });
    t.deepEqual(worker.close(), { status: STATUS.OK, message: '' });
  },
);

test.serial('state persists across instances, eager and lazy', async t => {
  t.timeout(120_000);
  const { path } = await copyOf(t, wasmTemplate);
  const first = await startWasm(t, path);
  resume(t, first.worker);
  first.worker.request(line({ source: 'globalThis.count = 1; count' }));
  t.is(first.worker.close().status, STATUS.OK);
  first.closeDatabase();

  const eager = await startWasm(t, path);
  resume(t, eager.worker, false);
  t.deepEqual(eager.worker.request(line({ source: 'count += 1' })), {
    status: STATUS.OK,
    message: result('2'),
  });
  t.is(eager.worker.close().status, STATUS.OK);
  eager.closeDatabase();

  const lazy = await startWasm(t, path);
  const before = manifest(lazy.database.db);
  resume(t, lazy.worker, true);
  t.deepEqual(lazy.worker.request(line({ source: 'count += 1' })), {
    status: STATUS.OK,
    message: result('3'),
  });
  t.is(lazy.worker.close().status, STATUS.OK);
  t.notDeepEqual(
    manifest(lazy.database.db),
    before,
    'the lazy crank committed',
  );
  lazy.closeDatabase();

  const after = await startWasm(t, path);
  resume(t, after.worker);
  t.deepEqual(after.worker.request(line({ source: 'count' })), {
    status: STATUS.OK,
    message: result('3'),
  });
});

const AGREEMENT = [
  line({ source: '1 + 1' }),
  line({ source: "'text with \\u00e9 and \\n'" }),
  line({ source: 'null' }),
  line({ source: 'undefined' }),
  line({ source: 'true' }),
  line({ source: '1.5e300' }),
  line({ source: '-0' }),
  line({ source: "[1, 'two', null, { three: 3 }]" }),
  line({ source: '({ nested: { list: [1, 2n] } })' }),
  line({ source: "JSON.stringify({ a: 1, b: [true, null, 'c'] })" }),
  line({
    source: "try { null.x } catch (e) { e.name + ': ' + e.message }",
  }),
  line({
    source:
      "globalThis.order = []; Promise.resolve(1).then(v => order.push(v)); Promise.reject(Error('no')).catch(e => order.push(e.message)); order.push('sync'); 'queued'",
  }),
  line({ source: "order.join(',')" }),
  line({
    op: 'deliver',
    source: 'thixotropeSend(\'{"t":"f","b64":"AA=="}\'); 1',
  }),
  line({
    op: 'deliver',
    source:
      'thixotropeSend(\'{"t":"f","b64":"AQ=="}\'); thixotropeSend(\'{"t":"f","b64":"Ag=="}\')',
    budget: '5000000',
    drainBudget: '5000000',
  }),
  line({ op: 'deliver', source: '2' }),
  line({ source: '1', budget: '0' }),
  line({ source: '1', budget: '-5' }),
  line({ source: '1', budget: 1.5 }),
  line({ op: 'deliver', source: '1', drainBudget: 'x' }),
  line({ source: '1', budget: '18446744073709551616' }),
  '[1, 2]',
  '"just a string"',
  'not json',
  '',
  line({ op: 'unknown', source: "'an unknown op evaluates'" }),
  line({ op: 'frobnicate' }),
  line({ source: 'Object.keys(globalThis).length > 0' }),
  line({ op: 'close' }),
];

nativeTest(
  'every reply agrees byte for byte with the native worker',
  async t => {
    t.timeout(300_000);
    const dir = await tempDir(t);
    const { worker } = await startWasm(t, join(dir, 'wasm.sqlite'));
    bootFresh(t, worker);
    const wasm = wasmTranscript(worker, AGREEMENT);
    t.deepEqual(wasm.closed, { status: STATUS.OK, message: '' });
    const native = /** @type {NativeRun} */ (
      await runNative(dir, join(dir, 'native.sqlite'), AGREEMENT)
    );
    t.is(native.code, 0, native.stderr);
    t.is(wasm.lines.length, AGREEMENT.length);
    t.deepEqual(wasm.lines, native.lines);
  },
);

/**
 * Drive both engines through `first` (committed at close), then `second`
 * on a resumed worker, from their booted templates.
 *
 * @param {ExecutionContext} t
 * @param {string[]} first
 * @param {string[]} second
 */
const bothThroughResume = async (t, first, second) => {
  const wasmCopy = await copyOf(t, wasmTemplate);
  const nativeCopy = await copyOf(t, nativeTemplate);
  const one = await startWasm(t, wasmCopy.path);
  resume(t, one.worker);
  const wasmFirst = wasmTranscript(one.worker, first);
  one.closeDatabase();
  const two = await startWasm(t, wasmCopy.path);
  resume(t, two.worker);
  const wasmSecond = wasmTranscript(two.worker, second);
  const nativeFirst = /** @type {NativeRun} */ (
    await runNative(nativeCopy.dir, nativeCopy.path, first)
  );
  const nativeSecond = /** @type {NativeRun} */ (
    await runNative(nativeCopy.dir, nativeCopy.path, second)
  );
  t.deepEqual(wasmFirst.lines, nativeFirst.lines);
  t.deepEqual(wasmSecond.lines, nativeSecond.lines);
  return { wasm: two, wasmCopy, nativeSecond };
};

nativeTest(
  'a fatal crank answers the native fatal line and commits nothing',
  async t => {
    t.timeout(300_000);
    for (const fatal of [
      line({ source: 'for (;;) {}', budget: '100000' }),
      line({ source: "throw Error('uncaught')" }),
    ]) {
      // eslint-disable-next-line no-await-in-loop
      const { wasm, wasmCopy, nativeSecond } = await bothThroughResume(
        t,
        [line({ source: 'globalThis.x = 1' }), line({ op: 'close' })],
        [line({ source: 'x = 2' }), fatal],
      );
      t.is(nativeSecond.code, 1);
      const { worker, database } = wasm;
      t.regex(
        nativeSecond.lines.at(-1) || '',
        /^\{"message":"guest crank halted/,
      );
      const refused = worker.request(line({ source: 'x' }));
      t.is(refused.status, STATUS.REFUSED);
      t.regex(refused.message, /^worker is dead after a failed crank: /);
      const close = worker.close();
      t.is(close.status, STATUS.ERROR);
      t.regex(close.message, /^worker is dead after a failed crank: /);
      wasm.closeDatabase();
      t.true(database !== undefined);
      // eslint-disable-next-line no-await-in-loop
      const again = await startWasm(t, wasmCopy.path);
      resume(t, again.worker);
      t.deepEqual(again.worker.request(line({ source: 'x' })), {
        status: STATUS.OK,
        message: result('1'),
      });
    }
  },
);

test.serial('a rolled-back commit leaves the prior epoch', async t => {
  t.timeout(120_000);
  const { path } = await copyOf(t, wasmTemplate);
  const one = await startWasm(t, path);
  const before = manifest(one.database.db);
  resume(t, one.worker);
  t.deepEqual(one.worker.request(line({ source: 'globalThis.y = 5' })), {
    status: STATUS.OK,
    message: result('5'),
  });
  // The crank and its checkpoint succeed in the module; the host discards
  // the transaction anyway, and must then drop the instance.
  t.deepEqual(one.worker.close(false), { status: STATUS.OK, message: '' });
  t.deepEqual(manifest(one.database.db), before);
  one.closeDatabase();
  const two = await startWasm(t, path);
  resume(t, two.worker);
  t.deepEqual(two.worker.request(line({ source: 'typeof y' })), {
    status: STATUS.OK,
    message: result('undefined'),
  });
});

test.serial(
  'a host failure during a commit is a status, not an exception',
  async t => {
    t.timeout(300_000);
    const { path } = await copyOf(t, wasmTemplate);
    // Count the statements of one close, then fail each of a spread of them.
    const counting = await startWasm(t, path);
    resume(t, counting.worker);
    counting.worker.request(line({ source: 'globalThis.z = 1' }));
    let statements = 0;
    counting.database.setFault((_sql, count) => {
      statements = count;
    });
    t.is(counting.worker.close(false).status, STATUS.OK);
    counting.closeDatabase();
    t.true(statements > 2, `a close ran ${statements} statements`);
    const before = await (async () => {
      const peek = openDatabase(path);
      try {
        return manifest(peek.db);
      } finally {
        peek.close();
      }
    })();
    for (const n of [1, Math.ceil(statements / 2), statements]) {
      // eslint-disable-next-line no-await-in-loop
      const run = await startWasm(t, path);
      resume(t, run.worker);
      run.worker.request(line({ source: 'globalThis.z = 1' }));
      run.database.setFault((_sql, count) => {
        if (count === n) throw Error(`injected failure at statement ${n}`);
      });
      /** @type {{ status: number, message: string } | undefined} */
      let answer;
      t.notThrows(() => {
        answer = run.worker.close();
      });
      t.is(answer?.status, STATUS.ERROR);
      t.is(
        answer?.message,
        `checkpoint: Io("injected failure at statement ${n}")`,
      );
      run.database.setFault(undefined);
      t.deepEqual(manifest(run.database.db), before);
      run.closeDatabase();
    }
    const after = await startWasm(t, path);
    resume(t, after.worker);
    t.deepEqual(after.worker.request(line({ source: 'typeof z' })), {
      status: STATUS.OK,
      message: result('undefined'),
    });
  },
);

nativeTest(
  'a wrong profile, fresh over populated, resume over empty',
  async t => {
    t.timeout(120_000);
    const { dir, path } = await copyOf(t, wasmTemplate);
    const one = await startWasm(t, path);
    const wrong = one.worker.open({
      fresh: false,
      profile: 'another-profile',
      limits: LIMITS,
    });
    t.is(wrong.status, STATUS.ERROR);
    t.regex(wrong.message, /^restore: /);
    const nativeCopy = await copyOf(t, nativeTemplate);
    const native = /** @type {NativeRun} */ (
      await runNative(nativeCopy.dir, nativeCopy.path, [], 'another-profile')
    );
    t.is(native.code, 1);
    // The native worker prints the same text, Debug-quoted.
    t.is(
      native.stderr,
      `worker failed: Ok(Err(${JSON.stringify(wrong.message)}))\n`,
    );
    t.log(`wasm and native: ${wrong.message}`);

    const populated = one.worker.open({
      fresh: true,
      profile: PROFILE,
      limits: LIMITS,
    });
    t.is(populated.status, STATUS.ERROR);
    t.regex(populated.message, /^begin: NotEmpty/);
    one.closeDatabase();

    const empty = await startWasm(t, join(dir, 'empty.sqlite'));
    t.deepEqual(
      empty.worker.open({ fresh: false, profile: PROFILE, limits: LIMITS }),
      { status: STATUS.ERROR, message: 'restore: Empty' },
    );
    // The refused open's schema and stamp were rolled back.
    t.is(
      empty.database.db
        .prepare(
          "SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'ih_%'",
        )
        .get()?.n,
      0,
    );
  },
);

const recursion = (/** @type {number} */ depth) =>
  `function f(n) { return n ? 1 + f(n - 1) : 0 } f(${depth})`;
const caughtRecursion = (/** @type {number} */ depth) =>
  `function f(n) { return n ? 1 + f(n - 1) : 0 } try { f(${depth}) } catch (e) { 'caught ' + e.name }`;
const DEEP = [
  ...[100, 900, 1000, 10_000, 100_000, 1_000_000].flatMap(depth => [
    recursion(depth),
    caughtRecursion(depth),
  ]),
  // The engine's other recursion families: the parser, JSON, and host
  // re-entry through a guest getter and a coercion.
  "eval('['.repeat(100000) + ']'.repeat(100000)).length",
  "JSON.parse('['.repeat(100000) + ']'.repeat(100000)).length",
  'var a = []; for (let i = 0; i < 100000; i++) a = [a]; JSON.stringify(a).length',
  'var x = {}; x.toString = function () { return String(this) }; String(x)',
  'new Proxy({}, { get(t, k, r) { return r[k] } }).foo',
];

nativeTest('deep recursion is an ordinary reply, as natively', async t => {
  t.timeout(600_000);
  /** @type {string[]} */
  const findings = [];
  for (const source of DEEP) {
    const request = line({ source });
    // eslint-disable-next-line no-await-in-loop
    const wasmCopy = await copyOf(t, wasmTemplate);
    // eslint-disable-next-line no-await-in-loop
    const run = await startWasm(t, wasmCopy.path);
    resume(t, run.worker);
    let reply;
    try {
      reply = run.worker.request(request).message;
    } catch (error) {
      const { name, message } = /** @type {Error} */ (error);
      reply = `host exception: ${name}: ${message}`;
    }
    run.closeDatabase();
    // eslint-disable-next-line no-await-in-loop
    const nativeCopy = await copyOf(t, nativeTemplate);
    const native = /** @type {NativeRun} */ (
      // eslint-disable-next-line no-await-in-loop
      await runNative(nativeCopy.dir, nativeCopy.path, [request])
    );
    findings.push(
      `${source}\n  wasm   ${reply.trim()}\n  native ${native.lines.at(-1)?.trim()}`,
    );
    t.is(reply, native.lines.at(-1), source);
  }
  t.log(findings.join('\n'));
});

test.serial('a call back into the module poisons the instance', async t => {
  t.timeout(120_000);
  // No guest-controllable panic is known; the honest unwind-class failure a
  // host can provoke is breaking the contract that an import never calls
  // back into the module.
  const { path } = await copyOf(t, wasmTemplate);
  const { worker, database } = await startWasm(t, path);
  /** @type {Array<{ status: number, message: string }>} */
  const nested = [];
  database.setFault(() => {
    if (nested.length === 0) nested.push(worker.exports.ready());
  });
  const opened = worker.open({
    fresh: false,
    profile: PROFILE,
    limits: LIMITS,
  });
  database.setFault(undefined);
  t.deepEqual(nested, [
    {
      status: STATUS.UNWIND,
      message: 'an export was called while another was running',
    },
  ]);
  // The outer call finishes; everything after it is refused.
  t.is(opened.status, STATUS.OK);
  const poisoned = {
    status: STATUS.UNWIND,
    message:
      'instance poisoned: an earlier call unwound, so nothing more may run in it',
  };
  t.deepEqual(worker.ready(), poisoned);
  t.deepEqual(worker.request(line({ source: '1' })), poisoned);
  t.deepEqual(worker.close(), poisoned);
  t.deepEqual(
    worker.open({ fresh: true, profile: PROFILE, limits: LIMITS }),
    poisoned,
  );
  // The allocator and the message functions still answer.
  const buffer = worker.exports.put('still allocates');
  buffer.free();
  t.is(worker.exports.takeMessage(), poisoned.message);
});
