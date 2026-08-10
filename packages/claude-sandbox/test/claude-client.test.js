// @ts-nocheck
/* eslint-disable import/order, no-empty-function */

import '@endo/init';
import test from 'ava';
import { iterateReader } from '@endo/exo-stream/iterate-reader.js';

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

/**
 * Build an AsyncIterable<Uint8Array> from a list of byte chunks.
 * @param chunks
 */
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
 * @param outputs
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
  for await (const value of iterateReader(reader)) {
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

  // The reader yields the parsed stream-json events, then a terminal
  // `{ type: 'end' }`.
  t.deepEqual(events, [
    { type: 'system' },
    { type: 'result' },
    { type: 'end' },
  ]);
  t.is(fake.spawned.length, 1);
  const { argv, opts } = fake.spawned[0];
  t.is(argv[0], 'claude');
  t.is(argv[1], '-p');
  t.is(argv[2], 'do a thing');
  t.true(argv.includes('--output-format'));
  t.true(argv.includes('stream-json'));
  t.true(argv.includes('--include-partial-messages'));
  t.true(argv.includes('--dangerously-skip-permissions'));
  t.is(opts.cwd, '/workspace');
  // First send has no conversation to resume.
  t.false(argv.includes('--continue'));
});

test('resumePriorConversation makes the first send use --continue', async t => {
  const fake = makeFakeSlice([[]]);
  const client = makeClaudeClient(
    baseArgs(fake, makeFakeMount(), { resumePriorConversation: true }),
  );
  await drain(await client.send('after restart'));
  t.is(fake.spawned.length, 1);
  // A session reincarnated after a daemon restart, whose persistent config dir
  // already held a transcript, resumes it on its very first post-restart turn
  // rather than forking a fresh, context-free conversation.
  t.true(fake.spawned[0].argv.includes('--continue'));
  const status = await client.status();
  t.true(status.conversationStarted);
});

test('an mcpConfigPath adds --mcp-config and --strict-mcp-config', async t => {
  const fake = makeFakeSlice([[]]);
  const client = makeClaudeClient(
    baseArgs(fake, makeFakeMount(), {
      mcpConfigPath: '/endo-mcp/mcp.json',
    }),
  );
  await drain(await client.send('do a thing'));
  const { argv } = fake.spawned[0];
  t.true(argv.includes('--mcp-config'));
  t.is(argv[argv.indexOf('--mcp-config') + 1], '/endo-mcp/mcp.json');
  t.true(argv.includes('--strict-mcp-config'));
});

