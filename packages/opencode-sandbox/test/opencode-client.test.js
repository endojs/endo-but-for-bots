// @ts-check
/* eslint-disable no-await-in-loop */
import '@endo/init';
import test from 'ava';
import { iterateReader } from '@endo/exo-stream/iterate-reader.js';

import { makeOpencodeClient } from '../src/opencode-client.js';
import {
  planBrokerClient,
  resolveBridgeTurnTimeout,
  resolveBrokerTransport,
} from '../src/opencode-client-module.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

// `E(target)` deep-hardens its target, so anything reachable from an object
// we pass through `E()` (the slice, a ProcessHandle) becomes frozen.
// Recorders therefore live in module-level WeakMaps that harden never
// traverses, rather than as properties on those objects.
const stdoutFor = new WeakMap(); // proc -> AsyncIterable<Uint8Array>
const commandsFor = new WeakMap(); // proc -> string[]

/**
 * A fake in-slice bridge process: stdout is a push-driven byte stream and
 * stdin records decoded command lines.  The consumer (the client) starts
 * pulling when it spawns, so pushes land in order.
 */
const makeFakeBridge = () => {
  /** @type {Uint8Array[]} */
  const chunks = [];
  /** @type {Array<() => void>} */
  const waiters = [];
  let ended = false;
  const wake = () => {
    while (waiters.length > 0) {
      /** @type {() => void} */ (waiters.shift())();
    }
  };
  const iterable = harden({
    async *[Symbol.asyncIterator]() {
      for (;;) {
        while (chunks.length > 0) {
          yield /** @type {Uint8Array} */ (chunks.shift());
        }
        if (ended) return;
        await new Promise(resolve => waiters.push(() => resolve(undefined)));
      }
    },
  });
  /** @type {string[]} */
  const commands = [];
  let killed = false;
  const proc = harden({
    async kill() {
      killed = true;
      ended = true;
      wake();
    },
    async wait() {
      return harden({ code: 0, signal: null });
    },
  });
  stdoutFor.set(proc, iterable);
  commandsFor.set(proc, commands);
  return {
    proc,
    commands,
    push: line => {
      chunks.push(enc.encode(`${line}\n`));
      wake();
    },
    end: () => {
      ended = true;
      wake();
    },
    isKilled: () => killed,
  };
};

const makeFakeSlice = bridge => {
  /** @type {Array<{ argv: string[], opts: any }>} */
  const spawnCalls = [];
  let disposed = false;
  const slice = {
    async spawn(argv, opts) {
      spawnCalls.push({ argv: [...argv], opts });
      return bridge.proc;
    },
    async dispose() {
      disposed = true;
    },
  };
  return { slice, spawnCalls, isDisposed: () => disposed };
};

const emptyStderr = () =>
  harden({
    async *[Symbol.asyncIterator]() {
      // no stderr
    },
  });

const makeStdoutIterable = proc => /** @type {any} */ (stdoutFor.get(proc));
const makeStderrIterable = _proc => emptyStderr();
const makeStdinWriter = async proc => ({
  async next(bytes) {
    /** @type {string[]} */ (commandsFor.get(proc)).push(dec.decode(bytes));
    return harden({ done: false, value: undefined });
  },
  async return() {
    return harden({ done: true, value: undefined });
  },
});

const baseArgs = (fake, extra = {}) => ({
  sessionId: 'sess-0001',
  createdAt: '2026-01-01T00:00:00.000Z',
  slice: fake.slice,
  workspaceMountPoint: '/tmp/opencode-sandbox-sess-0001',
  workspacePath: '/workspace',
  statePath: '/opencode-state',
  backend: 'podman',
  rootfsLabel: 'oci:localhost/opencode:latest',
  makeStdoutIterable,
  makeStderrIterable,
  makeStdinWriter,
  ...extra,
});

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

const drain = async reader => {
  const events = [];
  for await (const value of iterateReader(reader)) {
    events.push(value);
  }
  return events;
};

const readyLine = sessionId =>
  JSON.stringify({ type: 'ready', sessionId, port: 4096 });

