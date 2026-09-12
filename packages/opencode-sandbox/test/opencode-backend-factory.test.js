// @ts-check
import '@endo/init';
import test from 'ava';
import { E } from '@endo/eventual-send';
import { makeExo } from '@endo/exo';
import { makeBufferedReader } from '@endo/exo-stream/buffered-channel.js';
import { iterateReader } from '@endo/exo-stream/iterate-reader.js';
import { HostedToolSetInterface } from '@endo/hosted-agent';

import {
  OPENCODE_MODELS,
  makeOpencodeBackendFactory,
} from '../src/opencode-backend-factory.js';

// Share a test-only conformance driver across sibling packages.
// eslint-disable-next-line import/no-relative-packages
import { testCliCleanup } from '../../hosted-agent/test/cli-cleanup-conformance.js';

const drain = async reader => {
  const events = [];
  for await (const value of iterateReader(reader)) {
    events.push(value);
  }
  return events;
};

/**
 * A fake OpencodeClient: each send() hands back a fresh buffered reader the
 * test drives, and records the prompt and options it was given.
 *
 * @param {() => void} [onTerminate] - observes the client's own stop.
 */
const makeFakeClient = (onTerminate = () => {}) => {
  /** @type {Array<{ prompt: string, opts: Record<string, unknown>, push: (event: object) => void, killed: () => boolean }>} */
  const turns = [];
  let interrupts = 0;
  let idle = true;
  const client = harden({
    async terminate() {
      idle = true;
      onTerminate();
    },
    async send(prompt, opts = {}) {
      let killed = false;
      const { push, reader, setOnClose } = makeBufferedReader();
      setOnClose(() => {
        killed = true;
      });
      idle = false;
      turns.push({ prompt, opts: { ...opts }, push, killed: () => killed });
      return reader;
    },
    async interrupt() {
      interrupts += 1;
      if (idle)
        throw Error('OpencodeClient(x): no in-flight prompt to interrupt.');
      idle = true;
    },
    async status() {
      return harden({
        sessionId: 'x',
        opencodeSessionId: 'ses_opencode',
        turnActive: !idle,
        pendingPrompts: 0,
      });
    },
  });
  return { client, turns, interrupts: () => interrupts };
};

const makeToolSet = (execute = async () => 'ok') =>
  makeExo('HostedToolSet', HostedToolSetInterface, {
    async describe() {
      return harden({
        dynamicTools: [
          {
            name: 'lookup',
            description: 'look up a pet name',
            inputSchema: { type: 'object', properties: {} },
          },
        ],
        toolSetId: 'tools-v1',
      });
    },
    execute,
    help: () => 'test tool set',
  });

/**
 * Wire a factory over recording powers. `bridge` stands in for the MCP socket
 * server; `pending` lets a test simulate an in-flight Endo tool call.
 */
const makeHarness = (options = {}) => {
  const log = [];
  const { client, turns, interrupts } = makeFakeClient(() => {
    log.push(['stop-client']);
    options.onTerminate?.();
  });
  let pending = 0;
  let bridgeClosed = 0;
  const factory = makeOpencodeBackendFactory({
    ...(options.broker ? { broker: options.broker } : {}),
    provisionClient: async (sessionId, clientOptions) => {
      log.push(['provision', sessionId, clientOptions]);
      return client;
    },
    cancelClient: async sessionId => {
      log.push(['cancel', sessionId]);
    },
    removeSession: async sessionId => {
      log.push(['remove', sessionId]);
      options.onRemove?.();
    },
    startToolBridge: async (sessionId, toolSet) => {
      log.push(['bridge', sessionId, await E(toolSet).describe()]);
      return harden({
        socketDir: `/tmp/opencode-mcp/${sessionId}`,
        innerDir: '/endo-mcp',
        configPath: '/endo-mcp/mcp.json',
        pendingCalls: () => pending,
        close: async () => {
          bridgeClosed += 1;
        },
      });
    },
    removeToolBridge: async sessionId => {
      log.push(['remove-bridge', sessionId]);
    },
  });
  return {
    factory,
    turns,
    interrupts,
    log,
    setPending: n => {
      pending = n;
    },
    bridgeClosed: () => bridgeClosed,
  };
};

