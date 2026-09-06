// @ts-check
import '@endo/init';

import test from 'ava';

import { E } from '@endo/eventual-send';
import { bytesReaderFromIterator } from '@endo/exo-stream/bytes-reader-from-iterator.js';
import { bytesWriterFromIterator } from '@endo/exo-stream/bytes-writer-from-iterator.js';
import { makeSandboxFactory } from '@endo/sandbox/factory.js';

import { startAppServerTransport } from '../src/app-server-transport.js';

const textChunks = parts =>
  bytesReaderFromIterator(parts.map(part => new TextEncoder().encode(part)));

/**
 * @param {{ stdout?: string[], stderr?: string[], closeStdinEarly?: boolean, stdinError?: string, stdoutError?: string, stdinBarrier?: Promise<void>, stdoutBarrier?: Promise<void>, killError?: string, waitBarrier?: Promise<void>, waitError?: string }} [options]
 */
const makeFixture = ({
  stdout = ['{"id":1,"result":{}}\n'],
  stderr = ['diagnostic\n'],
  closeStdinEarly = false,
  stdinError,
  stdoutError,
  stdinBarrier,
  stdoutBarrier,
  killError,
  waitBarrier,
  waitError,
} = {}) => {
  const writes = [];
  let stdinReturns = 0;
  let kills = 0;
  let waits = 0;
  let spawnCall;

  const sink = {
    /** @param {Uint8Array} bytes */
    async next(bytes) {
      if (closeStdinEarly) return { done: true, value: undefined };
      writes.push(bytes);
      return { done: false, value: undefined };
    },
    async return() {
      stdinReturns += 1;
      return { done: true, value: undefined };
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };

  const proc = {
    async stdin() {
      if (stdinBarrier) await stdinBarrier;
      if (stdinError) throw Error(stdinError);
      if (closeStdinEarly) {
        return harden({
          async streamBase64(_synHead) {
            return harden({ value: 'closed', promise: null });
          },
          writeReturnPattern() {
            return undefined;
          },
        });
      }
      return bytesWriterFromIterator(sink);
    },
    async stdout() {
      if (stdoutBarrier) await stdoutBarrier;
      if (stdoutError) throw Error(stdoutError);
      return textChunks(stdout);
    },
    async stderr() {
      return textChunks(stderr);
    },
    async kill() {
      kills += 1;
      if (killError) throw Error(killError);
    },
    async wait() {
      waits += 1;
      await null;
      if (waitBarrier) await waitBarrier;
      if (waitError) throw Error(waitError);
      return harden({ success: true, code: 0, signal: undefined });
    },
  };

  const slice = {
    async spawn(argv, options) {
      spawnCall = { argv, options };
      return proc;
    },
  };

  return {
    slice,
    writes,
    getSpawnCall: () => spawnCall,
    counts: () => ({ stdinReturns, kills, waits }),
  };
};

test('transport binds app-server stdio and owns process cleanup', async t => {
  const fixture = makeFixture({
    stdout: ['{"id":', '1,"result":{}}\n{"method":"ready"}\n'],
    stderr: ['first\n', 'second\n'],
  });
  const transport = await startAppServerTransport({
    slice: /** @type {any} */ (fixture.slice),
    cwd: '/work',
    executable: '/bin/codex',
    stdoutByteLimit: 123n,
    stderrByteLimit: 45n,
  });

  t.deepEqual(fixture.getSpawnCall(), {
    argv: ['/bin/codex', 'app-server', '--listen', 'stdio://'],
    options: {
      cwd: '/work',
      env: {
        CODEX_HOME: '/codex-home',
        HOME: '/home/node',
        LANG: 'C.UTF-8',
        LC_ALL: 'C.UTF-8',
        TEMP: '/tmp',
        TMP: '/tmp',
        TMPDIR: '/tmp',
        TZ: 'UTC',
      },
      captureStdout: true,
      captureStderr: true,
      stdoutByteLimit: 123n,
      stderrByteLimit: 45n,
    },
  });

  await transport.send({ id: 7, method: 'initialize' });
  t.is(
    new TextDecoder().decode(fixture.writes[0]),
    '{"id":7,"method":"initialize"}\n',
  );

  const messages = [];
  for await (const message of transport.messages) messages.push(message);
  t.deepEqual(messages, [{ id: 1, result: {} }, { method: 'ready' }]);

  await transport.close();
  await transport.close();
  t.deepEqual(fixture.counts(), { stdinReturns: 1, kills: 1, waits: 1 });
  t.regex(transport.diagnostics(), /first\nsecond/);
  await t.throwsAsync(transport.send({ id: 8 }), { message: /closed/ });
});

test('the transport speaks the stdin a real sandbox process hands out', async t => {
  // The fixtures above imitate a process handle; this drives `@endo/sandbox`
  // itself over a fake driver, so a change to the shape of its stdin writer
  // — it was once an exo that no caller could pass bytes to — fails here.
  /** @type {Uint8Array[]} */
  const written = [];
  let stdinClosed = 0;
  /** @type {(status: any) => void} */
  let resolveExit = () => {};
  const exited = new Promise(resolve => {
    resolveExit = resolve;
  });
  const driver = harden({
    name: /** @type {const} */ ('bwrap'),
    probe: async () =>
      harden({
        available: true,
        details: harden({ lifecycle: harden({ available: true }) }),
      }),
    prepareSlice: async () => harden({}),
    spawn: async () =>
      harden({
        pid: 4242,
        stdin: null,
        writeStdin: async chunk => {
          written.push(chunk);
        },
        closeStdin: async () => {
          stdinClosed += 1;
        },
        stdout: (async function* stdout() {
          yield new TextEncoder().encode('{"id":1,"result":{}}\n');
        })(),
        stderr: (async function* stderr() {
          yield* [];
        })(),
        wait: () => exited,
        kill: async signal => {
          resolveExit(
            harden({ code: null, signal: String(signal ?? 'SIGTERM') }),
          );
        },
      }),
    teardown: async () => undefined,
  });
  const factory = makeSandboxFactory({
    drivers: harden([driver]),
    scratchProvider: harden({
      provideScratchMount: async () => {
        throw Error('no scratch in this test');
      },
      provideHostPath: async () => {
        throw Error('no host paths in this test');
      },
    }),
  });
  const slice = await E(factory).make(
    harden({ rootfs: { kind: 'host-bind' }, network: 'none' }),
  );
  const transport = await startAppServerTransport({
    slice: /** @type {any} */ (slice),
  });
  await transport.send({ id: 1, method: 'initialize' });
  t.deepEqual(
    written.map(chunk => new TextDecoder().decode(chunk)),
    ['{"id":1,"method":"initialize"}\n'],
  );
  const messages = [];
  for await (const message of transport.messages) messages.push(message);
  t.deepEqual(messages, [{ id: 1, result: {} }]);
  await transport.close();
  t.is(stdinClosed, 1);
});

test('transport denies all caller-supplied environment entries', async t => {
  for (const env of /** @type {Array<Record<string, string>>} */ ([
    { OPENAI_API_KEY: 'secret' },
    { GITHUB_TOKEN: 'secret' },
    { HTTPS_PROXY: 'http://credential-proxy.invalid' },
    { SAFE_VALUE: 'even seemingly safe values expand the contract' },
  ])) {
    const fixture = makeFixture({});
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(
      () =>
        startAppServerTransport({
          slice: /** @type {any} */ (fixture.slice),
          env,
        }),
      { message: /Custom app-server environment denied/ },
    );
    t.is(fixture.getSpawnCall(), undefined);
  }
});

test('transport bounds stdio acquisition and reaps partial setup', async t => {
  for (const barrierName of ['stdinBarrier', 'stdoutBarrier']) {
    const fixture = makeFixture({
      [barrierName]: new Promise(() => {}),
    });
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(
      () =>
        startAppServerTransport({
          slice: /** @type {any} */ (fixture.slice),
          setupTimeoutMs: 5,
          teardownTimeoutMs: 50,
        }),
      { message: /acquisition timed out/ },
    );
    t.deepEqual(fixture.counts(), {
      stdinReturns: 0,
      kills: 1,
      waits: 1,
    });
  }
});

test('transport rejects when app-server closes stdin before a write', async t => {
  const fixture = makeFixture({ closeStdinEarly: true, stderr: [] });
  const transport = await startAppServerTransport({
    slice: /** @type {any} */ (fixture.slice),
  });

  await t.throwsAsync(transport.send({ id: 1, method: 'initialize' }), {
    message: /stdin closed before request write/,
  });
  await transport.close();
});

test('concurrent close callers share the kill and reap barrier', async t => {
  let resolveWait = () => {};
  const waitBarrier = new Promise(resolve => {
    resolveWait = () => resolve(undefined);
  });
  const fixture = makeFixture({ waitBarrier });
  const transport = await startAppServerTransport({
    slice: /** @type {any} */ (fixture.slice),
  });
  const first = transport.close();
  const second = transport.close();
  let secondSettled = false;
  void second.then(() => {
    secondSettled = true;
  });
  await null;
  await null;
  t.false(secondSettled);
  resolveWait();
  await Promise.all([first, second]);
  t.deepEqual(fixture.counts(), { stdinReturns: 1, kills: 1, waits: 1 });
});

test('close attempts all teardown steps and preserves failure', async t => {
  const fixture = makeFixture({ killError: 'kill failed' });
  const transport = await startAppServerTransport({
    slice: /** @type {any} */ (fixture.slice),
  });
  await t.throwsAsync(transport.close(), { message: /teardown failed/ });
  await t.throwsAsync(transport.close(), { message: /teardown failed/ });
  t.deepEqual(fixture.counts(), { stdinReturns: 1, kills: 1, waits: 1 });
});

test('a killed process whose wait rejects has been reaped, not lost', async t => {
  // `@endo/sandbox` reports a cancelled process by rejecting `wait` after its
  // own reap; the reason is kept for diagnostics.
  const fixture = makeFixture({ waitError: 'sandbox process cancelled' });
  const transport = await startAppServerTransport({
    slice: /** @type {any} */ (fixture.slice),
  });
  await transport.close();
  t.deepEqual(fixture.counts(), { stdinReturns: 1, kills: 1, waits: 1 });
  t.regex(transport.diagnostics(), /sandbox process cancelled/);
});

test('close bounds a supervisor that never reports process reap', async t => {
  const fixture = makeFixture({ waitBarrier: new Promise(() => {}) });
  const transport = await startAppServerTransport({
    slice: /** @type {any} */ (fixture.slice),
    teardownTimeoutMs: 5,
  });
  await t.throwsAsync(transport.close(), {
    message: /teardown failed/,
  });
  t.deepEqual(fixture.counts(), { stdinReturns: 1, kills: 1, waits: 1 });
});

test('transport kills and reaps after partial construction failure', async t => {
  await null;
  for (const fixture of [
    makeFixture({ stdinError: 'no stdin' }),
    makeFixture({ stdoutError: 'no stdout' }),
  ]) {
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(
      startAppServerTransport({ slice: /** @type {any} */ (fixture.slice) }),
      { message: /no std/ },
    );
    t.deepEqual(fixture.counts(), { stdinReturns: 0, kills: 1, waits: 1 });
  }
});

test('partial construction reports cleanup failures with setup failure', async t => {
  const fixture = makeFixture({
    stdinError: 'no stdin',
    killError: 'kill failed',
    waitError: 'sandbox process cancelled',
  });
  const error = await t.throwsAsync(
    startAppServerTransport({ slice: /** @type {any} */ (fixture.slice) }),
    { instanceOf: AggregateError, message: /setup and cleanup failed/ },
  );
  t.truthy(error);
  // The rejected wait is the process being gone, not a cleanup failure.
  t.deepEqual(
    /** @type {AggregateError} */ (error).errors.map(reason => reason.message),
    ['no stdin', 'kill failed'],
  );
  t.deepEqual(fixture.counts(), { stdinReturns: 0, kills: 1, waits: 1 });
});
