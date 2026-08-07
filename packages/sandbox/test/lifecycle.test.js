// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';
import { E } from '@endo/eventual-send';
import { iterateBytesReader } from '@endo/exo-stream/iterate-bytes-reader.js';

import { makeSandboxFactory } from '../src/factory.js';

const lifecycleDetails = harden({
  lifecycle: harden({
    available: true,
    processGroups: true,
    crashCleanup: true,
  }),
});

const scratchProvider = harden({
  provideScratchMount: async () => {
    throw new Error('scratch not needed by lifecycle fixtures');
  },
  provideHostPath: async () => {
    throw new Error('mount resolution not needed by lifecycle fixtures');
  },
});

const makePromiseKit = () => {
  let resolve = /** @type {(value?: any) => void} */ (() => undefined);
  let reject = /** @type {(reason?: any) => void} */ (() => undefined);
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  promise.catch(() => undefined);
  return harden({ promise, resolve, reject });
};

const makeByteSource = () => {
  /** @type {Uint8Array[]} */
  const queue = [];
  let ended = false;
  /** @type {Error | undefined} */
  let failure;
  /** @type {(() => void) | undefined} */
  let wake;

  const notify = () => {
    const waiter = wake;
    wake = undefined;
    waiter?.();
  };

  /** @type {AsyncIterableIterator<Uint8Array>} */
  const source = {
    async next() {
      await null;
      for (;;) {
        const value = queue.shift();
        if (value !== undefined) return harden({ done: false, value });
        if (failure !== undefined) throw failure;
        if (ended) return harden({ done: true, value: undefined });
        // eslint-disable-next-line no-await-in-loop
        await new Promise(resolve => {
          wake = () => resolve(undefined);
        });
      }
    },
    [Symbol.asyncIterator]() {
      return source;
    },
  };

  return harden({
    source,
    push: bytes => {
      queue.push(new Uint8Array(bytes));
      notify();
    },
    end: () => {
      ended = true;
      notify();
    },
    fail: error => {
      failure = error;
      notify();
    },
  });
};

/**
 * @param {{ spawnGate?: Promise<unknown>, softRefuse?: boolean, lifecycle?: boolean, context?: any }} [options]
 */
const makeDriverFixture = (options = {}) => {
  const stdout = makeByteSource();
  const stderr = makeByteSource();
  const exit = makePromiseKit();
  /** @type {(string | number)[]} */
  const signals = [];
  let spawnCalls = 0;
  let prepareCalls = 0;
  let teardownCalls = 0;
  let exited = false;

  const driver = harden({
    name: /** @type {const} */ ('bwrap'),
    probe: async () =>
      harden({
        available: true,
        ...(options.lifecycle === false ? {} : { details: lifecycleDetails }),
      }),
    prepareSlice: async () => {
      prepareCalls += 1;
      return harden({});
    },
    spawn: async () => {
      await null;
      spawnCalls += 1;
      if (options.spawnGate !== undefined) await options.spawnGate;
      return harden({
        pid: 1234,
        stdin: null,
        stdout: stdout.source,
        stderr: stderr.source,
        wait: () => exit.promise,
        kill: async signal => {
          const actual = signal ?? 'SIGTERM';
          signals.push(actual);
          if (
            !exited &&
            (actual === 'SIGKILL' ||
              actual === 9 ||
              options.softRefuse !== true)
          ) {
            exited = true;
            exit.resolve(harden({ code: null, signal: String(actual) }));
          }
        },
      });
    },
    teardown: async () => {
      teardownCalls += 1;
    },
  });

  const factory = makeSandboxFactory({
    drivers: harden([driver]),
    scratchProvider,
    context: options.context,
  });

  return harden({
    factory,
    stdout,
    stderr,
    signals: () => harden([...signals]),
    finish: (status = harden({ code: 0, signal: null })) => {
      if (!exited) {
        exited = true;
        exit.resolve(status);
      }
    },
    counts: () => harden({ spawnCalls, prepareCalls, teardownCalls }),
  });
};

const makeHandle = fixture =>
  E(fixture.factory).make(
    harden({ rootfs: { kind: 'host-bind' }, network: 'none' }),
  );

const collectReader = async reader => {
  await null;
  /** @type {Uint8Array[]} */
  const chunks = [];
  let error;
  try {
    for await (const chunk of iterateBytesReader(reader)) chunks.push(chunk);
  } catch (e) {
    error = /** @type {Error} */ (e);
  }
  return harden({ chunks: harden(chunks), error });
};

test('spawn admitted before dispose is registered and reaped', async t => {
  const gate = makePromiseKit();
  const fixture = makeDriverFixture({ spawnGate: gate.promise });
  const handle = await makeHandle(fixture);

  const spawned = E(handle).spawn(harden(['/bin/true']));
  await null;
  const disposed = E(handle).dispose();
  gate.resolve();

  const proc = await spawned;
  await disposed;
  t.deepEqual(fixture.signals(), ['SIGTERM']);
  t.is(fixture.counts().spawnCalls, 1);
  t.is(fixture.counts().teardownCalls, 1);
  await t.throwsAsync(() => E(proc).wait(), { message: /disposed/ });
});

test('dispose admitted before spawn prevents the driver call', async t => {
  const fixture = makeDriverFixture();
  const handle = await makeHandle(fixture);
  await E(handle).dispose();
  await t.throwsAsync(() => E(handle).spawn(harden(['/bin/true'])), {
    message: /disposed/,
  });
  t.is(fixture.counts().spawnCalls, 0);
  t.is(fixture.counts().teardownCalls, 1);
});

