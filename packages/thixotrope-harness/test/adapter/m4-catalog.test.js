// @ts-check
// M4 W4.3: the pool catalogue
// (resources/agent-host/impl/subscriptions/catalog.js; designs/m4-interfaces.md
// 5.4) against the fake subscription server (127.0.0.1), with fake members
// and a fake clock: `codex-pool` lists the intersection of its members'
// efforts and the smallest context length (R4-18); `claude-pool` the union
// of its members' models with efforts by model and the spec's context
// length only (R4-19; D-M4-5 at creation); a read where no member answers
// is `unavailable`; the cache serves a second listing within 15 minutes
// without a read, reads again after, and waits 60 s after a failed read
// (R4-104); rows, selection ids and pages as M2 8.4; creation's model and
// effort checks.
import '../unit/_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';

/* eslint-disable import/no-relative-packages */
import { texts, textOf } from '../../guest/lib/interfaces.js';
import { subscriptionTexts } from '../../guest/lib/subscription-texts.js';
/* eslint-enable import/no-relative-packages */
import {
  codexModels,
  makePoolCatalog,
  pooledCodexModels,
} from '../../resources/agent-host/impl/subscriptions/catalog.js';
import {
  BODY_MARKER,
  startFakeSubscriptionServer,
} from '../fixtures/fake-subscription-server.mjs';

const { Far } = /** @type {any} */ (globalThis);

// Placeholders that do not look like provider tokens (joined at run time).
const tokenOf = (/** @type {string} */ name) =>
  ['fake', 'access', 'w43', name].join('-');

/**
 * A member entry as `PoolStateBridge.load` gives it.
 * @param {string} label
 * @param {'claude' | 'codex'} provider
 * @param {'active' | 'retired'} [state]
 */
const memberEntry = (label, provider, state = 'active') =>
  harden({
    member: Far('PoolMember', {}),
    label,
    provider,
    weight: 1,
    key: `k-${label}`,
    state,
  });

/**
 * @param {import('ava').ExecutionContext} t
 * @param {object} options
 * @param {'claude-pool' | 'codex-pool'} options.kind
 * @param {Record<string, string>} options.files member label -> model
 *   fixture (`undefined`: that member's read is refused)
 * @param {any} [options.spec]
 * @param {Set<string>} [options.unreadable] labels whose credential fails
 */
const setup = async (t, { kind, files, spec: extra = {}, unreadable }) => {
  const provider = kind === 'claude-pool' ? 'claude' : 'codex';
  const path =
    provider === 'claude' ? '/v1/models' : '/backend-api/codex/models';
  const tags = new Map(
    Object.keys(files).map(label => [tokenOf(label), label]),
  );
  const server = await startFakeSubscriptionServer({
    credentialTag: value => tags.get(value),
  });
  t.teardown(server.close);
  const entries = Object.keys(files).map(label => memberEntry(label, provider));
  // One standing answer per member, told apart by the credential it sends.
  server.setPlan(
    Object.entries(files).map(([label, file]) =>
      file === undefined
        ? {
            match: { method: 'GET', path, credential: label },
            status: 503,
            repeat: 1000,
          }
        : {
            match: { method: 'GET', path, credential: label },
            file,
            repeat: 1000,
          },
    ),
  );
  let clock = 1_000_000;
  const backend = Far('Backend', {});
  const spec = harden({
    kind,
    label: 'pool',
    members: entries.map(e => e.member),
    baseUrl: server.url,
    ...extra,
  });
  const catalog = makePoolCatalog({
    now: () => clock,
    members: async () => entries,
    readCredential: async entry => {
      if (unreadable?.has(entry.label)) throw Error('UNREADABLE');
      return harden({
        accessToken: tokenOf(entry.label),
        expiresAtMs: 4_000_000_000_000,
      });
    },
  });
  return {
    server,
    catalog,
    backend,
    spec,
    entries,
    advance: (/** @type {number} */ ms) => {
      clock += ms;
    },
    reads: () => server.requests().filter(r => r.method === 'GET').length,
  };
};

