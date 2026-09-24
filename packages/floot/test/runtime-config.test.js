// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';

import { makeStreamingAgent } from '../agent.js';
import { assertRuntimeConfig } from '../src/runtime-config.js';

test('journal storage must be explicit before guest or runtime side effects', async t => {
  let effects = 0;
  const powers = harden({
    list: () => {
      effects += 1;
      return [];
    },
  });
  for (const runtime of [
    {
      kind: 'provider',
      provideProvider: () => {
        effects += 1;
        return {};
      },
    },
    {
      kind: 'hosted',
      provideHostedClient: () => {
        effects += 1;
        return {};
      },
    },
    { kind: 'records-only' },
  ]) {
    for (const options of [
      undefined,
      {},
      { journalPowers: undefined },
      { journalPowers: null },
    ]) {
      // Each constructor attempt must refuse before any next attempt begins.
      // eslint-disable-next-line no-await-in-loop
      await t.throwsAsync(
        makeStreamingAgent(
          powers,
          undefined,
          /** @type {any} */ (runtime),
          'Test',
          /** @type {any} */ (options),
        ),
        { message: /Explicit journalPowers storage is required/ },
      );
    }
  }
  t.is(effects, 0);
});

test('runtime modes require exactly their own constructor', t => {
  for (const config of [
    { kind: 'provider', provideProvider: () => ({}) },
    { kind: 'hosted', provideHostedClient: () => ({}) },
    { kind: 'records-only' },
  ]) {
    t.notThrows(() => assertRuntimeConfig(/** @type {any} */ (config)));
  }
});

test('ambiguous and legacy runtime configurations fail before powers are used', async t => {
  let accessed = false;
  const powers = harden({
    list: () => {
      accessed = true;
      throw Error('Unexpected resource access');
    },
  });
  const invalid = [
    undefined,
    null,
    {},
    { provider: {} },
    { hostedClient: {} },
    { host: 'localhost', model: 'm', authToken: 'not-a-token' },
    { kind: 'provider' },
    { kind: 'provider', provideProvider: null },
    { kind: 'hosted', provideHostedClient: () => ({}), provider: {} },
    {
      kind: 'provider',
      provideProvider: () => ({}),
      provideHostedClient: () => ({}),
    },
    { kind: 'records-only', provideProvider: () => ({}) },
    { kind: 'other' },
    { __proto__: { kind: 'records-only' } },
    { __proto__: { kind: 'provider' }, provideProvider: () => ({}) },
  ];
  await Promise.all(
    invalid.map(config =>
      t.throwsAsync(
        makeStreamingAgent(powers, undefined, config, undefined, {
          journalPowers: powers,
        }),
        { message: /runtime configuration/ },
      ),
    ),
  );
  t.false(accessed);
});

test('records-only runtime reads history without admitting turns or inbox work', async t => {
  const store = new Map();
  const powers = harden({
    list: async () => harden([...store.keys()]),
    has: async name => store.has(name),
    lookup: async name => {
      if (!store.has(name)) throw Error('Not found');
      return store.get(name);
    },
    storeValue: async (value, name) => store.set(name, value),
    followMessages: () => t.fail('Records-only runtime consumed inbox'),
    locate: () => t.fail('Records-only runtime started inbox'),
  });
  const agent = await makeStreamingAgent(
    powers,
    undefined,
    {
      kind: 'records-only',
    },
    undefined,
    { journalPowers: powers },
  );
  t.teardown(() => agent.shutdown());
  t.deepEqual(await agent.getHistory(), []);
  const before = [...store.entries()];
  let aborted;
  await t.throwsAsync(
    agent.converse('must not execute', {
      abort: reason => {
        aborted = reason;
      },
    }),
    {
      message: /Records-only session cannot run turns/,
    },
  );
  t.is(aborted, 'Records-only session cannot run turns');
  agent.startInbox();
  t.deepEqual(await agent.getTurns(), []);
  t.deepEqual([...store.entries()], before);
});
