// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';
import { makeCancelKit } from '@endo/cancel';
import { E } from '@endo/eventual-send';
import { iterateBytesReader } from '@endo/exo-stream/iterate-bytes-reader.js';
import { makePromiseKit } from '@endo/promise-kit';

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
 * @param {{ spawnGate?: Promise<unknown>, softRefuse?: boolean, brokenSignals?: boolean, lifecycle?: boolean, context?: any }} [options]
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
  let admissionAborts = 0;
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
    /**
     * @param {unknown} _slice
     * @param {string[]} _argv
     * @param {object} _opts
     * @param {import('../src/types.js').DriverSpawnControls} [controls]
     */
    spawn: async (_slice, _argv, _opts, controls) => {
      await null;
      spawnCalls += 1;
      controls?.cancelled?.catch(() => {
        admissionAborts += 1;
      });
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
          if (options.brokenSignals === true) {
            throw new Error(`synthetic backend signal failure (${actual})`);
          }
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
    admissionAborts: () => admissionAborts,
    exitStatus: () => exit.promise,
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

test('dispose cancels a pending admission and reaps a late arrival', async t => {
  t.timeout(2000);
  const gate = makePromiseKit();
  const fixture = makeDriverFixture({ spawnGate: gate.promise });
  const handle = await makeHandle(fixture);

  const spawned = E(handle).spawn(harden(['/bin/true']));
  spawned.catch(() => undefined);
  await null;
  // Disposal must settle while the driver admission is still pending;
  // it cancels the admission instead of awaiting it.
  await E(handle).dispose();
  t.is(fixture.counts().spawnCalls, 1);
  t.is(fixture.counts().teardownCalls, 1);
  t.is(fixture.admissionAborts(), 1);
  await t.throwsAsync(() => spawned, { message: /disposed/ });

  // A driver that ignored the cancellation and produces the process
  // late must see it terminated and reaped, not leaked.
  gate.resolve(undefined);
  const status = await fixture.exitStatus();
  t.deepEqual(status, { code: null, signal: 'SIGKILL' });
  t.deepEqual(fixture.signals(), ['SIGKILL']);
});

test('a never-resolving driver admission cannot hold up disposal', async t => {
  t.timeout(2000);
  const never = new Promise(() => undefined);
  const fixture = makeDriverFixture({ spawnGate: never });
  const handle = await makeHandle(fixture);

  const spawned = E(handle).spawn(harden(['/bin/true']));
  spawned.catch(() => undefined);
  await null;
  await E(handle).dispose();
  t.is(fixture.admissionAborts(), 1);
  await t.throwsAsync(() => spawned, { message: /disposed/ });
  t.deepEqual(fixture.signals(), []);
});

test('a never-resolving driver admission still honours the timeout', async t => {
  t.timeout(2000);
  const never = new Promise(() => undefined);
  const fixture = makeDriverFixture({ spawnGate: never });
  const handle = await makeHandle(fixture);
  t.teardown(() => E(handle).dispose());

  await t.throwsAsync(
    () => E(handle).spawn(harden(['/bin/true']), harden({ timeoutMs: 25 })),
    { message: /timed out/ },
  );
  t.is(fixture.admissionAborts(), 1);
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
  const { cancelled, cancel } = makeCancelKit();
  const fixture = makeDriverFixture({
    context: harden({ whenCancelled: () => cancelled }),
  });
  const handle = await makeHandle(fixture);
  const proc = await E(handle).spawn(harden(['/bin/sleep', 'forever']));
  cancel(new Error('owner died'));
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

test('unconsumed tiny-chunk output coalesces into bounded blocks', async t => {
  t.timeout(10_000);
  const fixture = makeDriverFixture();
  const handle = await makeHandle(fixture);
  t.teardown(() => E(handle).dispose());
  const proc = await E(handle).spawn(harden(['/bin/fake']));

  // Adversarial source: one byte per chunk, nobody consuming. The eager
  // pump must coalesce rather than retain one queue entry per chunk.
  const total = 10_000;
  for (let i = 0; i < total; i += 1) {
    fixture.stdout.push(new Uint8Array([i % 256]));
  }
  fixture.stdout.end();
  fixture.stderr.end();
  fixture.finish();

  // Waiting first lets the pump drain the source before any consumer
  // attaches, so the chunk count below observes the retained queue.
  t.deepEqual(await E(proc).wait(), { code: 0, signal: null });
  const stdout = await collectReader(await E(proc).stdout());
  const blockSize = 64 * 1024;
  t.is(
    stdout.chunks.reduce((sum, chunk) => sum + chunk.length, 0),
    total,
  );
  t.true(
    stdout.chunks.length <= Math.ceil(total / blockSize) + 1,
    `retained structure must stay bounded; got ${stdout.chunks.length} chunks`,
  );
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of stdout.chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  t.is(bytes[0], 0);
  t.is(bytes[total - 1], (total - 1) % 256);
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

test('kill rejects nonterminating signals without touching the process', async t => {
  const fixture = makeDriverFixture();
  const handle = await makeHandle(fixture);
  t.teardown(() => E(handle).dispose());
  const proc = await E(handle).spawn(harden(['/bin/fake']));

  // kill() is terminal cancellation, so a liveness probe or a
  // user-defined signal must be rejected at the guard rather than
  // silently escalated to SIGKILL against a live process.
  await t.throwsAsync(() => E(proc).kill(/** @type {any} */ (0)), {
    message: /kill/,
  });
  await t.throwsAsync(() => E(proc).kill(/** @type {any} */ ('SIGUSR1')), {
    message: /kill/,
  });
  t.deepEqual(fixture.signals(), []);

  // A supported termination signal still drives the terminal path.
  await E(proc).kill('SIGINT');
  t.deepEqual(fixture.signals(), ['SIGINT']);
});

test('persistent signal failure surfaces a bounded cleanup error', async t => {
  t.timeout(10_000);
  // Both signal attempts reject and wait() never settles: cleanup must
  // invoke the backend force-teardown path and surface a containment
  // error within a bounded time instead of waiting forever.
  const fixture = makeDriverFixture({ brokenSignals: true });
  const handle = await makeHandle(fixture);
  const proc = await E(handle).spawn(harden(['/bin/fake']));

  await t.throwsAsync(() => E(proc).kill(), {
    message: /could not prove containment.*synthetic backend signal failure/,
  });
  t.deepEqual(fixture.signals(), ['SIGTERM', 'SIGKILL']);
  t.true(
    fixture.counts().teardownCalls >= 1,
    'backend force-teardown must have been invoked',
  );
  await t.throwsAsync(() => E(proc).wait(), {
    message: /could not prove containment/,
  });
  await t.throwsAsync(() => E(handle).dispose(), {
    message: /dispose could not prove containment/,
  });
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