test('describe() and listModels() present OpenCode as a hosted backend', async t => {
  const { factory } = makeHarness();
  t.deepEqual(await E(factory).describe(), {
    id: 'opencode',
    title: 'OpenCode',
    kind: 'hosted',
    continuity: 'transcript',
    toolOwnership: 'endo',
    supportedNetworkPolicies: ['off', 'public-internet'],
  });
  const models = await E(factory).listModels();
  t.deepEqual(models, OPENCODE_MODELS);
  t.is(models.filter(model => model.default).length, 1);
  t.true(models.every(model => model.reasoningEfforts.length === 0));
  t.true(models.every(model => model.defaultReasoningEffort === null));
  t.true(
    models.every(model => `${model.id}`.startsWith('openrouter/')),
    'ids are full opencode refs',
  );
});

test('create() pins the tool set into an MCP bridge and provisions the client behind it', async t => {
  const { factory, log } = makeHarness();
  const { run, admin } = await E(factory).create(
    harden({
      sessionId: 'session-a',
      model: 'openrouter/deepseek/deepseek-v4.1-flash',
      systemPrompt: 'You are Floot.',
      workspaceHostPath: '/git/worktrees/session-a',
    }),
    makeToolSet(),
  );
  t.truthy(run);
  t.truthy(admin);
  t.is(log[0][0], 'bridge');
  t.is(log[0][1], 'session-a');
  t.deepEqual(
    log[0][2].dynamicTools.map(tool => tool.name),
    ['lookup'],
  );
  t.deepEqual(log[1], [
    'provision',
    'session-a',
    {
      mcp: {
        socketDir: '/tmp/opencode-mcp/session-a',
        innerDir: '/endo-mcp',
        configPath: '/endo-mcp/mcp.json',
      },
      model: 'openrouter/deepseek/deepseek-v4.1-flash',
      systemPrompt: 'You are Floot.',
      workspaceHostPath: '/git/worktrees/session-a',
      network: 'none',
    },
  ]);
  const status = await E(run).status();
  t.is(status.pendingToolCalls, 0);
  t.is(status.turnActive, false);
  t.deepEqual(status.toolBridge, {
    innerDir: '/endo-mcp',
    configPath: '/endo-mcp/mcp.json',
  });
});

test('create() refuses an unknown model or a reasoning effort', async t => {
  const { factory } = makeHarness();
  await t.throwsAsync(
    () =>
      E(factory).create(
        harden({ sessionId: 'session-a', model: 'openrouter/gpt-9' }),
        makeToolSet(),
      ),
    { message: /Unknown OpenCode model/ },
  );
  await t.throwsAsync(
    () =>
      E(factory).create(
        harden({ sessionId: 'session-a', reasoningEffort: 'high' }),
        makeToolSet(),
      ),
    { message: /no reasoning-effort setting/ },
  );
  await t.throwsAsync(
    () => E(factory).create(harden({ sessionId: '../x' }), makeToolSet()),
    { message: /bounded lowercase path component/ },
  );
});