test('send spawns the baked bridge, writes a send command, and yields hosted events', async t => {
  const bridge = makeFakeBridge();
  const fake = makeFakeSlice(bridge);
  const client = makeOpencodeClient(baseArgs(fake));

  bridge.push(readyLine('ses_1'));
  const reader = await client.send('hello');
  await tick();

  t.deepEqual(fake.spawnCalls[0].argv, [
    'node',
    '/opt/opencode-bridge/bridge.mjs',
  ]);
  t.is(fake.spawnCalls[0].opts.cwd, '/workspace');
  t.deepEqual(bridge.commands, ['{"op":"send","text":"hello"}\n']);

  bridge.push(JSON.stringify({ type: 'phase', phase: 'busy' }));
  bridge.push(JSON.stringify({ type: 'text-delta', text: 'hi' }));
  bridge.push(JSON.stringify({ type: 'end' }));

  t.deepEqual(await drain(reader), [
    { type: 'phase', phase: 'busy' },
    { type: 'text-delta', text: 'hi' },
    { type: 'end' },
  ]);
  const status = await client.status();
  t.is(status.opencodeSessionId, 'ses_1');
  t.false(status.bridgeExited);
  t.true(status.bridgeRunning);
});

test('the bridge spawn argv is injectable', async t => {
  const bridge = makeFakeBridge();
  const fake = makeFakeSlice(bridge);
  const client = makeOpencodeClient(
    baseArgs(fake, {
      bridgeArgv: ['node', '/custom/bridge.mjs'],
    }),
  );
  bridge.push(readyLine('ses_1'));
  const reader = await client.send('x');
  bridge.push(JSON.stringify({ type: 'end' }));
  await drain(reader);
  t.deepEqual(fake.spawnCalls[0].argv, ['node', '/custom/bridge.mjs']);
});

test('concurrent sends queue and serialize with one terminal each', async t => {
  const bridge = makeFakeBridge();
  const fake = makeFakeSlice(bridge);
  const client = makeOpencodeClient(baseArgs(fake));

  bridge.push(readyLine('ses_1'));
  const readerA = await client.send('first');
  const readerB = await client.send('second');
  await tick();

  // Only the first turn has been written; the second queues behind its
  // terminal so the bridge never sees two sends at once.
  t.deepEqual(bridge.commands, ['{"op":"send","text":"first"}\n']);
  t.is((await client.status()).pendingPrompts, 1);

  bridge.push(JSON.stringify({ type: 'phase', phase: 'busy' }));
  bridge.push(JSON.stringify({ type: 'end' }));
  await tick();
  t.deepEqual(bridge.commands, [
    '{"op":"send","text":"first"}\n',
    '{"op":"send","text":"second"}\n',
  ]);

  bridge.push(JSON.stringify({ type: 'text-delta', text: 'two' }));
  bridge.push(JSON.stringify({ type: 'end' }));

  const eventsA = await drain(readerA);
  const eventsB = await drain(readerB);
  t.deepEqual(eventsA, [{ type: 'phase', phase: 'busy' }, { type: 'end' }]);
  t.deepEqual(eventsB, [{ type: 'text-delta', text: 'two' }, { type: 'end' }]);
});

test('interrupt writes the command and is a terminal barrier', async t => {
  const bridge = makeFakeBridge();
  const fake = makeFakeSlice(bridge);
  const client = makeOpencodeClient(baseArgs(fake));

  bridge.push(readyLine('ses_1'));
  const reader = await client.send('work');
  await tick();
  bridge.push(JSON.stringify({ type: 'phase', phase: 'busy' }));
  await tick();

  const interrupt = client.interrupt();
  await tick();
  t.deepEqual(bridge.commands, [
    '{"op":"send","text":"work"}\n',
    '{"op":"interrupt"}\n',
  ]);

  let barrierResolved = false;
  interrupt.then(() => {
    barrierResolved = true;
  });
  await tick();
  t.false(barrierResolved, 'barrier waits for the terminal');

  bridge.push(JSON.stringify({ type: 'abort', reason: 'interrupted' }));
  await interrupt;
  t.true(barrierResolved);
  t.deepEqual(await drain(reader), [
    { type: 'phase', phase: 'busy' },
    { type: 'abort', reason: 'interrupted' },
  ]);
});

