// @ts-nocheck
/* eslint-disable import/order, no-empty-function */

import '@endo/init';
import test from 'ava';

import {
  makeClaudeClient,
  parseStreamJsonLines,
} from '../src/claude-client.js';

// `E(target)` deep-hardens its target, so anything reachable from an
// object we pass through `E()` (the slice, a ProcessHandle, the mount
// handle) becomes frozen. Recorders therefore live in module-level
// WeakMaps / closures that harden never traverses, rather than as
// properties on those objects.
const procOut = new WeakMap(); // proc -> stdout byte chunks
const procKilled = new WeakMap(); // proc -> boolean

const enc = new TextEncoder();

/** Build an AsyncIterable<Uint8Array> from a list of byte chunks. */
const bytesIterable = chunks =>
  harden({
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks || []) {
        yield chunk;
      }
    },
  });

/**
 * Fake sandbox slice. `outputs[i]` is the list of stdout byte chunks
 * the i-th spawned process emits. The returned wrapper exposes
 * recorders that are *not* reachable from the slice/proc objects.
 */
const makeFakeSlice = (outputs = []) => {
  const spawned = [];
  let i = 0;
  let disposed = false;
  const slice = {
    async spawn(argv, opts) {
      const out = outputs[i] || [];
      i += 1;
      const proc = {
        argv: [...argv],
        opts,
        async stdout() {
          return harden({ kind: 'fake-stdout' });
        },
        async kill() {
          procKilled.set(proc, true);
        },
        async wait() {
          return harden({ code: 0, signal: null });
        },
      };
      procOut.set(proc, out);
      spawned.push(proc);
      return proc;
    },
    async dispose() {
      disposed = true;
    },
  };
  return { slice, spawned, isDisposed: () => disposed };
};

const makeFakeMount = () => {
  let unmounted = false;
  return {
    handle: {
      async unmount() {
        unmounted = true;
      },
    },
    isUnmounted: () => unmounted,
  };
};

// Inject a stdout adapter that reads the fake proc's chunks directly,
// bypassing the @endo/exo-stream base64 wire protocol.
const makeStdoutIterable = proc => bytesIterable(procOut.get(proc));

const baseArgs = (fake, mount, extra = {}) => ({
  sessionId: 'sess-0001',
  createdAt: '2026-01-01T00:00:00.000Z',
  slice: fake.slice,
  mountHandle: mount.handle,
  workspaceMountPoint: '/tmp/claude-sandbox-sess-0001',
  workspacePath: '/workspace',
  backend: 'podman',
  rootfsLabel: 'oci:example/claude:latest',
  makeStdoutIterable,
  ...extra,
});

const drain = async reader => {
  const events = [];
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const { done, value } = await reader.next();
    if (done) break;
    events.push(value);
  }
  return events;
};

test('parseStreamJsonLines parses newline-delimited JSON across chunk boundaries', async t => {
  const chunks = [
    enc.encode('{"type":"system"}\n{"type":"assi'),
    enc.encode('stant","text":"hi"}\n'),
    enc.encode('{"type":"result"}\n'),
  ];
  const events = [];
  for await (const e of parseStreamJsonLines(bytesIterable(chunks))) {
    events.push(e);
  }
  t.deepEqual(events, [
    { type: 'system' },
    { type: 'assistant', text: 'hi' },
    { type: 'result' },
  ]);
});

test('parseStreamJsonLines yields a trailing line with no newline', async t => {
  const events = [];
  for await (const e of parseStreamJsonLines(
    bytesIterable([enc.encode('{"type":"result"}')]),
  )) {
    events.push(e);
  }
  t.deepEqual(events, [{ type: 'result' }]);
});

test('parseStreamJsonLines throws on a malformed line', async t => {
  await t.throwsAsync(
    async () => {
      // eslint-disable-next-line no-unused-vars
      for await (const _ of parseStreamJsonLines(
        bytesIterable([enc.encode('not json\n')]),
      )) {
        // drain
      }
    },
    { message: /malformed stream-json line/ },
  );
});

