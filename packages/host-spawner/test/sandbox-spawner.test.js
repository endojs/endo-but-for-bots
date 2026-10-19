// @ts-check
// prefer-endo-primitives-exempt: @endo/bytes has no UTF-8 codec; TextEncoder builds fixture bytes.

// Establish a SES perimeter (provides the `harden` global).
// eslint-disable-next-line import/order
import '@endo/init/debug.js';

import test from 'ava';
import { makeExo } from '@endo/exo';
import { bytesReaderFromIterator } from '@endo/exo-stream/bytes-reader-from-iterator.js';
import { M } from '@endo/patterns';

import { makeSandboxSpawner } from '../src/sandbox-spawner.js';

const encoder = new TextEncoder();

/**
 * @param {string[]} chunks
 */
const readerOf = chunks =>
  bytesReaderFromIterator(
    (async function* produce() {
      for (const chunk of chunks) yield encoder.encode(chunk);
    })(),
  );

/**
 * @param {AsyncIterable<Uint8Array> | null | undefined} stream
 */
const drain = async stream => {
  if (!stream) return '';
  const decoder = new TextDecoder();
  let text = '';
  for await (const chunk of stream) {
    text += decoder.decode(chunk, { stream: true });
  }
  return text + decoder.decode();
};

/**
 * A stand-in for an `@endo/sandbox` `SandboxHandle` whose processes are
 * scripted: each records its argv and spawn options and settles `wait()` as
 * `plan` says.
 *
 * @param {(argv: readonly string[]) => {
 *   stdout?: string[],
 *   stderr?: string[],
 *   status?: { code: number | null, signal: string | null },
 *   rejectWith?: Error,
 *   rejectOnKill?: boolean,
 * }} plan
 */
const makeFakeSlice = plan => {
  /** @type {{ argv: readonly string[], opts: any }[]} */
  const spawns = [];
  /** @type {string[]} */
  const kills = [];
  const slice = makeExo(
    'FakeSlice',
    M.interface('FakeSlice', {}, { defaultGuards: 'passable' }),
    {
      /**
       * @param {readonly string[]} argv
       * @param {any} opts
       */
      spawn: async (argv, opts) => {
        spawns.push({ argv, opts });
        const script = plan(argv);
        /** @type {(error: Error) => void} */
        let rejectWait = () => {};
        const waited = new Promise((resolve, reject) => {
          rejectWait = reject;
          if (script.rejectWith) reject(script.rejectWith);
          else if (!script.rejectOnKill) resolve(script.status);
        });
        waited.catch(() => {});
        return makeExo(
          'FakeProcess',
          M.interface('FakeProcess', {}, { defaultGuards: 'passable' }),
          {
            pid: () => 7,
            stdout: () => readerOf(script.stdout ?? []),
            stderr: () => readerOf(script.stderr ?? []),
            wait: () => waited,
            /** @param {string} [signal] */
            kill: async (signal = 'SIGTERM') => {
              kills.push(signal);
              rejectWait(Error('sandbox process cancelled'));
            },
          },
        );
      },
    },
  );
  return { slice, spawns, kills };
};

test('runs argv in the slice and adapts the process handle', async t => {
  const { slice, spawns } = makeFakeSlice(() => ({
    stdout: ['hello ', 'world'],
    stderr: ['warn'],
    status: { code: 0, signal: null },
  }));
  const spawner = makeSandboxSpawner(slice);
  const proc = await spawner(['echo', 'hello'], {
    cwd: '/work',
    env: { LC_ALL: 'C' },
  });
  t.is(proc.pid, 7);
  const [stdout, stderr, status] = await Promise.all([
    drain(proc.stdout),
    drain(proc.stderr),
    proc.wait(),
  ]);
  t.is(stdout, 'hello world');
  t.is(stderr, 'warn');
  t.deepEqual(status, { code: 0, signal: null });
  t.deepEqual(spawns[0].argv, ['echo', 'hello']);
  t.deepEqual(spawns[0].opts, { cwd: '/work', env: { LC_ALL: 'C' } });
});

test('maps the timeout and output cap onto the slice limits', async t => {
  const { slice, spawns } = makeFakeSlice(() => ({
    status: { code: 0, signal: null },
  }));
  const spawner = makeSandboxSpawner(slice);
  const proc = await spawner(['true'], { timeoutMs: 3000, maxOutputBytes: 10 });
  await proc.wait();
  // One byte past the cap, so the caller still sees the overflow it reports
  // as truncation before the slice terminates the process.
  t.deepEqual(spawns[0].opts, {
    timeoutMs: 3000,
    stdoutByteLimit: 11n,
    stderrByteLimit: 11n,
  });
});

test('refuses shell mode and an empty argv without spawning', async t => {
  const { slice, spawns } = makeFakeSlice(() => ({}));
  const spawner = makeSandboxSpawner(slice);
  await t.throwsAsync(() => spawner(['ls -F'], { shell: true }), {
    message: /shell mode is not supported/,
  });
  await t.throwsAsync(() => spawner([]), {
    message: /argv must be a non-empty/,
  });
  t.is(spawns.length, 0);
});

test('a requested kill settles wait() with the signal instead of rejecting', async t => {
  const { slice, kills } = makeFakeSlice(() => ({ rejectOnKill: true }));
  const spawner = makeSandboxSpawner(slice);
  const proc = await spawner(['sleep', '60']);
  await proc.kill('SIGTERM');
  await proc.kill('SIGKILL');
  await Promise.all([drain(proc.stdout), drain(proc.stderr)]);
  t.deepEqual(await proc.wait(), { code: null, signal: 'SIGTERM' });
  t.deepEqual(kills, ['SIGTERM', 'SIGKILL']);
});

test('a slice byte-limit termination settles wait() as a SIGKILL exit', async t => {
  const { slice } = makeFakeSlice(() => ({
    stdout: ['x'.repeat(11)],
    rejectWith: Error('sandbox stdout byte limit reached (11)'),
  }));
  const spawner = makeSandboxSpawner(slice);
  const proc = await spawner(['yes'], { maxOutputBytes: 10 });
  const [stdout] = await Promise.all([drain(proc.stdout), drain(proc.stderr)]);
  t.is(stdout.length, 11);
  t.deepEqual(await proc.wait(), { code: null, signal: 'SIGKILL' });
});

test('an unexplained slice failure still rejects wait()', async t => {
  const { slice } = makeFakeSlice(() => ({
    rejectWith: Error('sandbox dispose could not prove containment'),
  }));
  const spawner = makeSandboxSpawner(slice);
  const proc = await spawner(['true'], { maxOutputBytes: 10 });
  await Promise.all([drain(proc.stdout), drain(proc.stderr)]);
  await t.throwsAsync(() => proc.wait(), { message: /containment/ });
});

test('kill rejects a non-termination signal', async t => {
  const { slice, kills } = makeFakeSlice(() => ({ rejectOnKill: true }));
  const spawner = makeSandboxSpawner(slice);
  const proc = await spawner(['sleep', '60']);
  await t.throwsAsync(() => proc.kill('SIGUSR1'), {
    message: /unsupported signal/,
  });
  t.deepEqual(kills, []);
});