test('codexModels: listed rows by priority, efforts as listed, context window', t => {
  const models = codexModels({
    models: [
      {
        slug: 'b',
        display_name: 'B',
        visibility: 'list',
        priority: 2,
        supported_reasoning_levels: [{ effort: 'low' }],
      },
      {
        slug: 'a',
        display_name: 'A',
        visibility: 'list',
        priority: 1,
        default_reasoning_level: 'low',
        supported_reasoning_levels: [{ effort: 'low' }, { effort: 'ultra' }],
        context_window: 1000,
      },
      {
        slug: 'h',
        visibility: 'hide',
        priority: 0,
        supported_reasoning_levels: [],
      },
    ],
  });
  t.deepEqual(
    models.map(m => m.id),
    ['a', 'b'],
  );
  t.deepEqual(models[0].reasoningEfforts, ['low', 'ultra']);
  t.is(models[0].contextLength, 1000);
  t.throws(() => codexModels({ models: [{ slug: 'x' }] }));
  t.throws(() => codexModels([]));
});

test('pooledCodexModels: intersection of efforts, agreed default only, smallest limits', t => {
  const [one] = pooledCodexModels([
    [
      {
        id: 'm',
        title: 'M',
        description: '',
        reasoningEfforts: ['low', 'medium', 'ultra'],
        defaultReasoningEffort: 'medium',
        contextLength: 300,
        maxOutputTokens: 50,
      },
    ],
    [
      {
        id: 'm',
        title: 'M',
        description: '',
        reasoningEfforts: ['medium', 'max'],
        defaultReasoningEffort: 'medium',
        contextLength: 200,
      },
    ],
  ]);
  t.deepEqual(one.reasoningEfforts, ['medium', 'max']);
  t.is(one.defaultReasoningEffort, 'medium');
  t.is(one.contextLength, 200);
  t.is(one.maxOutputTokens, undefined, 'one member does not say');
});

test('codex-pool listing: R4-18 intersection over two members; rows as M2 8.4', async t => {
  const s = await setup(t, {
    kind: 'codex-pool',
    files: { a: 'codex-models.json', b: 'codex-models-b.json' },
  });
  const page = await s.catalog.listModels({ backend: s.backend, spec: s.spec });
  t.is(page.state, 'ok');
  t.deepEqual(
    page.rows.map((/** @type {any} */ r) => r.modelId),
    ['gpt-fake-1', 'gpt-fake-b-only', 'gpt-fake-mini'],
  );
  const shared = page.rows.find(
    (/** @type {any} */ r) => r.modelId === 'gpt-fake-1',
  );
  t.is(shared.selectionId, 'pool:gpt-fake-1');
  t.false(shared.default);
  t.is(shared.backend, s.backend);
  t.deepEqual(shared.reasoningEfforts, ['medium', 'high', 'max']);
  t.is(shared.defaultReasoningEffort, undefined, 'members disagree');
  t.is(shared.contextLength, 200_000, 'the smaller window');
  t.is(shared.description, 'A fake model for tests.');
  const mini = page.rows.find(
    (/** @type {any} */ r) => r.modelId === 'gpt-fake-mini',
  );
  t.deepEqual(mini.reasoningEfforts, ['low', 'medium']);
  t.is(mini.defaultReasoningEffort, 'low');
  t.is(s.reads(), 2, 'one read per member');
  const requests = s.server.requests();
  t.deepEqual(
    requests.map(r => r.credential).sort(),
    ['a', 'b'],
    "each member's list read with its own credential",
  );
  t.is(requests[0].query.client_version, '0.152.0');
  t.true(requests[0].headerNames.includes('originator'));
  // The default backend: bare selection ids and the configured default row.
  const asDefault = await s.catalog.listModels({
    backend: s.backend,
    spec: s.spec,
    request: { defaultBackend: s.backend, defaultModelId: 'gpt-fake-mini' },
  });
  t.is(asDefault.rows[0].modelId, 'gpt-fake-mini');
  t.true(asDefault.rows[0].default);
  t.is(asDefault.rows[0].selectionId, 'gpt-fake-mini');
  // Paging: limit and cursor.
  const first = await s.catalog.listModels({
    backend: s.backend,
    spec: s.spec,
    request: { limit: 2 },
  });
  t.is(first.rows.length, 2);
  t.is(first.next, 'pool:gpt-fake-b-only');
  const second = await s.catalog.listModels({
    backend: s.backend,
    spec: s.spec,
    request: { after: first.next },
  });
  t.deepEqual(
    second.rows.map((/** @type {any} */ r) => r.modelId),
    ['gpt-fake-mini'],
  );
  t.is(s.reads(), 2, 'later listings within 15 min read nothing (R4-104)');
});