test('interrupt refuses when no turn is in flight', async t => {
  const bridge = makeFakeBridge();
  const fake = makeFakeSlice(bridge);
  const client = makeOpencodeClient(baseArgs(fake));
  await t.throwsAsync(() => client.interrupt(), {
    message: /no in-flight prompt to interrupt/,
  });
});

test('a malformed stdout line fails the turn and poisons the bridge', async t => {
  const bridge = makeFakeBridge();
  const fake = makeFakeSlice(bridge);
  const client = makeOpencodeClient(baseArgs(fake));

  bridge.push(readyLine('ses_1'));
  const reader = await client.send('x');
  await tick();
  bridge.push('not json');

  const events = await drain(reader);
  const last = events[events.length - 1];
  t.is(last.type, 'abort');
  t.regex(last.reason, /malformed JSONL/);

  const status = await client.status();
  t.true(status.bridgeExited);
  // A client whose bridge exited fails closed: it never silently starts a
  // fresh opencode history under the same incarnation.
  await t.throwsAsync(() => client.send('again'), {
    message: /bridge exited/,
  });
});

test('a turn cannot change the session persona', async t => {
  const bridge = makeFakeBridge();
  const fake = makeFakeSlice(bridge);
  const client = makeOpencodeClient(
    baseArgs(fake, { systemPrompt: 'You are Floot.' }),
  );
  await t.throwsAsync(
    () => client.send('x', { systemPrompt: 'Someone else.' }),
    { message: /cannot change the session persona/ },
  );
  // The matching persona is accepted.
  bridge.push(readyLine('ses_1'));
  const reader = await client.send('x', { systemPrompt: 'You are Floot.' });
  bridge.push(JSON.stringify({ type: 'end' }));
  t.is((await drain(reader)).pop()?.type, 'end');
});

test('terminate disposes the slice, kills the bridge, and keeps state', async t => {
  const bridge = makeFakeBridge();
  const fake = makeFakeSlice(bridge);
  const stateRemovals = [];
  const client = makeOpencodeClient(
    baseArgs(fake, {
      removeState: async () => {
        stateRemovals.push('removed');
      },
    }),
  );

  bridge.push(readyLine('ses_1'));
  const reader = await client.send('x');
  await tick();
  await client.terminate();

  t.true(fake.isDisposed());
  t.true(bridge.isKilled());
  t.is((await client.status()).terminated, true);
  // A plain terminate/cancel must NOT delete durable state.
  t.deepEqual(stateRemovals, []);
  // The live turn is failed with a terminal rather than left hanging.
  t.is((await drain(reader)).pop()?.type, 'abort');
  await t.throwsAsync(() => client.send('nope'), {
    message: /is terminated/,
  });
});

test('destroy terminates and then deletes durable state once', async t => {
  const bridge = makeFakeBridge();
  const fake = makeFakeSlice(bridge);
  const stateRemovals = [];
  const client = makeOpencodeClient(
    baseArgs(fake, {
      removeState: async () => {
        stateRemovals.push('removed');
      },
    }),
  );

  await client.destroy();
  await client.destroy();
  t.deepEqual(stateRemovals, ['removed']);
  t.true(fake.isDisposed());
});

test('initialPrompt is fired and drained at construction', async t => {
  const bridge = makeFakeBridge();
  const fake = makeFakeSlice(bridge);
  const client = makeOpencodeClient(baseArgs(fake, { initialPrompt: 'hello' }));

  bridge.push(readyLine('ses_1'));
  // Let the initial turn dispatch.
  await tick();
  await tick();
  bridge.push(JSON.stringify({ type: 'end' }));

  // The explicit send awaits the initial turn's completion.
  const reader = await client.send('next');
  await tick();
  t.deepEqual(
    bridge.commands.map(line => JSON.parse(line).text),
    ['hello', 'next'],
  );
  bridge.push(JSON.stringify({ type: 'end' }));
  t.is((await drain(reader)).pop()?.type, 'end');
});

