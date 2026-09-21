// @ts-check
import '@endo/init';

import test from 'ava';

import {
  makeCodexModelRead,
  modelsFromCodexCatalog,
} from '../src/codex-model-read.js';

const model = (extra = {}) => ({
  slug: 'provider-new-model',
  display_name: 'Provider model',
  description: 'Observed upstream',
  visibility: 'list',
  priority: 2,
  default_reasoning_level: 'adaptive',
  supported_reasoning_levels: [
    { effort: 'low', description: 'Low' },
    { effort: 'adaptive', description: 'Provider-added option' },
  ],
  supported_in_api: false,
  base_instructions: 'PRIVATE instructions must not leave this reader',
  ...extra,
});
const current = async () => ({
  state: { accessToken: 'PRIVATE-token', accountId: 'account-one' },
});
const response = (payload = { models: [model()] }) =>
  new Response(JSON.stringify(payload), { status: 200 });
const makeReader = (fetch, extra = {}) =>
  makeCodexModelRead({
    current,
    accountRef: 'account-one',
    clientVersion: '0.152.0',
    fetch,
    now: () => 1234,
    ...extra,
  });

test('provider metadata defines models, reasoning, visibility and priority without model names in code', t => {
  const models = modelsFromCodexCatalog({
    models: [
      model(),
      model({ slug: 'hidden', visibility: 'hide', priority: -1 }),
      model({ slug: 'not-listed', visibility: 'none' }),
      model({ slug: 'first-visible', priority: 0 }),
    ],
  });
  t.deepEqual(
    models.map(entry => entry.id),
    ['first-visible', 'provider-new-model'],
  );
  t.deepEqual(
    models.map(entry => entry.default),
    [true, false],
  );
  t.deepEqual(models[0].reasoningEfforts, ['low', 'adaptive']);
  t.is(models[0].defaultReasoningEffort, 'adaptive');
  t.false(JSON.stringify(models).includes('PRIVATE'));
  t.true(Object.isFrozen(models));
  t.deepEqual(modelsFromCodexCatalog({ models: [] }), []);
  t.deepEqual(
    modelsFromCodexCatalog({ models: [model({ visibility: 'hide' })] }),
    [],
  );
});

test('no reasoning default is represented as null without invented options', t => {
  const [entry] = modelsFromCodexCatalog({
    models: [
      model({
        default_reasoning_level: null,
        supported_reasoning_levels: [],
        description: null,
      }),
    ],
  });
  t.is(entry.defaultReasoningEffort, null);
  t.deepEqual(entry.reasoningEfforts, []);
  t.is(entry.description, '');
});

test('malformed and duplicate provider metadata is rejected, including hidden entries', t => {
  const bad = [
    { slug: '' },
    { slug: 'bad\nidentity' },
    { display_name: '' },
    { description: 3 },
    { visibility: 'unknown' },
    { priority: 0.5 },
    { priority: 2_147_483_648 },
    { supported_reasoning_levels: null },
    { supported_reasoning_levels: [{ effort: '' }] },
    { supported_reasoning_levels: [{ effort: 'low' }, { effort: 'low' }] },
    { default_reasoning_level: 'not-advertised' },
    { visibility: 'hide', default_reasoning_level: 'not-advertised' },
  ];
  for (const patch of bad)
    t.throws(() => modelsFromCodexCatalog({ models: [model(patch)] }));
  for (const payload of [
    null,
    [],
    {},
    { models: {} },
    { models: [null] },
    { models: [model(), model()] },
  ])
    t.throws(() => modelsFromCodexCatalog(payload));
});

test('host-only read uses the existing account credential with a fixed bounded GET and no inference', async t => {
  let calls = 0;
  let reads = 0;
  const reader = makeReader(
    async (url, options) => {
      calls += 1;
      t.is(
        url,
        'https://chatgpt.com/backend-api/codex/models?client_version=0.152.0',
      );
      t.is(options.method, 'GET');
      t.is(options.body, undefined);
      t.deepEqual(options.headers, {
        authorization: 'Bearer PRIVATE-token',
        'chatgpt-account-id': 'account-one',
        originator: 'codex_cli_rs',
        'user-agent': 'codex_cli_rs/0.152.0 (Endo model catalog)',
        accept: 'application/json',
      });
      t.is(options.redirect, 'error');
      t.is(options.credentials, 'omit');
      t.is(options.referrerPolicy, 'no-referrer');
      t.is(options.cache, 'no-store');
      t.true(options.signal instanceof AbortSignal);
      return response();
    },
    {
      current: async () => {
        reads += 1;
        return current();
      },
    },
  );
  const first = await reader();
  const second = await reader();
  t.is(first.accountRef, 'account-one');
  t.is(second.observedAt, 1234);
  t.is(calls, 2);
  t.is(reads, 2);
  t.false(JSON.stringify(first).includes('PRIVATE'));
});

test('an account mismatch or credential failure sends no HTTP request and leaks no cause', async t => {
  let calls = 0;
  for (const get of [
    async () => ({ state: { accessToken: 'PRIVATE', accountId: 'different' } }),
    async () => {
      throw Error('PRIVATE credential failure');
    },
    async () => ({
      state: { accessToken: 'PRIVATE\nheader', accountId: 'account-one' },
    }),
  ]) {
    // eslint-disable-next-line no-await-in-loop
    const error = await t.throwsAsync(
      makeReader(
        async () => {
          calls += 1;
          return response();
        },
        { current: get },
      ),
      {
        message: 'Codex model catalog unavailable',
      },
    );
    t.is(error.cause, undefined);
  }
  t.is(calls, 0);
});

test('HTTP, redirect/timeout transport, malformed and oversized responses are sanitized', async t => {
  for (const fetch of [
    async () => new Response('PRIVATE provider body', { status: 401 }),
    async () => new Response('PRIVATE redirect', { status: 302 }),
    async () => {
      throw Error('PRIVATE timeout URL');
    },
    async () => new Response('PRIVATE malformed JSON'),
    async () => new Response('x'.repeat(8 * 1024 * 1024 + 1)),
    async () =>
      response({ models: [model({ default_reasoning_level: 'PRIVATE' })] }),
  ]) {
    // eslint-disable-next-line no-await-in-loop
    const error = await t.throwsAsync(makeReader(fetch), {
      message: 'Codex model catalog unavailable',
    });
    t.is(error.cause, undefined);
  }
});

test('version/account configuration cannot add headers, paths or queries', t => {
  for (const clientVersion of [
    '',
    '0.152.0&token=x',
    '../models',
    '0.152.0\n',
    'latest',
  ])
    t.throws(() => makeReader(async () => response(), { clientVersion }));
  for (const accountRef of ['', 'bad\naccount', 'account/path'])
    t.throws(() => makeReader(async () => response(), { accountRef }));
});

test('body-read transport abort is sanitized after successful response headers', async t => {
  const reader = makeReader(async (_url, options) => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"models":['));
        options.signal.addEventListener(
          'abort',
          () => {
            controller.error(Error('PRIVATE body timeout'));
          },
          { once: true },
        );
        // Simulate native fetch propagating its request deadline into the body
        // stream, after headers have already returned. No real network used.
        queueMicrotask(() => options.signal.dispatchEvent(new Event('abort')));
      },
    });
    return new Response(body);
  });
  await t.throwsAsync(reader, { message: 'Codex model catalog unavailable' });
});