test('without an mcpConfigPath no MCP flags are passed', async t => {
  const fake = makeFakeSlice([[]]);
  const client = makeClaudeClient(baseArgs(fake, makeFakeMount()));
  await drain(await client.send('do a thing'));
  t.false(fake.spawned[0].argv.includes('--mcp-config'));
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

test('a constructor systemPrompt adds --append-system-prompt to every spawn', async t => {
  const fake = makeFakeSlice([[], []]);
  const client = makeClaudeClient(
    baseArgs(fake, makeFakeMount(), { systemPrompt: 'You are Floot.' }),
  );

  await drain(await client.send('first'));
  await drain(await client.send('second'));

  t.is(fake.spawned.length, 2);
  for (const proc of fake.spawned) {
    const i = proc.argv.indexOf('--append-system-prompt');
    t.true(i !== -1, 'argv carries --append-system-prompt');
    t.is(proc.argv[i + 1], 'You are Floot.');
  }
});

test('a per-turn systemPrompt overrides the constructor default', async t => {
  const fake = makeFakeSlice([[]]);
  const client = makeClaudeClient(
    baseArgs(fake, makeFakeMount(), { systemPrompt: 'default persona' }),
  );
  await drain(await client.send('hi', { systemPrompt: 'turn persona' }));
  const { argv } = fake.spawned[0];
  const i = argv.indexOf('--append-system-prompt');
  t.is(argv[i + 1], 'turn persona');
});

test('without a systemPrompt no --append-system-prompt is passed', async t => {
  const fake = makeFakeSlice([[]]);
  const client = makeClaudeClient(baseArgs(fake, makeFakeMount()));
  await drain(await client.send('do a thing'));
  t.false(fake.spawned[0].argv.includes('--append-system-prompt'));
});

test('overlapping sends queue and run in order (serialized)', async t => {
  const fake = makeFakeSlice([[], []]);
  const client = makeClaudeClient(baseArgs(fake, makeFakeMount()));

  // Fire both sends before draining the first; they must serialize, not race.
  const r1 = await client.send('first');
  const r2 = await client.send('second');
  await drain(r1);
  await drain(r2);

  t.is(fake.spawned.length, 2);
  t.is(fake.spawned[0].argv[2], 'first');
  t.is(fake.spawned[1].argv[2], 'second');
  // The second turn ran strictly after the first, so it resumes with
  // --continue. A concurrent race would not guarantee this.
  t.false(fake.spawned[0].argv.includes('--continue'));
  t.true(fake.spawned[1].argv.includes('--continue'));
});

test('a stream error surfaces as an abort terminal event', async t => {
  const fake = makeFakeSlice([[enc.encode('not json\n')]]);
  const client = makeClaudeClient(baseArgs(fake, makeFakeMount()));

  const events = await drain(await client.send('x'));
  const last = events[events.length - 1];
  t.is(last.type, 'abort');
  t.regex(last.reason, /malformed stream-json line/);
});

test('interrupt() throws when idle and closes-and-kills the in-flight turn', async t => {
  // Before any send there is nothing to interrupt.
  const idle = makeClaudeClient(baseArgs(makeFakeSlice(), makeFakeMount()));
  await t.throwsAsync(() => idle.interrupt(), {
    message: /no in-flight prompt to interrupt/,
  });

  // A turn whose stdout yields one event then blocks, so the turn stays
  // in-flight long enough to interrupt it.
  let unblock;
  const blocked = new Promise(resolve => {
    unblock = resolve;
  });
  const blockingStdout = harden({
    async *[Symbol.asyncIterator]() {
      yield enc.encode('{"type":"system"}\n');
      await blocked;
    },
  });
  const fake = makeFakeSlice();
  const client = makeClaudeClient(
    baseArgs(fake, makeFakeMount(), {
      makeStdoutIterable: () => blockingStdout,
    }),
  );

  const reader = await client.send('work');
  // Pulling the first event proves the turn spawned and is producing.
  const replies = iterateReader(reader);
  const first = await replies.next();
  t.is(first.value.type, 'system');

  await client.interrupt();
  t.true(procKilled.get(fake.spawned[0]));

  unblock(); // let the (now-orphaned) producer task drain and exit
});

test('interrupt() with a queued turn kills the in-flight turn, not the queued one', async t => {
  let unblock;
  const blocked = new Promise(resolve => {
    unblock = resolve;
  });
  const blockingStdout = harden({
    async *[Symbol.asyncIterator]() {
      yield enc.encode('{"type":"system"}\n');
      await blocked;
    },
  });
  const fake = makeFakeSlice();
  const client = makeClaudeClient(
    baseArgs(fake, makeFakeMount(), {
      makeStdoutIterable: () => blockingStdout,
    }),
  );

  const rA = await client.send('A'); // becomes in-flight
  await client.send('B'); // queues behind A (does not spawn yet)
  const first = await iterateReader(rA).next();
  t.is(first.value.type, 'system'); // A is producing
  t.is(fake.spawned.length, 1, 'only the in-flight turn has spawned');

  await client.interrupt();
  // interrupt targeted the in-flight A (killing its process), not the
  // still-queued B — which would previously have been closed instead.
  t.true(procKilled.get(fake.spawned[0]));

  unblock();
});

test('a stream-error abort folds claude stderr into the reason', async t => {
  // stdout emits a malformed line (→ abort); stderr carries the real
  // diagnostic, which must surface in the abort reason.
  const fake = makeFakeSlice([[enc.encode('not json\n')]]);
  const client = makeClaudeClient(
    baseArgs(fake, makeFakeMount(), {
      makeStderrIterable: () =>
        bytesIterable([
          enc.encode('claude: authentication_error: invalid api key\n'),
        ]),
    }),
  );

  const events = await drain(await client.send('x'));
  const last = events[events.length - 1];
  t.is(last.type, 'abort');
  t.regex(last.reason, /malformed stream-json line/);
  t.regex(last.reason, /authentication_error: invalid api key/);
  // The process is killed before stderr is read (so the captured stream EOFs).
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

test('a lazy provision thunk runs once on first send and is reused', async t => {
  const fake = makeFakeSlice([[], []]);
  const mount = makeFakeMount();
  let provisionCount = 0;
  const client = makeClaudeClient({
    sessionId: 'sess-lazy',
    createdAt: '2026-01-01T00:00:00.000Z',
    workspaceMountPoint: '/tmp/claude-sandbox-sess-lazy',
    backend: 'podman',
    makeStdoutIterable,
    provision: async () => {
      provisionCount += 1;
      return { slice: fake.slice, mountHandle: mount.handle };
    },
  });

  // Not provisioned until first use.
  t.is(provisionCount, 0);
  await drain(await client.send('one'));
  await drain(await client.send('two'));
  t.is(provisionCount, 1);
  t.is(fake.spawned.length, 2);

  // terminate tears down what the thunk provisioned.
  await client.terminate();
  t.true(fake.isDisposed());
  t.true(mount.isUnmounted());
});

test('terminate() before any lazy provision creates nothing', async t => {
  let provisionCount = 0;
  const client = makeClaudeClient({
    sessionId: 'sess-noop',
    createdAt: '2026-01-01T00:00:00.000Z',
    workspaceMountPoint: '/tmp/claude-sandbox-sess-noop',
    backend: 'podman',
    makeStdoutIterable,
    provision: async () => {
      provisionCount += 1;
      return { slice: makeFakeSlice().slice };
    },
  });
  await client.terminate();
  t.is(provisionCount, 0);
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

test('detectPriorConversation decides --continue per spawn', async t => {
  const fake = makeFakeSlice([[], [], []]);
  let persisted = false;
  const client = makeClaudeClient(
    baseArgs(fake, makeFakeMount(), {
      detectPriorConversation: () => persisted,
    }),
  );

  // First turn: no transcript yet → fresh conversation.
  await drain(await client.send('first'));
  t.false(fake.spawned[0].argv.includes('--continue'));

  // Simulate claude having persisted the first turn's transcript.
  persisted = true;
  await drain(await client.send('second'));
  t.true(fake.spawned[1].argv.includes('--continue'));

  // Transcript gone again (e.g. config dir wiped) → detector wins over the
  // in-memory conversationStarted flag, so the turn does not pass a
  // --continue that has nothing to resume.
  persisted = false;
  await drain(await client.send('third'));
  t.false(fake.spawned[2].argv.includes('--continue'));
});

test('a first turn killed before claude persisted does not poison the next with --continue', async t => {
  // The in-memory flag alone would flip to true after the first spawn even
  // when the process was killed before writing a transcript; the detector
  // (still reporting no transcript) must override it.
  const fake = makeFakeSlice([[], []]);
  const client = makeClaudeClient(
    baseArgs(fake, makeFakeMount(), {
      detectPriorConversation: () => false,
    }),
  );
  await drain(await client.send('killed early'));
  await drain(await client.send('retry'));
  t.is(fake.spawned.length, 2);
  t.false(fake.spawned[0].argv.includes('--continue'));
  t.false(fake.spawned[1].argv.includes('--continue'));
});

test('a detector throw falls back to the in-memory flag', async t => {
  const fake = makeFakeSlice([[], []]);
  const client = makeClaudeClient(
    baseArgs(fake, makeFakeMount(), {
      detectPriorConversation: () => {
        throw new Error('EACCES');
      },
    }),
  );
  await drain(await client.send('first'));
  await drain(await client.send('second'));
  t.false(fake.spawned[0].argv.includes('--continue'));
  t.true(fake.spawned[1].argv.includes('--continue'));
});

test('initialPrompt is skipped when a prior conversation exists', async t => {
  // The prompt rides in the formula env, so a reincarnated formula would
  // otherwise re-fire it as a spurious extra turn on every daemon restart.
  const fake = makeFakeSlice([[]]);
  const client = makeClaudeClient(
    baseArgs(fake, makeFakeMount(), {
      initialPrompt: 'hello',
      detectPriorConversation: () => true,
    }),
  );
  await drain(await client.send('next'));
  t.is(fake.spawned.length, 1);
  t.is(fake.spawned[0].argv[2], 'next');
  t.true(fake.spawned[0].argv.includes('--continue'));
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

// ---------------------------------------------------------------------------
// Runtime extra mounts: recreate concurrency (designs/runtime-container-fs-mount.md)
// ---------------------------------------------------------------------------

test('terminate() racing a mount recreate never re-provisions', async t => {
  t.timeout(10_000);
  let provisionCount = 0;
  let releaseDispose;
  const disposeGate = new Promise(r => {
    releaseDispose = r;
  });
  let disposeStarted;
  const disposeStartedP = new Promise(r => {
    disposeStarted = r;
  });
  const makeSlice = () => ({
    async spawn() {
      const proc = {
        async stdout() {
          return harden({ kind: 'fake-stdout' });
        },
        async kill() {},
        async wait() {
          return harden({ code: 0, signal: null });
        },
      };
      procOut.set(proc, []);
      return proc;
    },
    async dispose() {
      disposeStarted();
      await disposeGate;
    },
  });
  const client = makeClaudeClient({
    sessionId: 'race-term',
    createdAt: 'now',
    workspaceMountPoint: '/tmp/x',
    workspacePath: '/workspace',
    backend: 'podman',
    makeStdoutIterable,
    provision: async () => {
      provisionCount += 1;
      return { slice: makeSlice() };
    },
  });
  await drain(await client.send('one'));
  t.is(provisionCount, 1);

  // Start a recreate; while its teardown is disposing the old slice,
  // terminate the client. The recreate must NOT re-provision afterwards —
  // that container (and its credential grant) would have no owner left to
  // release it.
  const applied = client.setExtraMounts(
    harden([{ cap: harden({}), innerPath: '/mnt/x', mode: 'rw' }]),
  );
  await disposeStartedP;
  const terminated = client.terminate();
  releaseDispose();
  await applied;
  await terminated;
  t.is(provisionCount, 1);
  await t.throwsAsync(() => client.send('after'), {
    message: /is terminated/,
  });
});

test('a send racing a mount recreate waits for the teardown gate', async t => {
  t.timeout(10_000);
  const log = [];
  let provisionCount = 0;
  let releaseUnmount;
  const unmountGate = new Promise(r => {
    releaseUnmount = r;
  });
  let unmountStarted;
  const unmountStartedP = new Promise(r => {
    unmountStarted = r;
  });
  const makeLoggedSlice = n => ({
    async spawn() {
      log.push(`spawn@${n}`);
      const proc = {
        async stdout() {
          return harden({ kind: 'fake-stdout' });
        },
        async kill() {},
        async wait() {
          return harden({ code: 0, signal: null });
        },
      };
      procOut.set(proc, []);
      return proc;
    },
    async dispose() {
      log.push(`dispose@${n}`);
    },
  });
  const client = makeClaudeClient({
    sessionId: 'race-gate',
    createdAt: 'now',
    workspaceMountPoint: '/tmp/x',
    workspacePath: '/workspace',
    backend: 'podman',
    makeStdoutIterable,
    provision: async extras => {
      provisionCount += 1;
      const n = provisionCount;
      log.push(`provision@${n}:${extras.map(e => e.innerPath).join(',')}`);
      return {
        slice: makeLoggedSlice(n),
        mountHandle: {
          async unmount() {
            log.push(`unmount-start@${n}`);
            if (n === 1) {
              unmountStarted();
              await unmountGate;
            }
            log.push(`unmount-end@${n}`);
          },
        },
      };
    },
  });
  await drain(await client.send('one'));

  const applied = client.setExtraMounts(
    harden([{ cap: harden({}), innerPath: '/mnt/r', mode: 'rw' }]),
  );
  await unmountStartedP; // the old workspace unmount is in progress
  const sendP = client.send('two'); // races the recreate
  await new Promise(r => setTimeout(r, 20));
  // The gate holds: no provision may overlap the teardown, or the fresh 9P
  // mounts could be unmounted by the old slice's teardown.
  t.is(provisionCount, 1);
  releaseUnmount();
  await applied;
  const events = await drain(await sendP);
  t.is(events[events.length - 1].type, 'end');
  t.is(provisionCount, 2);
  t.true(log.indexOf('unmount-end@1') < log.indexOf('provision@2:/mnt/r'));
  // The racing turn spawned in the NEW slice.
  t.true(log.includes('spawn@2'));
});

test('a turn killed by a mount recreate aborts with the recreate-labelled reason', async t => {
  t.timeout(10_000);
  let unblockStdout;
  const blocked = new Promise(r => {
    unblockStdout = r;
  });
  let releaseProvision;
  const provisionGate = new Promise(r => {
    releaseProvision = r;
  });
  let provisionCount = 0;
  const client = makeClaudeClient({
    sessionId: 'label',
    createdAt: 'now',
    workspaceMountPoint: '/tmp/x',
    workspacePath: '/workspace',
    backend: 'podman',
    makeStdoutIterable: () =>
      harden({
        async *[Symbol.asyncIterator]() {
          yield enc.encode('{"type":"system"}\n');
          await blocked; // in flight until the recreate disposes the slice
        },
      }),
    provision: async () => {
      provisionCount += 1;
      if (provisionCount === 2) {
        // Hold the re-mint open so the killed turn's abort is pushed while
        // the recreate is still in progress.
        await provisionGate;
      }
      return {
        slice: {
          async spawn() {
            return {
              async stdout() {
                return harden({ kind: 'fake-stdout' });
              },
              async kill() {
                unblockStdout();
              },
              async wait() {
                return harden({ code: null, signal: 'SIGKILL' });
              },
            };
          },
          async dispose() {
            unblockStdout(); // disposing the slice kills the process
          },
        },
      };
    },
  });
  const it = iterateReader(await client.send('work'));
  t.is((await it.next()).value.type, 'system'); // the turn is in flight
  const applied = client.setExtraMounts(
    harden([{ cap: harden({}), innerPath: '/mnt/z', mode: 'rw' }]),
  );
  const rest = [];
  for await (const ev of it) {
    rest.push(ev);
  }
  const last = rest[rest.length - 1];
  t.is(last.type, 'abort');
  t.regex(last.reason, /container mount set changed; sandbox slice recreated/);
  t.regex(last.reason, /killed by SIGKILL/);
  releaseProvision();
  await applied;
  t.is(provisionCount, 2);
});

test('setExtraMounts refuses eager and terminated clients without recording', async t => {
  // Eager client (no provision thunk): there is no way to recreate the
  // slice, and the refused set must not leak into status()/terminate().
  const fake = makeFakeSlice([[]]);
  const mount = makeFakeMount();
  const eager = makeClaudeClient(baseArgs(fake, mount));
  await t.throwsAsync(
    () =>
      eager.setExtraMounts(
        harden([{ cap: harden({}), innerPath: '/mnt/x', mode: 'rw' }]),
      ),
    { message: /require a lazily-provisioned client/ },
  );
  t.deepEqual((await eager.status()).extraMounts, []);

  // Terminated client: refused before any provisioning.
  let provisions = 0;
  const lazy = makeClaudeClient({
    sessionId: 'dead',
    createdAt: 'now',
    workspaceMountPoint: '/tmp/x',
    backend: 'podman',
    makeStdoutIterable,
    provision: async () => {
      provisions += 1;
      return { slice: makeFakeSlice([]).slice };
    },
  });
  await lazy.terminate();
  await t.throwsAsync(
    () =>
      lazy.setExtraMounts(
        harden([{ cap: harden({}), innerPath: '/mnt/x', mode: 'rw' }]),
      ),
    { message: /is terminated/ },
  );
  t.is(provisions, 0);
});