test('claude-pool listing: R4-19 union with efforts by model and no context length unless the spec sets one', async t => {
  const s = await setup(t, {
    kind: 'claude-pool',
    files: { a: 'claude-models.json', b: 'claude-models-b.json' },
  });
  const page = await s.catalog.listModels({ backend: s.backend, spec: s.spec });
  t.deepEqual(
    page.rows.map((/** @type {any} */ r) => r.modelId),
    ['claude-fake-1', 'claude-haiku-5-5', 'claude-opus-4-6', 'claude-sonnet-5'],
  );
  const sonnet = page.rows.find(
    (/** @type {any} */ r) => r.modelId === 'claude-sonnet-5',
  );
  t.deepEqual(sonnet.reasoningEfforts, [
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
  ]);
  t.is(sonnet.contextLength, undefined);
  const fake = page.rows.find(
    (/** @type {any} */ r) => r.modelId === 'claude-fake-1',
  );
  t.deepEqual(fake.reasoningEfforts, []);
  const [request] = s.server.requests();
  t.is(request.path, '/v1/models');
  t.true(request.authorization);
  t.true(request.headerNames.includes('anthropic-beta'));
  t.false(request.headerNames.includes('x-api-key'));

  const configured = await setup(t, {
    kind: 'claude-pool',
    files: { a: 'claude-models.json' },
    spec: { contextLength: 150_000 },
  });
  const rows = (
    await configured.catalog.listModels({
      backend: configured.backend,
      spec: configured.spec,
    })
  ).rows;
  t.true(rows.every((/** @type {any} */ r) => r.contextLength === 150_000));
});

test('creation: resolveModel and efforts (R4-21, R4-22, R4-23; D-M4-5, R4-92)', async t => {
  const claude = await setup(t, {
    kind: 'claude-pool',
    files: { a: 'claude-models.json' },
  });
  const base = { backend: claude.backend, spec: claude.spec };
  t.deepEqual(
    await claude.catalog.resolveModel({ ...base, modelId: 'claude-sonnet-5' }),
    {
      modelId: 'claude-sonnet-5',
      contextLength: 200_000,
      maxOutputTokens: 16_384,
    },
  );
  t.deepEqual(
    await claude.catalog.efforts({ ...base, modelId: 'claude-opus-4-6' }),
    { reasoningEfforts: ['low', 'medium', 'high', 'max'] },
  );
  await t.throwsAsync(claude.catalog.resolveModel(base), {
    message: subscriptionTexts.subscriptionModelRequired,
  });
  await t.throwsAsync(
    claude.catalog.resolveModel({ ...base, modelId: 'claude-none' }),
    { message: textOf.unknownProviderModel('claude-none') },
  );
  // The spec's model is the default choice.
  t.like(
    await claude.catalog.resolveModel({
      backend: claude.backend,
      spec: { ...claude.spec, modelId: 'claude-fake-1', maxOutputTokens: 900 },
    }),
    { modelId: 'claude-fake-1', maxOutputTokens: 900 },
  );

  const codex = await setup(t, {
    kind: 'codex-pool',
    files: { a: 'codex-models.json' },
  });
  const cbase = { backend: codex.backend, spec: codex.spec };
  t.deepEqual(
    await codex.catalog.resolveModel({ ...cbase, modelId: 'gpt-fake-1' }),
    { modelId: 'gpt-fake-1', contextLength: 272_000 },
  );
  t.deepEqual(
    await codex.catalog.efforts({ ...cbase, modelId: 'gpt-fake-1' }),
    {
      reasoningEfforts: ['low', 'medium', 'high', 'max'],
      defaultReasoningEffort: 'medium',
    },
  );
});