test.serial(
  'resolveBridgeTurnTimeout prefers the backend value, then the daemon env',
  t => {
    const previous = process.env.ENDO_OPENCODE_BRIDGE_TURN_TIMEOUT_MS;
    delete process.env.ENDO_OPENCODE_BRIDGE_TURN_TIMEOUT_MS;
    t.teardown(() => {
      if (previous === undefined) {
        delete process.env.ENDO_OPENCODE_BRIDGE_TURN_TIMEOUT_MS;
      } else {
        process.env.ENDO_OPENCODE_BRIDGE_TURN_TIMEOUT_MS = previous;
      }
    });
    t.is(
      resolveBridgeTurnTimeout({ OPENCODE_BRIDGE_TURN_TIMEOUT_MS: '60000' }),
      '60000',
    );
    process.env.ENDO_OPENCODE_BRIDGE_TURN_TIMEOUT_MS = '1200000';
    t.is(resolveBridgeTurnTimeout({}), '1200000');
    t.is(
      resolveBridgeTurnTimeout({ OPENCODE_BRIDGE_TURN_TIMEOUT_MS: '60000' }),
      '60000',
      'the backend value still wins over the daemon env',
    );
    delete process.env.ENDO_OPENCODE_BRIDGE_TURN_TIMEOUT_MS;
    t.is(resolveBridgeTurnTimeout({}), '');
  },
);

test('resolveBrokerTransport requires the loopback URL and listener together', t => {
  t.deepEqual(resolveBrokerTransport({}), { broker: false });
  t.deepEqual(
    resolveBrokerTransport({
      OPENCODE_BROKER_BASE_URL: 'http://127.0.0.1:41337/api/v1',
      OPENCODE_BROKER_CONTAINER: 'endo-provider-abc',
    }),
    {
      broker: true,
      baseUrl: 'http://127.0.0.1:41337/api/v1',
      container: 'endo-provider-abc',
      apiKey: 'opencode-broker-placeholder',
    },
  );
  // The placeholder is synthesized: an environment value is ignored, so a
  // deployment cannot park a real key in the slice under this name.
  t.is(
    resolveBrokerTransport({
      OPENCODE_BROKER_BASE_URL: 'http://127.0.0.1:41337/api/v1',
      OPENCODE_BROKER_CONTAINER: 'endo-provider-abc',
      OPENCODE_BROKER_API_KEY: 'sk-or-real-key',
    }).apiKey,
    'opencode-broker-placeholder',
  );
  t.throws(
    () =>
      resolveBrokerTransport({
        OPENCODE_BROKER_BASE_URL: 'http://127.0.0.1:41337/api/v1',
      }),
    { message: /both the loopback base URL and the listener container/ },
  );
  t.throws(
    () =>
      resolveBrokerTransport({
        OPENCODE_BROKER_CONTAINER: '../escape',
      }),
    { message: /both the loopback base URL and the listener container/ },
  );
  t.throws(
    () =>
      resolveBrokerTransport({
        OPENCODE_BROKER_BASE_URL: 'http://127.0.0.1:41337/api/v1',
        OPENCODE_BROKER_CONTAINER: '../escape',
      }),
    { message: /container name is invalid/ },
  );
});

test('planBrokerClient maps a broker lease to join/placeholder and direct to passthrough', t => {
  const broker = planBrokerClient({
    transport: resolveBrokerTransport({
      OPENCODE_BROKER_BASE_URL: 'http://127.0.0.1:41337/api/v1',
      OPENCODE_BROKER_CONTAINER: 'endo-provider-abc',
    }),
    network: 'private',
  });
  t.true(broker.broker);
  t.is(broker.network, 'join');
  t.is(broker.networkRef, 'endo-provider-abc');
  t.deepEqual(broker.configOptions, {
    baseUrl: 'http://127.0.0.1:41337/api/v1',
    allowLoopbackHttp: true,
  });
  t.deepEqual(broker.credentialEnv, {
    OPENROUTER_API_KEY: 'opencode-broker-placeholder',
  });
  t.false(broker.useCredentialCap);

  const direct = planBrokerClient({
    transport: resolveBrokerTransport({}),
    network: 'private',
  });
  t.false(direct.broker);
  t.is(direct.network, 'private');
  t.is(direct.networkRef, undefined);
  t.deepEqual(direct.configOptions, {});
  t.deepEqual(direct.credentialEnv, {});
  t.true(direct.useCredentialCap);
});
