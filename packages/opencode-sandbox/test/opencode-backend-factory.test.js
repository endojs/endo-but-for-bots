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
const makeHarness = () => {
  const log = [];
  const { client, turns, interrupts } = makeFakeClient(() => {
    log.push(['stop-client']);
  });
  let pending = 0;
  let bridgeClosed = 0;
  const factory = makeOpencodeBackendFactory({
    provisionClient: async (sessionId, options) => {
      log.push(['provision', sessionId, options]);
      return client;
    },
    cancelClient: async sessionId => {
      log.push(['cancel', sessionId]);
    },
    removeSession: async sessionId => {
      log.push(['remove', sessionId]);
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

test('terminate() stops the client, closes the bridge, then cancels; it refuses under a live tool call', async t => {
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
  await t.throwsAsync(() => E(run).send('hello'), {
    message: /network policy is "off"/,
  });
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
