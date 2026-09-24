// @ts-check
import '@endo/init';
import test from 'ava';
import { bytesReaderFromIterator } from '@endo/exo-stream/bytes-reader-from-iterator.js';
import { bytesWriterFromIterator } from '@endo/exo-stream/bytes-writer-from-iterator.js';
import { makeNativeContextTransport } from '../src/native-context-transport.js';

const gate = () => {
  let release;
  const promise = new Promise(resolve => {
    release = resolve;
  });
  return { promise, release };
};
const tick = () => new Promise(resolve => setImmediate(resolve));
const fixture = (options = {}) => {
  const writes = [];
  const spawned = [];
  let kills = 0;
  let waits = 0;
  let killFailures = Number(options.killFailures || 0);
  const reader = texts =>
    bytesReaderFromIterator(texts.map(text => new TextEncoder().encode(text)));
  const proc = harden({
    async stdin() {
      await options.stdinGate;
      if (options.stdinFailure) throw Error('SENSITIVE native input');
      return bytesWriterFromIterator({
        async next(bytes) {
          writes.push(new TextDecoder().decode(bytes));
          return { done: false, value: undefined };
        },
        async return() {
          return { done: true, value: undefined };
        },
      });
    },
    async stdout() {
      await options.outputGate;
      return reader(options.stdout || ['{"result":{"payload":"exact 猫"}}\n']);
    },
    async stderr() {
      return reader(options.stderr || ['SENSITIVE native stderr']);
    },
    async wait() {
      waits += 1;
      await options.waitGate;
      return options.status || { code: 0, signal: null };
    },
    async kill() {
      kills += 1;
      if (killFailures > 0) {
        killFailures -= 1;
        throw Error('SENSITIVE kill error');
      }
      options.onKill?.();
    },
  });
  const slice = harden({
    async spawn(argv, opts) {
      spawned.push({ argv, opts });
      await options.spawnGate;
      return proc;
    },
  });
  return {
    io: makeNativeContextTransport({ slice, cwd: '/workspace' }),
    writes,
    spawned,
    counts: () => ({ kills, waits }),
  };
};

test('helper is inert, sends bounded JSON through stdin, returns exact data and reaps', async t => {
  await null;
  const f = fixture();
  t.is(f.spawned.length, 0);
  t.deepEqual(await f.io.capture({ sessionId: 'test' }), {
    payload: 'exact 猫',
  });
  t.deepEqual(JSON.parse(f.writes[0]), {
    operation: 'capture',
    request: { sessionId: 'test' },
  });
  t.deepEqual(f.spawned[0].argv, ['node', '/opt/endo/context-command.mjs']);
  t.is(f.spawned[0].opts.env.CODEX_HOME, '/codex-home');
  t.is(f.spawned[0].opts.cwd, '/workspace');
  t.deepEqual(f.counts(), { kills: 0, waits: 1 });
  await f.io.close();
  await t.throwsAsync(f.io.capture({}), { message: /closed failed/ });
});

test('oversized UTF-8 input refuses before spawn', async t => {
  const f = fixture();
  await t.throwsAsync(f.io.restore({ payload: '猫'.repeat(6 * 1024 * 1024) }), {
    message: /input failed/,
  });
  t.is(f.spawned.length, 0);
});

for (const options of [
  { stdout: ['SENSITIVE malformed JSON'] },
  { stdout: ['{"result":null}'] },
  { stdout: ['{"result":{},"extra":true}'] },
  { stdout: ['x'.repeat(16 * 1024 * 1024 + 1)] },
  { stderr: ['x'.repeat(16 * 1024 + 1)] },
  { stdinFailure: true },
  { status: { code: 1, signal: null } },
  { status: {} },
  { status: { code: 0, signal: 'SIGTERM' } },
]) {
  test(`helper refuses bad exchange ${JSON.stringify(options).slice(0, 80)}`, async t => {
    const f = fixture(options);
    const error = await t.throwsAsync(f.io.capture({}), {
      message: /^Codex native context .* failed$/,
    });
    t.false(error.message.includes('SENSITIVE'));
    t.true(f.counts().waits >= 1);
    await f.io.close();
  });
}

test('cancel retains late spawn custody and does not cancel the next call', async t => {
  t.timeout(5000);
  const spawn = gate();
  const f = fixture({ spawnGate: spawn.promise });
  t.teardown(() => spawn.release());
  const operation = f.io.capture({});
  const aborted = t.throwsAsync(operation, { message: /cancelled failed/ });
  const cancellation = f.io.cancel();
  await t.throwsAsync(f.io.capture({}), { message: /busy failed/ });
  await tick();
  t.is(f.counts().kills, 0);
  spawn.release();
  await cancellation;
  await aborted;
  t.is(f.counts().kills, 1);
  t.is(f.counts().waits, 1);
  t.is(f.writes.length, 0);
  t.deepEqual(await f.io.capture({}), { payload: 'exact 猫' });
});

test('close during stdin acquisition reaps and forbids a late write', async t => {
  t.timeout(5000);
  const stdin = gate();
  const f = fixture({
    stdinGate: stdin.promise,
    onKill: () => stdin.release(),
  });
  t.teardown(() => stdin.release());
  const operation = f.io.restore({});
  const aborted = t.throwsAsync(operation, { message: /cancelled failed/ });
  await tick();
  await f.io.close();
  await aborted;
  stdin.release();
  await tick();
  t.is(f.writes.length, 0);
  t.is(f.counts().kills, 1);
  await t.throwsAsync(f.io.restore({}), { message: /closed failed/ });
});

test('cancel waits for reaping and retains failed kill for close retry', async t => {
  t.timeout(5000);
  const output = gate();
  const wait = gate();
  const f = fixture({
    outputGate: output.promise,
    waitGate: wait.promise,
    killFailures: 1,
  });
  t.teardown(() => {
    output.release();
    wait.release();
  });
  const operation = f.io.capture({});
  const failed = t.throwsAsync(operation, { message: /cleanup failed/ });
  await tick();
  await t.throwsAsync(f.io.cancel(), { message: /cleanup failed/ });
  await failed;
  let closed = false;
  const closing = f.io.close().then(() => {
    closed = true;
  });
  await tick();
  t.false(closed);
  wait.release();
  await tick();
  t.false(closed);
  output.release();
  await closing;
  t.is(f.counts().kills, 2);
});

test('cancel retains admission until reaped helper IO continuations settle', async t => {
  t.timeout(5000);
  const output = gate();
  const f = fixture({ outputGate: output.promise });
  t.teardown(() => output.release());
  const operation = f.io.capture({});
  const aborted = t.throwsAsync(operation, { message: /cancelled failed/ });
  await tick();
  let cancelled = false;
  const cancellation = f.io.cancel().then(() => {
    cancelled = true;
  });
  await tick();
  t.is(f.counts().kills, 1);
  t.false(cancelled);
  await t.throwsAsync(f.io.capture({}), { message: /busy failed/ });
  output.release();
  await cancellation;
  await aborted;
  t.deepEqual(await f.io.capture({}), { payload: 'exact 猫' });
});