test('send() forwards the session persona and passes the client reader through', async t => {
  const { factory, turns } = makeHarness();
  const { run } = await E(factory).create(
    harden({
      sessionId: 'session-a',
      model: 'openrouter/deepseek/deepseek-v4.1-flash',
      systemPrompt: 'default persona',
      networkPolicy: 'public-internet',
    }),
    makeToolSet(),
  );
  const readerP = E(run).send(
    'build it',
    harden({ systemPrompt: 'turn persona' }),
  );
  for (let tries = 0; turns.length === 0 && tries < 50; tries += 1) {
    // eslint-disable-next-line no-await-in-loop
    await null;
  }
  t.is(turns.length, 1);
  t.is(turns[0].prompt, 'build it');
  // The model is pinned at provision time; only the persona rides the send.
  t.deepEqual(turns[0].opts, { systemPrompt: 'turn persona' });
  turns[0].push({ type: 'phase', phase: 'busy' });
  turns[0].push({ type: 'text-delta', text: 'Building. ' });
  turns[0].push({
    type: 'tool-call',
    id: 'call_1',
    name: 'endo_lookup',
    args: '{"name":"workspace"}',
  });
  turns[0].push({
    type: 'tool-result',
    id: 'call_1',
    ok: true,
    result: 'found',
  });
  turns[0].push({ type: 'usage', inputTokens: 20, outputTokens: 5 });
  turns[0].push({ type: 'end' });
  // The bridge already emits hosted events, so the reader passes through
  // verbatim.
  t.deepEqual(await drain(await readerP), [
    { type: 'phase', phase: 'busy' },
    { type: 'text-delta', text: 'Building. ' },
    {
      type: 'tool-call',
      id: 'call_1',
      name: 'endo_lookup',
      args: '{"name":"workspace"}',
    },
    { type: 'tool-result', id: 'call_1', ok: true, result: 'found' },
    { type: 'usage', inputTokens: 20, outputTokens: 5 },
    { type: 'end' },
  ]);

  // Without a per-turn persona the session prompt applies.
  E(run).send('again');
  for (let tries = 0; turns.length < 2 && tries < 50; tries += 1) {
    // eslint-disable-next-line no-await-in-loop
    await null;
  }
  t.deepEqual(turns[1].opts, { systemPrompt: 'default persona' });
});

test('interrupt() is a barrier that tolerates an idle client; acknowledge() is a no-op', async t => {
  const { factory, turns, interrupts } = makeHarness();
  const { run } = await E(factory).create(
    harden({ sessionId: 'session-a', networkPolicy: 'public-internet' }),
    makeToolSet(),
  );
  // Nothing in flight: the client refuses, the backend reports success.
  await t.notThrowsAsync(() => E(run).interrupt());
  t.is(interrupts(), 1);
  await E(run).send('long task');
  await t.notThrowsAsync(() => E(run).interrupt());
  t.is(interrupts(), 2);
  t.is(turns.length, 1);
  await t.notThrowsAsync(() => E(run).acknowledge('whatever'));
});

test('terminate() stops the client, cancels its incarnation, then closes the bridge; it refuses under a live tool call', async t => {
  const { factory, log, setPending, bridgeClosed } = makeHarness();
  const { admin } = await E(factory).create(
    harden({ sessionId: 'session-a' }),
    makeToolSet(),
  );
  setPending(1);
  await t.throwsAsync(() => E(admin).terminate(), {
    message: /1 unsettled Endo tool call/,
  });
  // Nothing was torn down under the running call.
  t.is(bridgeClosed(), 0);
  t.false(log.some(entry => entry[0] === 'stop-client'));
  t.false(log.some(entry => entry[0] === 'cancel'));

  setPending(0);
  await E(admin).terminate();
  t.is(bridgeClosed(), 1);
  // The worker-side stop (slice, mounts, grant) is awaited before the formula
  // is cancelled, so a successor's provision cannot race the predecessor's
  // teardown.
  t.deepEqual(log.slice(-2), [['stop-client'], ['cancel', 'session-a']]);
  // Idempotent.
  await E(admin).terminate();
  t.is(bridgeClosed(), 1);
  t.is(log.filter(entry => entry[0] === 'stop-client').length, 1);
});

test('a tool call that lands after the client stopped still defers the teardown', async t => {
  // The client is stopped once; the retry resumes from the pending-call check.
  const { factory, log, setPending, bridgeClosed } = makeHarness();
  const { admin } = await E(factory).create(
    harden({ sessionId: 'session-a' }),
    makeToolSet(),
  );
  let stops = 0;
  setPending(0);
  // Simulate the race: the pending count rises while the client stops.
  const original = log.push.bind(log);
  log.push = (...entries) => {
    if (entries[0]?.[0] === 'stop-client') {
      stops += 1;
      setPending(1);
    }
    return original(...entries);
  };
  await t.throwsAsync(() => E(admin).terminate(), {
    message: /1 unsettled Endo tool call/,
  });
  t.is(stops, 1);
  t.is(bridgeClosed(), 0);
  setPending(0);
  await E(admin).terminate();
  t.is(stops, 1, 'the client is not stopped twice');
  t.is(bridgeClosed(), 1);
  t.deepEqual(log.at(-1), ['cancel', 'session-a']);
});

