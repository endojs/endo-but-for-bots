// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';
import { makeLoopback } from '@endo/captp';
import { E } from '@endo/eventual-send';
import { makeShell } from '@endo/exo-shell';
import { makePromiseKit } from '@endo/promise-kit';

import { makeSandboxFactory } from '../src/factory.js';
import { makeSandboxSpawner } from '../src/spawner.js';

/**
 * @param {import('ava').ExecutionContext} t
 * @param {{ code?: number, readerFailure?: boolean, hang?: boolean, admission?: Promise<unknown>, stdinClosure?: Promise<unknown>, remote?: boolean, outputChunks?: number, outputByteLimit?: bigint }} [plan]
 */
const fixture = async (t, plan = {}) => {
  const exit =
    /** @type {import('@endo/promise-kit').PromiseKit<{ code: number | null, signal: string | null }>} */ (
      makePromiseKit()
    );
  const signals = [];
  const calls = [];
  let stdinClosed = false;
  const bytes = text => new TextEncoder().encode(text);
  const driver = harden({
    name: /** @type {const} */ ('bwrap'),
    probe: async () => ({
      available: true,
      details: { lifecycle: { available: true } },
    }),
    prepareSlice: async () => harden({}),
    spawn: async (_slice, argv, options) => {
      calls.push({ argv, options });
      if (plan.admission) await plan.admission;
      return harden({
        pid: 123,
        stdout: harden({
          async *[Symbol.asyncIterator]() {
            yield bytes('hello ');
            if (plan.readerFailure) throw Error('broken stdout');
            yield bytes('world');
            for (let index = 0; index < (plan.outputChunks ?? 0); index += 1)
              yield new Uint8Array(64 * 1024);
          },
        }),
        stderr: harden({
          async *[Symbol.asyncIterator]() {
            yield bytes('diagnostic');
          },
        }),
        writeStdin: async () => {},
        closeStdin: async () => {
          stdinClosed = true;
          await plan.stdinClosure;
        },
        wait: () => exit.promise,
        kill: async signal => {
          signals.push(signal);
          exit.resolve({ code: null, signal });
        },
      });
    },
    teardown: async () => {
      exit.resolve({ code: null, signal: 'SIGKILL' });
    },
  });
  // Explicit native paths are unnecessary: this fake only exercises protocol.
  const capableFactory = makeSandboxFactory({
    drivers: [driver],
    scratchProvider: /** @type {any} */ ({
      provideScratchMount: async () => harden({}),
      provideHostPath: async () => '/owned/scratch',
    }),
  });
  const slice = await E(capableFactory).make({
    rootfs: { kind: 'host-bind' },
    network: 'none',
  });
  t.teardown(() => E(slice).dispose());
  if (!plan.hang && !plan.readerFailure)
    exit.resolve({ code: plan.code ?? 0, signal: null });
  const spawner = makeSandboxSpawner(
    plan.remote ? await makeLoopback('sandbox-spawner').makeFar(slice) : slice,
    { outputByteLimit: plan.outputByteLimit },
  );
  const shell = makeShell({
    cwd: '/workspace',
    policy: {
      allowedCommands: ['echo'],
      timeoutMs: 1000,
      maxOutputBytes: 1024,
      env: { CI: 'true' },
    },
    spawner,
    killGraceMs: 20,
  });
  return {
    shell,
    spawner,
    slice,
    calls,
    signals,
    stdinClosed: () => stdinClosed,
  };
};

test('Shell over a slice preserves argv, cwd, env, separate bytes and nonzero exit', async t => {
  const f = await fixture(t, { code: 7 });
  const result = await E(f.shell).exec('echo', ['literal; not interpolation']);
  t.deepEqual(result, {
    stdout: 'hello world',
    stderr: 'diagnostic',
    exitCode: 7,
    signal: null,
    truncated: false,
  });
  t.true(f.stdinClosed());
  t.deepEqual(f.calls[0].argv, ['echo', 'literal; not interpolation']);
  t.is(f.calls[0].options.cwd, '/workspace');
  t.deepEqual(f.calls[0].options.env, { CI: 'true' });
  t.is(f.calls[0].options.timeoutMs, 1000);
});

