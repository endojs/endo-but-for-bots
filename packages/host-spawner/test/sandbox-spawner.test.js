// @ts-check
// prefer-endo-primitives-exempt: @endo/bytes has no UTF-8 codec; TextEncoder builds fixture bytes.

// Establish a SES perimeter (provides the `harden` global).
// eslint-disable-next-line import/order
import '@endo/init/debug.js';

import test from 'ava';
import { fc } from '@fast-check/ava';
import { makeExo } from '@endo/exo';
import { bytesReaderFromIterator } from '@endo/exo-stream/bytes-reader-from-iterator.js';
import { bytesWriterFromIterator } from '@endo/exo-stream/bytes-writer-from-iterator.js';
import { M } from '@endo/patterns';

import {
  DEFAULT_PROCESS_OUTPUT_BYTE_LIMIT,
  makeSandboxSpawner,
} from '../src/sandbox-spawner.js';

const encoder = new TextEncoder();

/**
 * @param {Array<string | Uint8Array>} chunks
 */
const readerOf = chunks =>
  bytesReaderFromIterator(
    (async function* produce() {
      for (const chunk of chunks) {
        yield typeof chunk === 'string' ? encoder.encode(chunk) : chunk;
      }
    })(),
  );

const sink = () =>
  bytesWriterFromIterator(
    (async function* consume() {
      for (;;) yield;
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
 * scripted.  Like the real slice, a kill settles only once the process is
 * reaped: it rejects `wait()` with the cancellation and resolves, unless
 * `killRejectsWith` scripts a cleanup that cannot prove containment.
 *
 * @param {(argv: readonly string[]) => {
 *   stdout?: Array<string | Uint8Array>,
 *   stderr?: string[],
 *   status?: { code: number | null, signal: string | null },
 *   rejectWith?: Error,
 *   untilKilled?: boolean,
 *   killRejectsWith?: Error,
 *   admission?: Promise<unknown>,
 * }} plan
 */
const makeFakeSlice = plan => {
  /** @type {{ argv: readonly string[], options: any }[]} */
  const spawns = [];
  /** @type {string[]} */
  const kills = [];
  const slice = makeExo(
    'FakeSlice',
    M.interface('FakeSlice', {}, { defaultGuards: 'passable' }),
    {
      /**
       * @param {readonly string[]} argv
       * @param {any} options
       */
      spawn: async (argv, options) => {
        spawns.push({ argv, options });
        const script = plan(argv);
        await script.admission;
        /** @type {(error: Error) => void} */
        let rejectWait = () => {};
        const waited = new Promise((resolve, reject) => {
          rejectWait = reject;
          if (script.rejectWith) reject(script.rejectWith);
          else if (!script.untilKilled && !script.killRejectsWith) {
            resolve(script.status);
          }
        });
        waited.catch(() => {});
        return makeExo(
          'FakeProcess',
          M.interface('FakeProcess', {}, { defaultGuards: 'passable' }),
          {
            pid: () => 7,
            stdin: () => sink(),
            stdout: () => readerOf(script.stdout ?? []),
            stderr: () => readerOf(script.stderr ?? []),
            wait: () => waited,
            /** @param {string} [signal] */
            kill: async (signal = 'SIGTERM') => {
              kills.push(signal);
              if (script.killRejectsWith) {
                rejectWait(script.killRejectsWith);
                throw script.killRejectsWith;
              }
              rejectWait(Error('sandbox process canceled'));
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
  const childProcess = await spawner(['echo', 'hello'], {
    cwd: '/work',
    env: { LC_ALL: 'C' },
  });
  t.is(childProcess.pid, 0, 'no remote OS pid is disclosed');
  const [stdout, stderr, status] = await Promise.all([
    drain(childProcess.stdout),
    drain(childProcess.stderr),
    childProcess.wait(),
  ]);
  t.is(stdout, 'hello world');
  t.is(stderr, 'warn');
  t.deepEqual(status, { code: 0, signal: null });
  t.deepEqual(spawns[0].argv, ['echo', 'hello']);
  t.deepEqual(spawns[0].options, {
    cwd: '/work',
    env: { LC_ALL: 'C' },
    captureStdout: true,
    captureStderr: true,
    stdoutByteLimit: DEFAULT_PROCESS_OUTPUT_BYTE_LIMIT,
    stderrByteLimit: DEFAULT_PROCESS_OUTPUT_BYTE_LIMIT,
  });
});

test('the timeout reaches the slice exactly and the cap never becomes a slice limit', async t => {
  await fc.assert(
    fc.asyncProperty(
      fc.integer({ min: 1, max: 60_000 }),
      fc.integer({ min: 1, max: 1_048_576 }),
      fc.bigInt({ min: 1n, max: 2n ** 40n }),
      async (timeoutMs, maxOutputBytes, outputByteLimit) => {
        const { slice, spawns } = makeFakeSlice(() => ({
          status: { code: 0, signal: null },
        }));
        const spawner = makeSandboxSpawner(slice, { outputByteLimit });
        const childProcess = await spawner(['true'], {
          timeoutMs,
          maxOutputBytes,
        });
        await childProcess.wait();
        const { options } = spawns[0];
        return (
          options.timeoutMs === timeoutMs &&
          options.stdoutByteLimit === outputByteLimit &&
          options.stderrByteLimit === outputByteLimit
        );
      },
    ),
    { numRuns: 100 },
  );
  t.pass();
});

test('refuses shell mode, an empty argv, and a bad output limit without spawning', async t => {
  const { slice, spawns } = makeFakeSlice(() => ({}));
  const spawner = makeSandboxSpawner(slice);
  await t.throwsAsync(() => spawner(['ls -F'], { shell: true }), {
    message: /structured argv/,
  });
  await t.throwsAsync(() => spawner([]), {
    message: /argv must be a non-empty/,
  });
  t.throws(() => makeSandboxSpawner(slice, { outputByteLimit: 0n }), {
    message: /Invalid sandbox output byte limit/,
  });
  t.is(spawns.length, 0);
});

test('a requested kill settles wait() with the signal once the slice reaps', async t => {
  const { slice, kills } = makeFakeSlice(() => ({ untilKilled: true }));
  const spawner = makeSandboxSpawner(slice);
  const childProcess = await spawner(['sleep', '60']);
  await childProcess.kill('SIGTERM');
  await childProcess.kill('SIGKILL');
  t.deepEqual(await childProcess.wait(), { code: null, signal: 'SIGTERM' });
  t.deepEqual(kills, ['SIGTERM', 'SIGKILL']);
});

test('wait() settles after a kill even when no one reads the streams', async t => {
  t.timeout(2000);
  const { slice } = makeFakeSlice(() => ({
    stdout: ['x'.repeat(64)],
    stderr: ['y'],
    untilKilled: true,
  }));
  const spawner = makeSandboxSpawner(slice);
  const childProcess = await spawner(['yes'], { maxOutputBytes: 10 });
  await childProcess.kill('SIGKILL');
  t.deepEqual(await childProcess.wait(), { code: null, signal: 'SIGKILL' });
});

test('a containment failure after a requested kill rejects both kill() and wait()', async t => {
  const failure = Error('sandbox cleanup could not prove containment');
  const { slice } = makeFakeSlice(() => ({ killRejectsWith: failure }));
  const spawner = makeSandboxSpawner(slice);
  const childProcess = await spawner(['sleep', '60']);
  await t.throwsAsync(() => childProcess.kill('SIGTERM'), {
    message: /could not prove containment/,
  });
  await t.throwsAsync(() => childProcess.wait(), {
    message: /could not prove containment/,
  });
});

test('a slice timeout reaches wait() unchanged, even after a slow admission', async t => {
  /** @type {() => void} */
  let admit = () => {};
  const admission = new Promise(resolve => {
    admit = () => resolve(undefined);
  });
  const { slice } = makeFakeSlice(() => ({
    admission,
    rejectWith: Error('sandbox process timed out after 50ms'),
  }));
  const spawner = makeSandboxSpawner(slice);
  const spawned = spawner(['sleep', '60'], { timeoutMs: 50 });
  // The slice's timer started during admission; however long admission
  // took, the adapter reports the slice's own cause, never a guess.
  await new Promise(resolve => setTimeout(resolve, 80));
  admit();
  const childProcess = await spawned;
  await t.throwsAsync(() => childProcess.wait(), {
    message: 'sandbox process timed out after 50ms',
  });
});

test('a slice output-guard termination reaches wait() unchanged', async t => {
  const { slice } = makeFakeSlice(() => ({
    stdout: ['x'.repeat(11)],
    rejectWith: Error('sandbox stdout failure requires process termination'),
  }));
  const spawner = makeSandboxSpawner(slice, { outputByteLimit: 11n });
  const childProcess = await spawner(['yes'], { maxOutputBytes: 10 });
  await t.throwsAsync(() => childProcess.wait(), {
    message: /requires process termination/,
  });
});

test('an unexplained slice failure still rejects wait()', async t => {
  const { slice } = makeFakeSlice(() => ({
    rejectWith: Error('sandbox dispose could not prove containment'),
  }));
  const spawner = makeSandboxSpawner(slice);
  const childProcess = await spawner(['true'], { maxOutputBytes: 10 });
  await t.throwsAsync(() => childProcess.wait(), { message: /containment/ });
});

test('kill rejects a non-termination signal', async t => {
  const { slice, kills } = makeFakeSlice(() => ({ untilKilled: true }));
  const spawner = makeSandboxSpawner(slice);
  const childProcess = await spawner(['sleep', '60']);
  t.throws(() => childProcess.kill('SIGUSR1'), {
    message: /Unsupported sandbox termination signal/,
  });
  t.deepEqual(kills, []);
});

test('output past any cap arrives whole, in order, with a natural exit, however it is chunked', async t => {
  // The caller truncates; the adapter must neither terminate the process
  // nor drop or reorder bytes at a cap-dependent point.  A host process that
  // writes the same bytes behaves the same way.
  await fc.assert(
    fc.asyncProperty(
      fc
        .integer({ min: 1, max: 4096 })
        .chain(cap =>
          fc.tuple(
            fc.constant(cap),
            fc.uniqueArray(fc.integer({ min: 1, max: cap }), { maxLength: 8 }),
          ),
        ),
      async ([cap, cuts]) => {
        const total = cap + 1;
        const bytes = new Uint8Array(total);
        for (let index = 0; index < total; index += 1) {
          bytes[index] = 0x61 + (index % 26);
        }
        const bounds = [0, ...[...cuts].sort((a, b) => a - b), total];
        const chunks = [];
        for (let index = 1; index < bounds.length; index += 1) {
          chunks.push(bytes.slice(bounds[index - 1], bounds[index]));
        }
        const { slice, kills } = makeFakeSlice(() => ({
          stdout: chunks,
          status: { code: 0, signal: null },
        }));
        const childProcess = await makeSandboxSpawner(slice)(['emit'], {
          maxOutputBytes: cap,
        });
        const [stdout, , status] = await Promise.all([
          drain(childProcess.stdout),
          drain(childProcess.stderr),
          childProcess.wait(),
        ]);
        return (
          stdout === new TextDecoder().decode(bytes) &&
          status.code === 0 &&
          status.signal === null &&
          kills.length === 0
        );
      },
    ),
    { numRuns: 100 },
  );
  t.pass();
});