test('send() spawns claude -p with stream-json and yields parsed events', async t => {
  const fake = makeFakeSlice([
    [enc.encode('{"type":"system"}\n{"type":"result"}\n')],
  ]);
  const client = makeClaudeClient(baseArgs(fake, makeFakeMount()));

  const reader = await client.send('do a thing');
  const events = await drain(reader);

  t.deepEqual(events, [{ type: 'system' }, { type: 'result' }]);
  t.is(fake.spawned.length, 1);
  const { argv, opts } = fake.spawned[0];
  t.is(argv[0], 'claude');
  t.is(argv[1], '-p');
  t.is(argv[2], 'do a thing');
  t.true(argv.includes('--output-format'));
  t.true(argv.includes('stream-json'));
  t.is(opts.cwd, '/workspace');
  // First send has no conversation to resume.
  t.false(argv.includes('--continue'));
});

test('send() adds --continue after the first turn and forwards --model', async t => {
  const fake = makeFakeSlice([[], []]);
  const client = makeClaudeClient(
    baseArgs(fake, makeFakeMount(), { model: 'claude-sonnet-4-6' }),
  );

  await drain(await client.send('first'));
  await drain(await client.send('second'));

  t.is(fake.spawned.length, 2);
  t.false(fake.spawned[0].argv.includes('--continue'));
  t.true(fake.spawned[1].argv.includes('--continue'));
  for (const proc of fake.spawned) {
    t.true(proc.argv.includes('--model'));
    t.true(proc.argv.includes('claude-sonnet-4-6'));
  }
});

test('interrupt() kills the in-flight process and throws when there is none', async t => {
  const fake = makeFakeSlice([[enc.encode('{"type":"system"}\n')]]);
  const client = makeClaudeClient(baseArgs(fake, makeFakeMount()));

  await t.throwsAsync(() => client.interrupt(), {
    message: /no in-flight prompt to interrupt/,
  });

  await client.send('work');
  await client.interrupt();
  t.true(procKilled.get(fake.spawned[0]));
});

test('terminate() disposes the slice, unmounts, and rejects subsequent send', async t => {
  const fake = makeFakeSlice([[]]);
  const mount = makeFakeMount();
  const client = makeClaudeClient(baseArgs(fake, mount));

  await client.terminate();

  t.true(fake.isDisposed());
  t.true(mount.isUnmounted());
  const status = await client.status();
  t.true(status.terminated);
  await t.throwsAsync(() => client.send('nope'), { message: /is terminated/ });
});

test('status() reports session metadata', async t => {
  const fake = makeFakeSlice();
  const client = makeClaudeClient(baseArgs(fake, makeFakeMount()));
  const status = await client.status();
  t.is(status.sessionId, 'sess-0001');
  t.is(status.createdAt, '2026-01-01T00:00:00.000Z');
  t.is(status.backend, 'podman');
  t.is(status.rootfs, 'oci:example/claude:latest');
  t.is(status.workspaceMountPoint, '/tmp/claude-sandbox-sess-0001');
  t.false(status.terminated);
  t.false(status.conversationStarted);
});

test('help() describes the ClaudeClient surface', async t => {
  const client = makeClaudeClient(baseArgs(makeFakeSlice(), makeFakeMount()));
  t.regex(client.help(), /ClaudeClient/);
  t.regex(client.help(), /send\(prompt/);
});

test('initialPrompt is fired and drained at construction', async t => {
  const fake = makeFakeSlice([[enc.encode('{"type":"result"}\n')], []]);
  const client = makeClaudeClient(
    baseArgs(fake, makeFakeMount(), { initialPrompt: 'hello' }),
  );

  // The next explicit send awaits the initial prompt's completion, so
  // by the time it resolves the initial spawn has already happened.
  await drain(await client.send('next'));

  t.is(fake.spawned.length, 2);
  t.is(fake.spawned[0].argv[2], 'hello');
  t.is(fake.spawned[1].argv[2], 'next');
  // The second turn continues the conversation started by the initial
  // prompt.
  t.true(fake.spawned[1].argv.includes('--continue'));
});