test('a second create() for a live session stops the first instance first', async t => {
  const { factory, log, bridgeClosed } = makeHarness();
  await E(factory).create(harden({ sessionId: 'session-a' }), makeToolSet());
  await E(factory).create(harden({ sessionId: 'session-a' }), makeToolSet());
  t.is(bridgeClosed(), 1, 'the predecessor bridge was closed');
  t.deepEqual(
    log.map(entry => entry[0]),
    ['bridge', 'provision', 'stop-client', 'cancel', 'bridge', 'provision'],
  );
});

test('destroy() stops a live instance, then removes the session and its bridge', async t => {
  const { factory, log } = makeHarness();
  await E(factory).create(harden({ sessionId: 'session-a' }), makeToolSet());
  await E(factory).destroy(harden({ sessionId: 'session-a' }));
  t.deepEqual(
    log.map(entry => entry[0]),
    ['bridge', 'provision', 'stop-client', 'cancel', 'remove', 'remove-bridge'],
  );
  // Replay after the session is gone is not an error.
  await t.notThrowsAsync(() =>
    E(factory).destroy(harden({ sessionId: 'session-a' })),
  );
});

test('a provisioning failure releases the bridge it started', async t => {
  let bridgeClosed = 0;
  const factory = makeOpencodeBackendFactory({
    provisionClient: async () => {
      throw Error('image pull failed');
    },
    cancelClient: async () => {},
    removeSession: async () => {},
    startToolBridge: async () =>
      harden({
        socketDir: '/tmp/x',
        innerDir: '/endo-mcp',
        configPath: '/endo-mcp/mcp.json',
        pendingCalls: () => 0,
        close: async () => {
          bridgeClosed += 1;
        },
      }),
    removeToolBridge: async () => {},
  });
  await t.throwsAsync(
    () => E(factory).create(harden({ sessionId: 'session-a' }), makeToolSet()),
    { message: /image pull failed/ },
  );
  t.is(bridgeClosed, 1);
});

test('network policy is threaded; off refuses sends and maps to the none profile', async t => {
  const { factory, log } = makeHarness();
  const { run } = await E(factory).create(
    harden({ sessionId: 'session-a' }),
    makeToolSet(),
  );
  t.is(log.find(entry => entry[0] === 'provision')[2].network, 'none');
  // The refusal arrives as a leading abort, not a rejection: Floot must record
  // a clean failed turn so setting the policy lets the operator retry.
  const events = [];
  for await (const event of iterateReader(await E(run).send('hello'))) {
    events.push(event);
  }
  t.deepEqual(events, [
    {
      type: 'abort',
      reason:
        'OpenCode session network policy is "off"; set the session policy to public-internet before sending a turn',
    },
  ]);
});

test('a broker lease carries off-policy traffic and is revoked on stop', async t => {
  const brokerCalls = [];
  let revoked = 0;
  const broker = async spec => {
    brokerCalls.push(spec);
    return harden({
      async attestation() {
        return harden({ endpoint: 'http://127.0.0.1:41337' });
      },
      async sandboxEvidence() {
        return harden({ brokerSidecar: { container: 'endo-provider-abc' } });
      },
      async revoke() {
        revoked += 1;
      },
    });
  };
  const { factory, log, turns } = makeHarness({ broker });
  const { run, admin } = await E(factory).create(
    harden({
      sessionId: 'session-a',
      model: 'openrouter/deepseek/deepseek-v4.1-flash',
    }),
    makeToolSet(),
  );
  t.deepEqual(brokerCalls, [
    {
      sessionId: 'session-a',
      providerOrigin: 'https://openrouter.ai',
      accountRef: 'openrouter',
      model: 'deepseek/deepseek-v4.1-flash',
      networkPolicy: 'off',
    },
  ]);
  const provision = log.find(entry => entry[0] === 'provision');
  t.is(provision[2].network, 'join');
  t.deepEqual(provision[2].brokerEnv, {
    OPENCODE_BROKER_BASE_URL: 'http://127.0.0.1:41337/api/v1',
    OPENCODE_BROKER_CONTAINER: 'endo-provider-abc',
  });
  // A turn dispatches through the client instead of being refused.
  await E(run).send('hello');
  t.is(turns.length, 1);
  await E(admin).terminate();
  t.is(revoked, 1, 'the listener lease is released with the client');
});