test('Sandbox spawner refuses shell wrapping before admitting a command', async t => {
  const f = await fixture(t);
  await t.throwsAsync(f.spawner(['echo'], { shell: true }), {
    message: /structured argv/,
  });
  t.is(f.calls.length, 0);
});

test('Shell truncates and drains output beyond the old native 16 MiB guard', async t => {
  t.timeout(10_000);
  const f = await fixture(t, { outputChunks: 272 });
  const result = await E(f.shell).exec('echo', []);
  t.is(result.stdout.length, 1024);
  t.true(result.truncated);
  t.is(result.exitCode, 0);
  t.deepEqual(f.signals, []);
});

test('native output guard remains independently configurable', async t => {
  const f = await fixture(t, { outputByteLimit: 4n });
  await t.throwsAsync(E(f.shell).exec('echo', []), {
    message: /byte limit|stdout|reader/,
  });
  t.true(f.signals.length > 0);
});

test('Shell and separate byte streams cross a CapTP membrane', async t => {
  t.timeout(3000);
  const f = await fixture(t, { remote: true, code: 7 });
  const result = await E(f.shell).exec('echo', ['remote literal']);
  t.deepEqual(result, {
    stdout: 'hello world',
    stderr: 'diagnostic',
    exitCode: 7,
    signal: null,
    truncated: false,
  });
  t.deepEqual(f.calls[0].argv, ['echo', 'remote literal']);
  t.true(f.stdinClosed());
});

test('a longer Shell timeout reaches a remote slice without a policy clamp', async t => {
  t.timeout(3000);
  const f = await fixture(t, { remote: true });
  const result = await E(f.shell).exec('echo', [], { timeoutMs: 900_000 });
  t.is(result.exitCode, 0);
  t.is(f.calls[0].options.timeoutMs, 900_000);
});

test('Sandbox reader failure stays a Shell failure and terminates the process', async t => {
  t.timeout(3000);
  const f = await fixture(t, { readerFailure: true });
  await t.throwsAsync(E(f.shell).exec('echo', []), {
    message: /stdout|reader/,
  });
  t.true(f.signals.length > 0);
});

test('Shell timeout covers delayed slice admission and a late process remains owned', async t => {
  t.timeout(3000);
  const admission = makePromiseKit();
  t.teardown(() => admission.resolve(undefined));
  const f = await fixture(t, { admission: admission.promise, hang: true });
  await t.throwsAsync(E(f.shell).exec('echo', [], { timeoutMs: 10 }), {
    message: /timed out/,
  });
  admission.resolve(undefined);
  await E(f.slice).dispose();
  t.true(f.signals.includes('SIGKILL'));
});

test('Sandbox process kill accepts terminal signals but not numeric probes', async t => {
  const f = await fixture(t);
  const process = await f.spawner(['echo']);
  t.throws(() => process.kill(0), {
    message: /Unsupported sandbox termination/,
  });
  await process.kill('SIGTERM');
  t.deepEqual(f.signals, ['SIGTERM']);
});

test('Stalled stdin closure does not hide an admitted process from cancellation', async t => {
  t.timeout(3000);
  const stdinClosure = makePromiseKit();
  t.teardown(() => stdinClosure.resolve(undefined));
  const f = await fixture(t, {
    stdinClosure: stdinClosure.promise,
    hang: true,
    remote: true,
  });
  await t.throwsAsync(E(f.shell).exec('echo', [], { timeoutMs: 10 }), {
    message: /timed out/,
  });
  t.true(f.stdinClosed());
  t.true(f.signals.includes('SIGTERM'));
});

test('Rejected stdin closure remains an execution failure with controls available', async t => {
  t.timeout(3000);
  const stdinClosure = makePromiseKit();
  const f = await fixture(t, {
    stdinClosure: stdinClosure.promise,
    hang: true,
    remote: true,
  });
  const completion = E(f.shell).exec('echo', []);
  stdinClosure.reject(Error('stdin EOF refused'));
  await t.throwsAsync(completion, { message: /stdin EOF refused/ });
  t.true(f.signals.includes('SIGTERM'));
});
