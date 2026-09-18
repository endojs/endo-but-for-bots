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
  const proc = harden({
    async kill() {
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
    isEnded: () => ended,
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
      bridge.end();
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

/**
 * A partial client fixture. The exo's argument type is complete and these
 * tests supply only what they exercise, so the cast belongs here rather than
 * at every call site.
 *
 * @returns {any}
 */
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

/** Wait for a condition the client reaches asynchronously. */
const waitFor = async (predicate, attempts = 200) => {
  for (let i = 0; i < attempts; i += 1) {
    if (predicate()) return;
    // eslint-disable-next-line no-await-in-loop
    await tick();
  }
  throw Error('condition was not reached');
};

const makeGate = t => {
  let release = () => {};
  const promise = new Promise(resolve => {
    release = () => resolve(undefined);
  });
  t.teardown(release);
  return { promise, release };
};

/**
 * @param {any} reader
 * @returns {Promise<any[]>}
 */
const drain = async reader => {
  /** @type {any[]} */
  const events = [];
  for await (const value of iterateReader(reader)) {
    events.push(value);
  }
  return events;
};

// The bridge names what it understands. An image built before the import
// route carries a bridge that sends no list and answers no `import`.
const readyLine = (sessionId, features = ['import']) =>
  JSON.stringify({ type: 'ready', sessionId, port: 4096, features });
const legacyReadyLine = sessionId =>
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

test('overflow closes the reader but interruption still waits for the producer terminal', async t => {
  t.timeout(5000);
  const bridge = makeFakeBridge();
  const client = makeOpencodeClient(baseArgs(makeFakeSlice(bridge)));
  t.teardown(() => client.terminate());
  bridge.push(readyLine('ses_1'));
  const reader = await client.send('work');
  await waitFor(() => bridge.commands.length > 0);
  for (let n = 0; n < 1025; n += 1) {
    bridge.push(JSON.stringify({ type: 'text-delta', text: 'x' }));
  }
  await waitFor(() =>
    bridge.commands.some(command => command.includes('interrupt')),
  );
  await t.throwsAsync(drain(reader), { message: /queue capacity exceeded/ });
  let stopped = false;
  const interrupt = client.interrupt().then(() => {
    stopped = true;
  });
  await tick();
  t.false(stopped, 'reader overflow is not confirmation of producer stop');
  bridge.push(JSON.stringify({ type: 'abort', reason: 'interrupted' }));
  await interrupt;
  t.true(stopped);
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

test('terminate disposes the slice and keeps state', async t => {
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
  t.true(bridge.isEnded());
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

test('failed disposal fences turns and retains mounts and state for retry', async t => {
  const bridge = makeFakeBridge();
  const fake = makeFakeSlice(bridge);
  let disposals = 0;
  let unmounts = 0;
  let deletions = 0;
  const client = makeOpencodeClient(
    baseArgs(fake, {
      slice: harden({
        dispose: async () => {
          disposals += 1;
          if (disposals === 1) throw Error('Slice still alive');
          bridge.end();
        },
      }),
      mountHandle: harden({
        unmount: async () => {
          unmounts += 1;
        },
      }),
      removeState: async () => {
        deletions += 1;
      },
    }),
  );
  await t.throwsAsync(client.destroy(), { message: /Slice still alive/ });
  t.is(unmounts, 0);
  t.is(deletions, 0);
  t.like(await client.status(), { terminated: true, stopped: false });
  await t.throwsAsync(client.send('cannot restart'), {
    message: /is terminated/,
  });
  await Promise.all([client.destroy(), client.destroy(), client.terminate()]);
  t.is(disposals, 2);
  t.is(unmounts, 1);
  t.is(deletions, 1);
  t.is((await client.status()).stopped, true);
});

test('failed unmount retries without repeating disposal or deleting state early', async t => {
  const fake = makeFakeSlice(makeFakeBridge());
  let disposals = 0;
  let unmounts = 0;
  let deletions = 0;
  const client = makeOpencodeClient(
    baseArgs(fake, {
      slice: harden({
        dispose: async () => {
          disposals += 1;
        },
      }),
      mountHandle: harden({
        unmount: async () => {
          unmounts += 1;
          if (unmounts === 1) throw Error('Mount still busy');
        },
      }),
      removeState: async () => {
        deletions += 1;
      },
    }),
  );
  await t.throwsAsync(client.destroy(), { instanceOf: AggregateError });
  t.is(disposals, 1);
  t.is(deletions, 0);
  await client.destroy();
  t.is(disposals, 1);
  t.is(unmounts, 2);
  t.is(deletions, 1);
});

test('failed state deletion remains retryable after successful termination', async t => {
  const fake = makeFakeSlice(makeFakeBridge());
  let attempts = 0;
  const client = makeOpencodeClient(
    baseArgs(fake, {
      removeState: async () => {
        attempts += 1;
        if (attempts === 1) throw Error('State removal failed');
      },
    }),
  );
  await t.throwsAsync(client.destroy(), { message: /State removal failed/ });
  t.is((await client.status()).stopped, true);
  await Promise.all([client.destroy(), client.destroy()]);
  t.is(attempts, 2);
});

test('termination drains late provisioning without spawning or awaiting readiness', async t => {
  t.timeout(5000);
  const acquired = makeGate(t);
  const finish = makeGate(t);
  const fake = makeFakeSlice(makeFakeBridge());
  let closed = false;
  const client = makeOpencodeClient(
    baseArgs(fake, {
      provision: async () => {
        acquired.release();
        await finish.promise;
        return { slice: fake.slice };
      },
      cleanupProvision: async () => {
        closed = true;
        await finish.promise;
        await fake.slice.dispose();
      },
    }),
  );
  const reader = await client.send('start');
  await acquired.promise;
  const stopping = client.terminate();
  await tick();
  t.true(closed);
  t.is((await client.status()).stopped, false);
  finish.release();
  await stopping;
  t.deepEqual(fake.spawnCalls, []);
  t.true(fake.isDisposed());
  t.is((await drain(reader)).pop()?.type, 'abort');
});

test('termination retains an admitted spawn until disposal and acquisition settle', async t => {
  t.timeout(5000);
  const entered = makeGate(t);
  const finish = makeGate(t);
  const disposal = makeGate(t);
  const bridge = makeFakeBridge();
  let writers = 0;
  const slice = harden({
    spawn: async () => {
      entered.release();
      await finish.promise;
      return bridge.proc;
    },
    dispose: async () => {
      disposal.release();
      await finish.promise;
      bridge.end();
    },
  });
  const client = makeOpencodeClient(
    baseArgs(
      { slice },
      {
        makeStdinWriter: async () => {
          writers += 1;
          return {};
        },
      },
    ),
  );
  const reader = await client.send('start');
  await entered.promise;
  const stopping = client.terminate();
  await disposal.promise;
  t.is((await client.status()).stopped, false);
  finish.release();
  await stopping;
  t.is(writers, 0);
  t.true(bridge.isEnded());
  t.is((await drain(reader)).pop()?.type, 'abort');
});

test('termination does not wait for a missing guest ready event', async t => {
  t.timeout(5000);
  const fake = makeFakeSlice(makeFakeBridge());
  const client = makeOpencodeClient(baseArgs(fake));
  const reader = await client.send('start');
  await tick();
  t.is(fake.spawnCalls.length, 1);
  await client.terminate();
  t.true(fake.isDisposed());
  t.is((await drain(reader)).pop()?.type, 'abort');
});

test('termination bypasses a blocked guest command writer', async t => {
  t.timeout(5000);
  const entered = makeGate(t);
  const finish = makeGate(t);
  const bridge = makeFakeBridge();
  const fake = makeFakeSlice(bridge);
  const client = makeOpencodeClient(
    baseArgs(fake, {
      makeStdinWriter: async () => ({
        next: async () => {
          entered.release();
          await finish.promise;
          return { done: false };
        },
        return: async () => {
          t.fail('Guest writer return must not precede host disposal');
        },
      }),
    }),
  );
  bridge.push(readyLine('ses_1'));
  const reader = await client.send('start');
  await entered.promise;
  await client.terminate();
  t.true(fake.isDisposed());
  t.is((await drain(reader)).pop()?.type, 'abort');
  finish.release();
});

test('rejected provisioning still has a cleanup owner whose failures are retried', async t => {
  const fake = makeFakeSlice(makeFakeBridge());
  let cleanupAttempts = 0;
  const client = makeOpencodeClient(
    baseArgs(fake, {
      provision: async () => {
        throw Error('Acquisition failed');
      },
      cleanupProvision: async () => {
        cleanupAttempts += 1;
        if (cleanupAttempts === 1) throw Error('Rollback still pending');
      },
    }),
  );
  const reader = await client.send('start');
  t.is((await drain(reader)).pop()?.type, 'abort');
  await t.throwsAsync(client.terminate(), {
    message: /Rollback still pending/,
  });
  t.is((await client.status()).stopped, false);
  await client.terminate();
  t.is(cleanupAttempts, 2);
  t.is((await client.status()).stopped, true);
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
  const placeholder = resolveBrokerTransport({
    OPENCODE_BROKER_BASE_URL: 'http://127.0.0.1:41337/api/v1',
    OPENCODE_BROKER_CONTAINER: 'endo-provider-abc',
    OPENCODE_BROKER_API_KEY: 'sk-or-real-key',
  });
  t.is(
    placeholder.broker ? placeholder.apiKey : undefined,
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

test('a new incarnation restores the stack\u2019s record before its first turn', async t => {
  const bridge = makeFakeBridge();
  const fake = makeFakeSlice(bridge);
  const client = makeOpencodeClient(
    baseArgs(fake, { model: 'openrouter/deepseek/v4' }),
  );
  bridge.push(readyLine('ses_1'));
  const transcript = harden([
    { kind: 'message', role: 'user', content: 'build the page' },
    { kind: 'tool-call', id: 'c1', name: 'write', args: '{"path":"a"}' },
    { kind: 'tool-result', id: 'c1', content: 'wrote a' },
    { kind: 'message', role: 'assistant', content: 'done' },
  ]);
  const reader = await client.send('and now the footer', { transcript });
  await waitFor(() => bridge.commands.length >= 1);
  // The conversation arrives ahead of the turn through the import route,
  // tool traffic included as tool traffic.
  const imported = JSON.parse(bridge.commands[0]);
  t.is(imported.op, 'import');
  t.deepEqual(imported.turns, [
    { kind: 'user', text: 'build the page' },
    {
      kind: 'tool',
      callID: 'c1',
      name: 'write',
      input: { path: 'a' },
      output: 'wrote a',
    },
    { kind: 'assistant', text: 'done' },
  ]);
  bridge.push(JSON.stringify({ type: 'imported', ok: true }));
  await waitFor(() => bridge.commands.length >= 2);
  // The prompt is the prompt: nothing is prepended to it.
  t.is(JSON.parse(bridge.commands[1]).text, 'and now the footer');
  bridge.push(JSON.stringify({ type: 'end' }));
  await drain(reader);

  // Only once per incarnation. A later turn continues the conversation
  // opencode now holds, so repeating the history would duplicate it.
  const next = await client.send('and a header', { transcript });
  bridge.push(JSON.stringify({ type: 'end' }));
  await drain(next);
  t.is(JSON.parse(bridge.commands[2]).text, 'and a header');
});

test('a resumed session is not given a history it already has', async t => {
  const bridge = makeFakeBridge();
  const fake = makeFakeSlice(bridge);
  const client = makeOpencodeClient(
    baseArgs(fake, { resumePriorConversation: true }),
  );
  bridge.push(readyLine('ses_1'));
  const reader = await client.send('carry on', {
    transcript: [{ kind: 'message', role: 'user', content: 'earlier' }],
  });
  bridge.push(JSON.stringify({ type: 'end' }));
  await drain(reader);
  t.is(JSON.parse(bridge.commands[0]).text, 'carry on');
});

test('a resume that missed restores rather than continuing context-free', async t => {
  const bridge = makeFakeBridge();
  const fake = makeFakeSlice(bridge);
  const client = makeOpencodeClient(
    baseArgs(fake, {
      resumePriorConversation: true,
      opencodeSessionId: 'ses_gone',
      model: 'openrouter/deepseek/v4',
    }),
  );
  // The store no longer holds the recorded session, so the bridge started a
  // fresh one. That case had no handling: the session simply continued
  // context-free, which is the silent version of losing a conversation.
  bridge.push(readyLine('ses_new'));
  const reader = await client.send('carry on', {
    transcript: [{ kind: 'message', role: 'user', content: 'earlier work' }],
  });
  await waitFor(() => bridge.commands.length >= 1);
  const imported = JSON.parse(bridge.commands[0]);
  t.is(imported.op, 'import');
  t.deepEqual(imported.turns, [{ kind: 'user', text: 'earlier work' }]);
  bridge.push(JSON.stringify({ type: 'imported', ok: true }));
  await waitFor(() => bridge.commands.length >= 2);
  t.is(JSON.parse(bridge.commands[1]).text, 'carry on');
  bridge.push(JSON.stringify({ type: 'end' }));
  await drain(reader);
});

test('a bridge that cannot import refuses the turn instead of degrading it', async t => {
  // The image carries the bridge, so a slice running one built before the
  // import route cannot take the conversation at all. Reading it into the
  // prompt instead would let the session keep answering while the mechanism
  // that is supposed to carry the conversation is broken, which is how a
  // dropped transcript survived a whole suite. The bridge names what it
  // understands, an older one names nothing, and the turn fails saying so.
  const bridge = makeFakeBridge();
  const fake = makeFakeSlice(bridge);
  const client = makeOpencodeClient(
    baseArgs(fake, { model: 'openrouter/deepseek/v4' }),
  );
  bridge.push(legacyReadyLine('ses_1'));
  const transcript = harden([
    { kind: 'message', role: 'user', content: 'remember ALPENGLOW' },
  ]);
  const reader = await client.send('what was the word?', { transcript });
  const events = await drain(reader);
  const abort = events.at(-1);
  t.is(abort.type, 'abort');
  t.regex(abort.reason, /no import route/);
  // Nothing was sent: not the import it cannot do, and not a prompt that
  // would have been answered out of an empty context.
  t.is(bridge.commands.length, 0);
});

test('restoration goes through the structured import, or not at all', async t => {
  const transcript = harden([
    { kind: 'message', role: 'user', content: 'build the page' },
    { kind: 'tool-call', id: 'c1', name: 'write', args: '{"path":"a"}' },
    { kind: 'tool-result', id: 'c1', content: 'wrote a' },
  ]);

  // An image carrying the import route takes the conversation structurally,
  // so a tool call arrives as a tool call and the prompt stays the prompt.
  {
    const bridge = makeFakeBridge();
    const fake = makeFakeSlice(bridge);
    const client = makeOpencodeClient(
      baseArgs(fake, { model: 'openrouter/deepseek/v4' }),
    );
    bridge.push(readyLine('ses_1'));
    const reader = await client.send('and the footer', { transcript });
    // The import goes out before the prompt and is awaited, so the send
    // command does not follow until the bridge answers.
    await waitFor(() => bridge.commands.length >= 1);
    const imported = JSON.parse(bridge.commands[0]);
    t.is(imported.op, 'import');
    // `ModelV2.Ref`: `{ id, providerID }`. The route rejects the flat
    // `{ modelID, providerID }` shape its neighbours use, with a bare 400.
    t.deepEqual(imported.model, {
      providerID: 'openrouter',
      id: 'deepseek/v4',
    });
    // A call and its result are one imported turn: splitting them would
    // record a call the store shows as never having returned.
    t.deepEqual(imported.turns, [
      { kind: 'user', text: 'build the page' },
      {
        kind: 'tool',
        callID: 'c1',
        name: 'write',
        input: { path: 'a' },
        output: 'wrote a',
      },
    ]);
    bridge.push(JSON.stringify({ type: 'imported', ok: true }));
    await waitFor(() => bridge.commands.length >= 2);
    t.is(JSON.parse(bridge.commands[1]).text, 'and the footer');
    bridge.push(JSON.stringify({ type: 'end' }));
    await drain(reader);
  }

  // A bridge that has the command but whose server refuses it says so, and
  // the turn fails there. The prompt is never sent: answering it would be
  // answering a different question from the one the conversation was asking.
  {
    const bridge = makeFakeBridge();
    const fake = makeFakeSlice(bridge);
    const client = makeOpencodeClient(
      baseArgs(fake, { model: 'openrouter/deepseek/v4' }),
    );
    bridge.push(readyLine('ses_1'));
    const reader = await client.send('and the footer', { transcript });
    await waitFor(() => bridge.commands.length >= 1);
    bridge.push(JSON.stringify({ type: 'imported', ok: false, reason: '404' }));
    const events = await drain(reader);
    const abort = events.at(-1);
    t.is(abort.type, 'abort');
    t.regex(abort.reason, /refused or did not answer/);
    t.is(bridge.commands.length, 1);
  }
});