test('unavailable when no member answers; a failed member is not asked again for 60 s; the cache reads again after 15 min', async t => {
  const s = await setup(t, {
    kind: 'codex-pool',
    // @ts-expect-error a member whose read is refused
    files: { a: 'codex-models.json', b: undefined },
    unreadable: new Set(['a']),
  });
  const none = await s.catalog.listModels({ backend: s.backend, spec: s.spec });
  t.deepEqual(none, {
    rows: [],
    state: 'unavailable',
    error: texts.catalogUnavailable,
  });
  t.false(JSON.stringify(none).includes(BODY_MARKER));
  t.is(s.reads(), 1, 'a unreadable credential sends nothing; b refused');
  await t.throwsAsync(
    s.catalog.resolveModel({
      backend: s.backend,
      spec: s.spec,
      modelId: 'gpt-fake-1',
    }),
    { message: texts.catalogUnavailable },
  );
  t.is(s.reads(), 1, 'not asked again within 60 s');
  s.advance(60_000);
  await s.catalog.listModels({ backend: s.backend, spec: s.spec });
  t.is(s.reads(), 2, 'asked again after 60 s');
  t.deepEqual(s.catalog.stats(s.entries[1].member), {
    reads: 2,
    failures: 2,
    failed: true,
  });
});

test('cache: a fresh listing reads nothing, a stale one reads again, one past 24 h without an answer is unavailable', async t => {
  const s = await setup(t, {
    kind: 'claude-pool',
    files: { a: 'claude-models.json' },
  });
  await s.catalog.listModels({ backend: s.backend, spec: s.spec });
  s.advance(14 * 60_000);
  await s.catalog.listModels({ backend: s.backend, spec: s.spec });
  t.is(s.reads(), 1, 'fresh for 15 min');
  s.advance(2 * 60_000);
  const again = await s.catalog.listModels({
    backend: s.backend,
    spec: s.spec,
  });
  t.is(s.reads(), 2, 'read again when stale');
  t.is(again.state, 'ok');
  // The provider stops answering: the last observation serves until 24 h.
  s.server.setPlan([
    {
      match: { method: 'GET', path: '/v1/models', credential: 'a' },
      status: 503,
      repeat: 10,
    },
  ]);
  s.advance(16 * 60_000);
  t.is(
    (await s.catalog.listModels({ backend: s.backend, spec: s.spec })).state,
    'ok',
    'a stale observation still lists when the read fails',
  );
  t.is(s.reads(), 3);
  s.advance(24 * 60 * 60_000);
  t.is(
    (await s.catalog.listModels({ backend: s.backend, spec: s.spec })).state,
    'unavailable',
  );
  // Retired members are left out.
  const retired = await setup(t, {
    kind: 'claude-pool',
    files: { a: 'claude-models.json' },
  });
  const entries = retired.entries.map(e => ({ ...e, state: 'retired' }));
  const catalog = makePoolCatalog({
    members: async () => /** @type {any} */ (entries),
    readCredential: async () => {
      throw Error('not read');
    },
  });
  t.is(
    (await catalog.listModels({ backend: retired.backend, spec: retired.spec }))
      .state,
    'unavailable',
  );
});
