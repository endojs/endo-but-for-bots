// @ts-check
import '@endo/init';
import test from 'ava';
import { E } from '@endo/eventual-send';
import { makeExo } from '@endo/exo';
import { makeBufferedReader } from '@endo/exo-stream/buffered-channel.js';
import { iterateReader } from '@endo/exo-stream/iterate-reader.js';
import { HostedToolSetInterface } from '@endo/hosted-agent';

import {
  CLAUDE_CLI_MODELS,
  makeClaudeBackendFactory,
} from '../src/claude-backend-factory.js';

const drain = async reader => {
  const events = [];
  for await (const value of iterateReader(reader)) {
    events.push(value);
  }
  return events;
};

/**
 * A fake owner session facet standing in for the native controller: each
 * send() hands back a fresh buffered reader the test drives with the CLI's
 * stream-json events, and records the prompt and options it was given.
 */
const makeFakeSession = () => {
  /** @type {Array<{ prompt: string, opts: Record<string, unknown>, push: (event: object) => void }>} */
  const turns = [];
  let interrupts = 0;
  let idle = true;
  const facet = harden({
    async send(prompt, opts = {}) {
      const { push, reader } = makeBufferedReader();
      idle = false;
      turns.push({ prompt, opts: { ...opts }, push });
      return reader;
    },
    async interrupt() {
      interrupts += 1;
      if (idle)
        throw Error('ClaudeClient(x): no in-flight prompt to interrupt.');
      idle = true;
    },
    async status() {
      return harden({ sessionId: 'x', conversationStarted: turns.length > 0 });
    },
  });
  return { facet, turns, interrupts: () => interrupts };
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
 * Wire a factory over recording owner powers. The owner is the daemon's; here
 * every lifecycle call is logged and a stop can be made to fail.
 */
const makeHarness = () => {
  /** @type {any[][]} */
  const log = [];
  const { facet, turns, interrupts } = makeFakeSession();
  /** @type {string | undefined} */
  let failingStop;
  let provisionFails = false;
  const factory = makeClaudeBackendFactory({
    provisionSession: async (sessionId, request, toolSet) => {
      log.push(['provision', sessionId, request, await E(toolSet).describe()]);
      if (provisionFails) throw Error('owner refused the plan');
      return facet;
    },
    stopSession: async sessionId => {
      log.push(['stop', sessionId]);
      if (sessionId === failingStop) throw Error('native cleanup pending');
    },
    removeSession: async sessionId => {
      log.push(['remove', sessionId]);
    },
  });
  return {
    factory,
    turns,
    interrupts,
    log,
    names: () => log.map(entry => entry[0]),
    /** @param {string | undefined} sessionId */
    failStop: sessionId => {
      failingStop = sessionId;
    },
    /** @param {boolean} value */
    failProvision: value => {
      provisionFails = value;
    },
  };
};

test('describe() and listModels() present Claude Code as a hosted backend', async t => {
  const { factory } = makeHarness();
  t.deepEqual(await E(factory).describe(), {
    id: 'claude',
    title: 'Claude Code',
    kind: 'hosted',
    continuity: 'transcript',
    toolOwnership: 'endo',
    supportedNetworkPolicies: ['off', 'public-internet'],
  });
  const models = await E(factory).listModels();
  t.deepEqual(models, CLAUDE_CLI_MODELS);
  t.is(models.filter(model => model.default).length, 1);
  t.true(models.every(model => model.reasoningEfforts.length === 0));
});

test('create() hands the validated request and the pinned tool set to the owner', async t => {
  const { factory, log } = makeHarness();
  const { run, admin } = await E(factory).create(
    harden({
      sessionId: 'session-a',
      model: 'claude-sonnet-4-6',
      systemPrompt: 'You are Floot.',
      workspaceHostPath: '/git/worktrees/session-a',
      networkPolicy: 'public-internet',
    }),
    makeToolSet(),
  );
  t.truthy(run);
  t.truthy(admin);
  t.deepEqual(log, [
    [
      'provision',
      'session-a',
      {
        networkPolicy: 'public-internet',
        model: 'claude-sonnet-4-6',
        systemPrompt: 'You are Floot.',
        workspaceHostPath: '/git/worktrees/session-a',
      },
      {
        dynamicTools: [
          {
            name: 'lookup',
            description: 'look up a pet name',
            inputSchema: { type: 'object', properties: {} },
          },
        ],
        toolSetId: 'tools-v1',
      },
    ],
  ]);
  // A bare request records nothing optional and no network.
  await E(factory).create(harden({ sessionId: 'session-b' }), makeToolSet());
  t.deepEqual(log[1][2], { networkPolicy: 'off' });
});

test('create() refuses an unknown model, a network policy, a reasoning effort, declared container mounts, and a bad workspace path', async t => {
  const { factory, log } = makeHarness();
  /** @type {[Record<string, unknown>, RegExp][]} */
  const refused = [
    [{ sessionId: 'session-a', model: 'gpt-9' }, /Unknown Claude model/],
    [
      { sessionId: 'session-a', networkPolicy: 'host' },
      /Unknown network policy "host"/,
    ],
    [
      { sessionId: 'session-a', reasoningEffort: 'high' },
      /no reasoning-effort setting/,
    ],
    [{ sessionId: '../x' }, /bounded lowercase path component/],
    [
      { sessionId: 'session-a', containerMounts: [{ innerPath: '/mnt/x' }] },
      /no slice attestation for container mounts/,
    ],
    [
      { sessionId: 'session-a', workspaceHostPath: 'relative/path' },
      /normalized absolute host path/,
    ],
    [
      { sessionId: 'session-a', workspaceHostPath: '/a/../b' },
      /normalized absolute host path/,
    ],
  ];
  for (const [spec, message] of refused) {
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(E(factory).create(harden(spec), makeToolSet()), {
      message,
    });
  }
  t.deepEqual(log, [], 'nothing reached the owner');
});

test('send() carries the turn\u2019s options, not just the model and persona', async t => {
  // The factory used to rebuild this record from named fields, so the stack's
  // transcript never reached the client. The session still remembered —
  // Claude's own store survives on a host bind and `--continue` finds it — so
  // the loss was invisible until an adapter without a durable store needed it.
  const { factory, turns } = makeHarness();
  const { run } = await E(factory).create(
    harden({
      sessionId: 'session-t',
      model: 'claude-opus-5',
      systemPrompt: 'persona',
    }),
    makeToolSet(),
  );
  const transcript = harden([
    { kind: 'message', role: 'user', content: 'remember ALPENGLOW' },
    { kind: 'message', role: 'assistant', content: 'noted' },
  ]);
  void E(run).send('what was the word?', harden({ transcript }));
  for (let tries = 0; turns.length === 0 && tries < 50; tries += 1) {
    // eslint-disable-next-line no-await-in-loop
    await null;
  }
  t.deepEqual(turns[0].opts.transcript, transcript);
  t.is(turns[0].opts.systemPrompt, 'persona');
  t.is(turns[0].opts.model, 'claude-opus-5');
});

test('send() forwards the session model and persona and translates the CLI stream', async t => {
  const { factory, turns } = makeHarness();
  const { run } = await E(factory).create(
    harden({
      sessionId: 'session-a',
      model: 'claude-opus-5',
      systemPrompt: 'default persona',
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
  t.deepEqual(turns[0].opts, {
    model: 'claude-opus-5',
    systemPrompt: 'turn persona',
  });
  turns[0].push({ type: 'system', subtype: 'init' });
  turns[0].push({
    type: 'assistant',
    message: {
      content: [
        { type: 'text', text: 'Building. ' },
        {
          type: 'tool_use',
          id: 'toolu_1',
          name: 'mcp__endo__lookup',
          input: { name: 'workspace' },
        },
      ],
    },
  });
  turns[0].push({
    type: 'user',
    message: {
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_1', content: 'found' },
      ],
    },
  });
  turns[0].push({
    type: 'result',
    subtype: 'success',
    result: 'Building. ',
    usage: { input_tokens: 20, output_tokens: 5 },
  });
  turns[0].push({ type: 'end' });
  t.deepEqual(await drain(await readerP), [
    { type: 'phase', phase: 'claude session starting' },
    { type: 'phase', phase: 'responding' },
    { type: 'text-delta', text: 'Building. ' },
    {
      type: 'tool-call',
      id: 'toolu_1',
      name: 'mcp__endo__lookup',
      args: '{"name":"workspace"}',
    },
    {
      type: 'tool-result',
      id: 'toolu_1',
      name: 'mcp__endo__lookup',
      result: 'found',
    },
    { type: 'usage', inputTokens: 20, outputTokens: 5 },
    { type: 'end' },
  ]);

  // Without a per-turn persona the session prompt applies.
  E(run).send('again');
  for (let tries = 0; turns.length < 2 && tries < 50; tries += 1) {
    // eslint-disable-next-line no-await-in-loop
    await null;
  }
  t.deepEqual(turns[1].opts, {
    model: 'claude-opus-5',
    systemPrompt: 'default persona',
  });
});

test('interrupt() tolerates an idle session; acknowledge() is a no-op; status() is the client’s', async t => {
  const { factory, turns, interrupts } = makeHarness();
  const { run } = await E(factory).create(
    harden({ sessionId: 'session-a' }),
    makeToolSet(),
  );
  await t.notThrowsAsync(() => E(run).interrupt());
  t.is(interrupts(), 1);
  await E(run).send('long task');
  await t.notThrowsAsync(() => E(run).interrupt());
  t.is(interrupts(), 2);
  t.is(turns.length, 1);
  await t.notThrowsAsync(() => E(run).acknowledge('whatever'));
  t.like(await E(run).status(), { sessionId: 'x', conversationStarted: true });
});

test('terminate() stops once through the owner and a second create stops the first', async t => {
  const { factory, names } = makeHarness();
  const { admin } = await E(factory).create(
    harden({ sessionId: 'session-a' }),
    makeToolSet(),
  );
  await E(admin).terminate();
  await E(admin).terminate();
  t.deepEqual(names(), ['provision', 'stop']);
  await E(factory).create(harden({ sessionId: 'session-a' }), makeToolSet());
  await E(factory).create(harden({ sessionId: 'session-a' }), makeToolSet());
  t.deepEqual(names(), ['provision', 'stop', 'provision', 'stop', 'provision']);
});

test('a failed stop is retained: successors and deletion refuse until it succeeds', async t => {
  const { factory, names, failStop } = makeHarness();
  const { admin } = await E(factory).create(
    harden({ sessionId: 'session-a' }),
    makeToolSet(),
  );
  failStop('session-a');
  await t.throwsAsync(E(admin).terminate(), {
    message: /native cleanup pending/,
  });
  await t.throwsAsync(
    E(factory).create(harden({ sessionId: 'session-a' }), makeToolSet()),
    { message: /native cleanup pending/ },
  );
  await t.throwsAsync(E(factory).destroy(harden({ sessionId: 'session-a' })), {
    message: /native cleanup pending/,
  });
  // An unrelated session is unaffected.
  await E(factory).create(harden({ sessionId: 'session-b' }), makeToolSet());
  failStop(undefined);
  await E(admin).terminate();
  t.deepEqual(names(), [
    'provision',
    'stop',
    'stop',
    'stop',
    'provision',
    'stop',
  ]);
});

test('factory stop reaches an unretained owner and preserves state on retry', async t => {
  const { factory, names, failStop } = makeHarness();
  const spec = harden({ sessionId: 'session-a' });
  failStop('session-a');
  await t.throwsAsync(E(factory).stop(spec), {
    message: /native cleanup pending/,
  });
  t.deepEqual(
    names(),
    ['stop'],
    'no create or removal to recover an absent admin',
  );
  failStop(undefined);
  await E(factory).stop(spec);
  const { admin } = await E(factory).create(spec, makeToolSet());
  await E(factory).stop(spec);
  await E(admin).terminate();
  t.deepEqual(names(), ['stop', 'stop', 'provision', 'stop']);
  await E(factory).create(spec, makeToolSet());
  t.is(
    names().at(-1),
    'provision',
    'a completed stop permits explicit restart',
  );
  await t.throwsAsync(E(factory).stop(harden({ sessionId: '../foreign' })));
  t.false(names().includes('remove'));
});

test('factory stop retains failed live cleanup and fences only its successor', async t => {
  const { factory, names, failStop } = makeHarness();
  const spec = harden({ sessionId: 'session-a' });
  await E(factory).create(spec, makeToolSet());
  failStop('session-a');
  await t.throwsAsync(E(factory).stop(spec), {
    message: /native cleanup pending/,
  });
  await t.throwsAsync(E(factory).create(spec, makeToolSet()), {
    message: /native cleanup pending/,
  });
  await E(factory).create(harden({ sessionId: 'session-b' }), makeToolSet());
  failStop(undefined);
  await E(factory).stop(spec);
  t.deepEqual(names(), ['provision', 'stop', 'stop', 'provision', 'stop']);
});

test('destroy() stops a live session, then asks the owner to remove it; it is idempotent', async t => {
  const { factory, names } = makeHarness();
  await E(factory).create(harden({ sessionId: 'session-a' }), makeToolSet());
  await E(factory).destroy(harden({ sessionId: 'session-a' }));
  await E(factory).destroy(harden({ sessionId: 'session-a' }));
  t.deepEqual(names(), ['provision', 'stop', 'remove', 'remove']);
});

test('a refused plan propagates without any factory-side cleanup call', async t => {
  const { factory, names, failProvision } = makeHarness();
  failProvision(true);
  await t.throwsAsync(
    E(factory).create(harden({ sessionId: 'session-a' }), makeToolSet()),
    { message: /owner refused the plan/ },
  );
  t.deepEqual(names(), ['provision']);
  failProvision(false);
  await E(factory).create(harden({ sessionId: 'session-a' }), makeToolSet());
  t.deepEqual(names(), ['provision', 'provision']);
});