test('a failed lease revoke is retried on the next terminate attempt', async t => {
  let revoked = 0;
  let failNext = true;
  const broker = async () =>
    harden({
      async attestation() {
        return harden({ endpoint: 'http://127.0.0.1:41337' });
      },
      async sandboxEvidence() {
        return harden({ brokerSidecar: { container: 'endo-provider-abc' } });
      },
      async revoke() {
        revoked += 1;
        if (failNext) {
          failNext = false;
          throw Error('listener busy');
        }
      },
    });
  const { factory } = makeHarness({ broker });
  const { admin } = await E(factory).create(
    harden({ sessionId: 'session-a' }),
    makeToolSet(),
  );
  const error = await t.throwsAsync(() => E(admin).terminate(), {
    instanceOf: AggregateError,
    message: /cleanup remains pending/,
  });
  t.regex(error.errors[0].errors[0].message, /listener busy/);
  // The failed teardown keeps ownership and the retry releases the lease.
  await E(admin).terminate();
  t.is(revoked, 2);
});

test('an unknown model is refused before any broker lease is issued', async t => {
  let leases = 0;
  const broker = async () => {
    leases += 1;
    throw Error('must not be reached');
  };
  const { factory } = makeHarness({ broker });
  await t.throwsAsync(
    () =>
      E(factory).create(
        harden({ sessionId: 'session-a', model: 'openrouter/nope/nope' }),
        makeToolSet(),
      ),
    { message: /Unknown OpenCode model/ },
  );
  t.is(leases, 0);
});

test('public-internet maps to the private slice profile', async t => {
  const { factory, log } = makeHarness();
  await E(factory).create(
    harden({ sessionId: 'session-a', networkPolicy: 'public-internet' }),
    makeToolSet(),
  );
  t.is(log.find(entry => entry[0] === 'provision')[2].network, 'private');
});

test('create() rejects an unknown policy, container mounts, and bad workspace paths', async t => {
  const { factory } = makeHarness();
  await t.throwsAsync(
    () =>
      E(factory).create(
        harden({ sessionId: 'session-a', networkPolicy: 'nope' }),
        makeToolSet(),
      ),
    { message: /Unknown network policy/ },
  );
  await t.throwsAsync(
    () =>
      E(factory).create(
        harden({ sessionId: 'session-b', containerMounts: [{ key: 'x' }] }),
        makeToolSet(),
      ),
    { message: /container mounts/ },
  );
  await t.throwsAsync(
    () =>
      E(factory).create(
        harden({ sessionId: 'session-c', workspaceHostPath: 'rel/path' }),
        makeToolSet(),
      ),
    { message: /workspaceHostPath/ },
  );
  await t.throwsAsync(
    () =>
      E(factory).create(
        harden({ sessionId: 'session-d', workspaceHostPath: '/a/../b' }),
        makeToolSet(),
      ),
    { message: /workspaceHostPath/ },
  );
});

testCliCleanup(makeOpencodeBackendFactory, makeToolSet, true);

test('grant refusal closes the bridge without cancelling an unattempted client', async t => {
  const { factory, bridgeClosed, log } = makeHarness({
    broker: async () => {
      throw Error('grant refused');
    },
  });
  await t.throwsAsync(
    () => E(factory).create(harden({ sessionId: 'session-a' }), makeToolSet()),
    { message: /grant refused/ },
  );
  t.is(bridgeClosed(), 1);
  t.deepEqual(
    log.map(entry => entry[0]),
    ['bridge'],
  );
});

