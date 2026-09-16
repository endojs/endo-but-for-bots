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
 * A fake owner session facet: each send() hands back a fresh buffered reader
 * the test drives, and records the prompt and options it was given.
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
        throw Error('OpencodeClient(x): no in-flight prompt to interrupt.');
      idle = true;
    },
    async status() {
      return harden({ sessionId: 'x', turnActive: !idle, stopping: false });
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
  const log = [];
  const { facet, turns, interrupts } = makeFakeSession();
  /** @type {string | undefined} */
  let failingStop;
  let provisionFails = false;
  const factory = makeOpencodeBackendFactory({
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
    failProvision: value => {
      provisionFails = value;
    },
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
  t.true(models.some(model => model.default));
});

test('create() hands the validated request and the pinned tool set to the owner', async t => {
  const { factory, log } = makeHarness();
  const { run, admin } = await E(factory).create(
    harden({
      sessionId: 'session-a',
      model: OPENCODE_MODELS[0].id,
      systemPrompt: 'You are Floot.',
      workspaceHostPath: '/srv/worktrees/a',
      networkPolicy: 'public-internet',
    }),
    makeToolSet(),
  );
  t.deepEqual(log, [
    [
      'provision',
      'session-a',
      {
        networkPolicy: 'public-internet',
        model: OPENCODE_MODELS[0].id,
        systemPrompt: 'You are Floot.',
        workspaceHostPath: '/srv/worktrees/a',
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
  t.is(typeof run.send, 'function');
  await E(admin).terminate();
  t.deepEqual(log.at(-1), ['stop', 'session-a']);
});

/** @type {readonly [string, Record<string, unknown>, RegExp][]} */
const refused = harden([
  [
    'an unknown model',
    { model: 'openrouter/nobody/none' },
    /Unknown OpenCode model/,
  ],
  [
    'a reasoning effort',
    { reasoningEffort: 'high' },
    /no reasoning-effort setting/,
  ],
  [
    'container mounts',
    { containerMounts: [{ hostPath: '/x' }] },
    /container mounts/,
  ],
  [
    'a relative workspace',
    { workspaceHostPath: 'relative' },
    /normalized absolute host path/,
  ],
  ['an unknown policy', { networkPolicy: 'lan' }, /Unknown network policy/],
  [
    'a malformed session id',
    { sessionId: 'Session A' },
    /bounded lowercase path component/,
  ],
]);

for (const [name, overrides, message] of refused) {
  test(`create() refuses ${name} before reaching the owner`, async t => {
    const { factory, log } = makeHarness();
    await t.throwsAsync(
      () =>
        E(factory).create(
          harden({ sessionId: 'session-a', ...overrides }),
          makeToolSet(),
        ),
      { message },
    );
    t.deepEqual(log, []);
  });
}

test('send() carries the turn\u2019s options, not just the persona', async t => {
  // The factory used to rebuild this record from named fields, so every
  // continuity option the stack added was dropped on the way to the client —
  // which then had nothing to restore from and started the conversation over.
  const { factory, turns } = makeHarness();
  const { run } = await E(factory).create(
    harden({ sessionId: 'session-t', systemPrompt: 'persona' }),
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
});

test('send() forwards the session persona and passes the reader through', async t => {
  const { factory, turns } = makeHarness();
  const { run } = await E(factory).create(
    harden({ sessionId: 'session-a', systemPrompt: 'persona' }),
    makeToolSet(),
  );
  const readerP = E(run).send('hello');
  for (let tries = 0; turns.length === 0 && tries < 50; tries += 1) {
    // eslint-disable-next-line no-await-in-loop
    await null;
  }
  t.is(turns[0].opts.systemPrompt, 'persona');
  turns[0].push({ type: 'text-delta', text: 'hi' });
  turns[0].push({ type: 'end' });
  t.deepEqual(await drain(await readerP), [
    { type: 'text-delta', text: 'hi' },
    { type: 'end' },
  ]);
  void E(run).send('again', harden({ systemPrompt: 'override' }));
  for (let tries = 0; turns.length < 2 && tries < 50; tries += 1) {
    // eslint-disable-next-line no-await-in-loop
    await null;
  }
  t.is(turns[1].opts.systemPrompt, 'override');
  t.deepEqual(await E(run).status(), {
    sessionId: 'x',
    turnActive: true,
    stopping: false,
  });
});

test('interrupt() tolerates an idle session; acknowledge() is a no-op', async t => {
  const { factory, interrupts } = makeHarness();
  const { run } = await E(factory).create(
    harden({ sessionId: 'session-a' }),
    makeToolSet(),
  );
  await E(run).interrupt();
  t.is(interrupts(), 1);
  await E(run).acknowledge('checkpoint');
  t.deepEqual(await E(run).models(), OPENCODE_MODELS);
});

test('terminate() stops once through the owner and a second create stops the first', async t => {
  const { factory, log, names } = makeHarness();
  const first = await E(factory).create(
    harden({ sessionId: 'session-a' }),
    makeToolSet(),
  );
  await E(first.admin).terminate();
  await E(first.admin).terminate();
  t.deepEqual(names(), ['provision', 'stop']);
  await E(factory).create(harden({ sessionId: 'session-a' }), makeToolSet());
  await E(factory).create(harden({ sessionId: 'session-a' }), makeToolSet());
  // The second live create stopped the predecessor before provisioning again.
  t.deepEqual(names(), ['provision', 'stop', 'provision', 'stop', 'provision']);
  t.is(log.filter(([name]) => name === 'remove').length, 0);
});

test('a failed stop is retained: successors and deletion refuse until it succeeds', async t => {
  const { factory, names, failStop } = makeHarness();
  const { admin } = await E(factory).create(
    harden({ sessionId: 'session-a' }),
    makeToolSet(),
  );
  failStop('session-a');
  await t.throwsAsync(() => E(admin).terminate(), {
    message: /native cleanup pending/,
  });
  await t.throwsAsync(
    () => E(factory).create(harden({ sessionId: 'session-a' }), makeToolSet()),
    { message: /native cleanup pending/ },
  );
  await t.throwsAsync(
    () => E(factory).destroy(harden({ sessionId: 'session-a' })),
    { message: /native cleanup pending/ },
  );
  // Independent sessions are unaffected.
  const other = await E(factory).create(
    harden({ sessionId: 'session-b' }),
    makeToolSet(),
  );
  await E(other.admin).terminate();
  failStop(undefined);
  await E(factory).destroy(harden({ sessionId: 'session-a' }));
  t.deepEqual(names().slice(-2), ['stop', 'remove']);
  t.is(names().filter(name => name === 'remove').length, 1);
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
    () => E(factory).create(harden({ sessionId: 'session-a' }), makeToolSet()),
    { message: /owner refused the plan/ },
  );
  t.deepEqual(names(), ['provision']);
  // The owner retained whatever it acquired; a later destroy reaches it.
  await E(factory).destroy(harden({ sessionId: 'session-a' }));
  t.deepEqual(names(), ['provision', 'remove']);
});