test('disposal and cancellation are idempotent', async t => {
  const fixture = makeDriverFixture();
  const handle = await makeHandle(fixture);
  const proc = await E(handle).spawn(harden(['/bin/sleep', 'forever']));
  await Promise.all([
    E(proc).kill(),
    E(proc).kill(),
    E(handle).dispose(),
    E(handle).dispose(),
  ]);
  t.deepEqual(fixture.signals(), ['SIGTERM']);
  t.is(fixture.counts().teardownCalls, 1);
});

test('owner cancellation disposes children and stops new handles', async t => {
  const cancelled = makePromiseKit();
  const fixture = makeDriverFixture({
    context: harden({ whenCancelled: () => cancelled.promise }),
  });
  const handle = await makeHandle(fixture);
  const proc = await E(handle).spawn(harden(['/bin/sleep', 'forever']));
  cancelled.reject(new Error('owner died'));
  await t.throwsAsync(() => E(proc).wait(), { message: /disposed/ });
  await t.throwsAsync(() => makeHandle(fixture), {
    message: /owner has been cancelled/,
  });
  t.deepEqual(fixture.signals(), ['SIGTERM']);
  t.is(fixture.counts().teardownCalls, 1);
});

test('stdout and stderr stay separate and preserve split UTF-8', async t => {
  const fixture = makeDriverFixture();
  const handle = await makeHandle(fixture);
  t.teardown(() => E(handle).dispose());
  const proc = await E(handle).spawn(
    harden(['/bin/fake']),
    harden({ stdoutByteLimit: 8n, stderrByteLimit: 8n }),
  );
  const euro = new TextEncoder().encode('€');
  fixture.stdout.push(euro.subarray(0, 1));
  fixture.stdout.push(euro.subarray(1));
  fixture.stderr.push(new TextEncoder().encode('err'));
  fixture.stdout.end();
  fixture.stderr.end();
  fixture.finish();

  const [stdout, stderr, status] = await Promise.all([
    collectReader(await E(proc).stdout()),
    collectReader(await E(proc).stderr()),
    E(proc).wait(),
  ]);
  const decoder = new TextDecoder();
  const stdoutText = stdout.chunks
    .map((chunk, index) =>
      decoder.decode(chunk, { stream: index < stdout.chunks.length - 1 }),
    )
    .join('');
  t.is(stdoutText, '€');
  t.is(new TextDecoder().decode(stderr.chunks[0]), 'err');
  t.deepEqual(status, { code: 0, signal: null });
});

test('reaching one output cap kills and reaps before settlement', async t => {
  t.timeout(5000);
  const fixture = makeDriverFixture({ softRefuse: true });
  const handle = await makeHandle(fixture);
  t.teardown(() => E(handle).dispose());
  const proc = await E(handle).spawn(
    harden(['/bin/fake']),
    harden({ stdoutByteLimit: 4n, stderrByteLimit: 100n }),
  );
  const stdoutResult = collectReader(await E(proc).stdout());
  const stderrResult = collectReader(await E(proc).stderr());
  fixture.stderr.push(new TextEncoder().encode('independent'));
  fixture.stderr.end();
  fixture.stdout.push(new TextEncoder().encode('1234'));

  await t.throwsAsync(() => E(proc).wait(), {
    message: /stdout.*byte limit/,
  });
  const [stdout, stderr] = await Promise.all([stdoutResult, stderrResult]);
  t.is(
    stdout.chunks.reduce((sum, chunk) => sum + chunk.length, 0),
    4,
  );
  t.is(new TextDecoder().decode(stderr.chunks[0]), 'independent');
  t.deepEqual(fixture.signals(), ['SIGTERM', 'SIGKILL']);
});

test('reader rejection uses the same kill-and-reap path', async t => {
  const fixture = makeDriverFixture();
  const handle = await makeHandle(fixture);
  t.teardown(() => E(handle).dispose());
  const proc = await E(handle).spawn(harden(['/bin/fake']));
  fixture.stdout.fail(new Error('synthetic pipe failure'));
  fixture.stderr.end();
  await t.throwsAsync(() => E(proc).wait(), {
    message: /synthetic pipe failure/,
  });
  t.deepEqual(fixture.signals(), ['SIGTERM']);
});

test('timeout escalates a soft-kill refusal and reaps', async t => {
  t.timeout(5000);
  const fixture = makeDriverFixture({ softRefuse: true });
  const handle = await makeHandle(fixture);
  t.teardown(() => E(handle).dispose());
  const proc = await E(handle).spawn(
    harden(['/bin/fake']),
    harden({ timeoutMs: 25 }),
  );
  await t.throwsAsync(() => E(proc).wait(), { message: /timed out/ });
  t.deepEqual(fixture.signals(), ['SIGTERM', 'SIGKILL']);
});

test('a descendant-held pipe cannot hold wait past bounded drain', async t => {
  t.timeout(2000);
  const fixture = makeDriverFixture();
  const handle = await makeHandle(fixture);
  t.teardown(() => E(handle).dispose());
  const proc = await E(handle).spawn(harden(['/bin/fake']));
  fixture.stderr.end();
  fixture.finish();
  const started = Date.now();
  t.deepEqual(await E(proc).wait(), { code: 0, signal: null });
  t.true(Date.now() - started < 1500, 'wait is bounded independently of EOF');
});

test('driver availability fails closed without lifecycle proof', async t => {
  const fixture = makeDriverFixture({ lifecycle: false });
  const [probe] = await E(fixture.factory).listBackends();
  t.false(probe.available);
  t.regex(probe.reason ?? '', /did not prove process-group/);
  await t.throwsAsync(() => makeHandle(fixture), {
    message: /no backend available.*process-group/,
  });
  t.deepEqual(fixture.counts(), {
    spawnCalls: 0,
    prepareCalls: 0,
    teardownCalls: 0,
  });
});