test('failed client stop fences successors and deletion while independent authority is withdrawn', async t => {
  let stopFails = true;
  let revocations = 0;
  const { factory, log, bridgeClosed } = makeHarness({
    onTerminate: () => {
      if (stopFails) throw Error('guest process still live');
    },
    broker: async () =>
      harden({
        async attestation() {
          return harden({ endpoint: 'http://127.0.0.1:41337' });
        },
        async sandboxEvidence() {
          return harden({ brokerSidecar: { container: 'endo-provider-abc' } });
        },
        async revoke() {
          revocations += 1;
        },
      }),
  });
  const spec = harden({ sessionId: 'stop-retry' });
  const { admin } = await E(factory).create(spec, makeToolSet());
  await t.throwsAsync(() => E(admin).terminate(), {
    message: /guest process still live/,
  });
  t.is(revocations, 1);
  t.is(bridgeClosed(), 1);
  await t.throwsAsync(() => E(factory).create(spec, makeToolSet()), {
    message: /guest process still live/,
  });
  await t.throwsAsync(() => E(factory).destroy(spec), {
    message: /guest process still live/,
  });
  t.is(log.filter(([event]) => event === 'provision').length, 1);
  t.false(
    log.some(([event]) =>
      ['cancel', 'remove', 'remove-bridge'].includes(event),
    ),
  );

  stopFails = false;
  await E(factory).destroy(spec);
  t.is(log.filter(([event]) => event === 'stop-client').length, 4);
  t.deepEqual(log.slice(-3), [
    ['cancel', 'stop-retry'],
    ['remove', 'stop-retry'],
    ['remove-bridge', 'stop-retry'],
  ]);
  t.is(revocations, 1, 'successful authority releases are not repeated');
  t.is(bridgeClosed(), 1);
});

test('failed client stop retains the MCP reader for a raced Endo call', async t => {
  let stopFails = true;
  let revocations = 0;
  const { factory, setPending, log, bridgeClosed } = makeHarness({
    onTerminate: () => {
      if (stopFails) {
        setPending(1);
        throw Error('guest process still live');
      }
    },
    broker: async () =>
      harden({
        async attestation() {
          return harden({ endpoint: 'http://127.0.0.1:41337' });
        },
        async sandboxEvidence() {
          return harden({ brokerSidecar: { container: 'endo-provider-abc' } });
        },
        async revoke() {
          revocations += 1;
        },
      }),
  });
  const { admin } = await E(factory).create(
    harden({ sessionId: 'raced-stop' }),
    makeToolSet(),
  );
  const failure = await t.throwsAsync(() => E(admin).terminate(), {
    instanceOf: AggregateError,
    message: /client stop and authority cleanup remain pending/,
  });
  t.regex(failure.errors[0].message, /guest process still live/);
  t.is(revocations, 1);
  t.is(bridgeClosed(), 0);
  t.false(log.some(([event]) => event === 'cancel'));
  await t.throwsAsync(() => E(admin).terminate(), {
    message: /1 unsettled Endo tool call/,
  });
  stopFails = false;
  setPending(0);
  await E(admin).terminate();
  t.is(log.filter(([event]) => event === 'stop-client').length, 2);
  t.is(revocations, 1);
  t.is(bridgeClosed(), 1);
});

test('failed session removal retains the bridge directory for retry', async t => {
  let removeFails = true;
  const { factory, log } = makeHarness({
    onRemove: () => {
      if (removeFails) throw Error('session destruction incomplete');
    },
  });
  const spec = harden({ sessionId: 'remove-retry' });
  // No live backend registry entry: the provisioner still owns the durable
  // client formula and can refuse destruction when it cannot prove a stop.
  await t.throwsAsync(() => E(factory).destroy(spec), {
    message: /session destruction incomplete/,
  });
  t.deepEqual(log, [['remove', 'remove-retry']]);
  removeFails = false;
  await E(factory).destroy(spec);
  t.deepEqual(log.slice(-2), [
    ['remove', 'remove-retry'],
    ['remove-bridge', 'remove-retry'],
  ]);
});
