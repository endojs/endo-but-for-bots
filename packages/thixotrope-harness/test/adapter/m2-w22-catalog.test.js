// @ts-check
// M2 W2.2: the model catalogue (resources/agent-host/impl/providers/
// catalog.js; designs/m2-interfaces.md 8.4; spec R4-17, R4-20, R4-21,
// R4-22, R4-104) against the fake provider server (127.0.0.1, D-M2-4) with
// hand-written catalogue fixtures, and through the agent host's ops facet
// (AH/index.js wiring, attach.js guard). Ported cases of hosted-agent's
// catalogue owner: single-flight reads, freshness, the retry pause, the
// 24-hour maximum age, failure as a state without a cause.
import '../unit/_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';

/* eslint-disable import/no-relative-packages */
import { shapes, texts, textOf } from '../../guest/lib/interfaces.js';
import { limits } from '../../guest/lib/limits.js';
import { messageBytes } from '../../guest/lib/bounded.js';
/* eslint-enable import/no-relative-packages */
import {
  CATALOG_FRESH_MS,
  CATALOG_MAX_AGE_MS,
  CATALOG_RETRY_MS,
  makeCatalog,
} from '../../resources/agent-host/impl/providers/catalog.js';
import { makeAgentHostImpl } from '../../resources/agent-host/impl/index.js';
import {
  BODY_MARKER,
  startFakeProviderServer,
} from '../fixtures/fake-provider-server.mjs';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { E, Far, matches } = /** @type {GuestGlobals} */ (globalThis);

const KEY = 'not a real key';
const OR_MODELS = { method: 'GET', path: '/api/v1/models' };
const AN_MODELS = { method: 'GET', path: '/v1/models' };

/**
 * A settable clock.
 * @param {number} [start]
 */
const makeClock = (start = 1_000_000) => {
  let at = start;
  return {
    now: () => at,
    /** @param {number} ms */
    advance: ms => {
      at += ms;
    },
  };
};

/**
 * @param {any} server the fake provider server
 * @param {string} [label]
 * @param {Record<string, any>} [extra]
 */
const openRouterSpec = (server, label = 'or', extra = {}) =>
  harden({
    kind: 'openrouter',
    label,
    keyGrant: Far('ReadGrant', {}),
    baseUrl: server.openRouterBaseUrl,
    modelId: 'deepseek/deepseek-v4.1-flash',
    ...extra,
  });

/** @param {any[]} lines */
const logInto =
  lines =>
  (kind, fields = {}) => {
    lines.push(JSON.stringify({ kind, ...fields }));
  };

const withServer = async (t, plan = []) => {
  const server = await startFakeProviderServer({ plan });
  t.teardown(() => server.close());
  return server;
};

const flush = () => new Promise(resolve => setTimeout(resolve, 20));

test('OpenRouter rows: read with the key, filtered, sorted (R4-20), no efforts (R4-23)', async t => {
  const server = await withServer(t, [
    { match: OR_MODELS, file: 'openrouter-models.json' },
  ]);
  const catalog = makeCatalog();
  const backend = Far('Backend', {});
  const spec = openRouterSpec(server);
  const page = await catalog.listModels({
    backend,
    spec,
    readKey: async () => KEY,
    request: { defaultBackend: backend },
  });
  t.true(matches(page, shapes.ModelPage));
  t.is(page.state, 'ok');
  t.is(page.next, undefined);
  t.deepEqual(
    page.rows.map(row => row.modelId),
    [
      // default first (the spec's model on the default backend) ...
      'deepseek/deepseek-v4.1-flash',
      // ... then title ignoring case ('alpha model' twice: by id) ...
      'acme/alpha-a',
      'acme/alpha-b',
      'anthropic/claude-sonnet-4.6',
    ],
  );
  t.deepEqual(
    page.rows.map(row => row.default),
    [true, false, false, false],
  );
  // The bare model id on the default backend.
  t.deepEqual(
    page.rows.map(row => row.selectionId),
    page.rows.map(row => row.modelId),
  );
  t.true(page.rows.every(row => row.backend === backend));
  t.true(page.rows.every(row => row.reasoningEfforts.length === 0));
  const [first] = page.rows;
  t.is(first.contextLength, 163_840);
  t.is(first.maxOutputTokens, 32_768);
  t.is(first.title, 'DeepSeek: DeepSeek V4.1 Flash');
  t.is(page.rows[1].description, undefined);
  const [request] = server.requests();
  t.is(request.method, 'GET');
  t.is(request.path, '/api/v1/models');
  t.true(request.authorization);
});

test('another backend: selection ids are <label>:<model>; the factory model marks the default (R4-20)', async t => {
  const server = await withServer(t, [
    { match: OR_MODELS, file: 'openrouter-models.json', repeat: 2 },
  ]);
  const catalog = makeCatalog();
  const backend = Far('Backend', {});
  const other = Far('Backend', {});
  const spec = openRouterSpec(server, 'second');
  const scoped = await catalog.listModels({
    backend,
    spec,
    readKey: async () => KEY,
    request: { defaultBackend: other },
  });
  t.true(scoped.rows.every(row => !row.default));
  t.deepEqual(
    scoped.rows.map(row => row.selectionId),
    scoped.rows.map(row => `second:${row.modelId}`),
  );
  // No defaultBackend in the request: no default, prefixed ids.
  const plain = await catalog.listModels({
    backend,
    spec,
    readKey: async () => KEY,
  });
  t.deepEqual(plain.rows, scoped.rows);
  // On the default backend, HarnessSettings.defaultModelId wins over the
  // spec's model.
  const configured = await catalog.listModels({
    backend,
    spec,
    readKey: async () => KEY,
    request: { defaultBackend: backend, defaultModelId: 'acme/alpha-b' },
  });
  t.deepEqual(
    configured.rows.map(row => [row.modelId, row.default]),
    [
      ['acme/alpha-b', true],
      ['acme/alpha-a', false],
      ['anthropic/claude-sonnet-4.6', false],
      ['deepseek/deepseek-v4.1-flash', false],
    ],
  );
  // One read served all three listings (fresh for 15 min).
  t.is(server.requests().length, 1);
});

test('a failed read answers unavailable with the fixed text and no provider body (R4-17, R4-79)', async t => {
  const server = await withServer(t, [{ match: OR_MODELS, status: 500 }]);
  const lines = [];
  const catalog = makeCatalog();
  const backend = Far('Backend', {});
  const page = await catalog.listModels({
    backend,
    spec: openRouterSpec(server),
    readKey: async () => KEY,
    log: logInto(lines),
  });
  t.deepEqual(page, {
    rows: [],
    state: 'unavailable',
    error: texts.catalogUnavailable,
  });
  t.true(matches(page, shapes.ModelPage));
  t.is(lines.length, 1);
  t.false(lines.join('\n').includes(BODY_MARKER));
  t.false(lines.join('\n').includes(KEY));
  t.true(lines[0].includes('HTTP 500'));
  await t.throwsAsync(
    () =>
      catalog.resolveModel({
        backend,
        spec: openRouterSpec(server),
        readKey: async () => KEY,
        modelId: 'acme/alpha-a',
      }),
    { message: texts.catalogUnavailable },
  );
});

test('malformed catalogues fail whole, as hosted-agent (fail closed)', async t => {
  const bad = [
    { body: '{"data": 3}' },
    { body: 'not json' },
    { body: { data: [{ id: 'has space/x', name: 'x', architecture: {} }] } },
    {
      body: {
        data: [
          {
            id: 'a/b',
            name: 'x',
            architecture: {
              input_modalities: ['text'],
              output_modalities: ['text'],
            },
            supported_parameters: ['tools'],
            context_length: -1,
          },
        ],
      },
    },
    { body: { data: [], links: { next: 'more' } } },
    { body: { data: [], total_count: 3 } },
  ];
  const server = await withServer(
    t,
    bad.map(entry => ({ match: OR_MODELS, ...entry })),
  );
  for (const [index] of bad.entries()) {
    const catalog = makeCatalog();
    // eslint-disable-next-line no-await-in-loop
    const page = await catalog.listModels({
      backend: Far('Backend', {}),
      spec: openRouterSpec(server),
      readKey: async () => KEY,
    });
    t.is(page.state, 'unavailable', `case ${index}`);
  }
});

test('R4-104: fresh 15 min, stale served until 24 h, a failed read paused 60 s, single-flight', async t => {
  const server = await withServer(t);
  const clock = makeClock();
  const catalog = makeCatalog({ now: clock.now });
  const backend = Far('Backend', {});
  const spec = openRouterSpec(server);
  const list = () =>
    catalog.listModels({ backend, spec, readKey: async () => KEY });
  const reads = () => server.requests().length;

  // Two listings at once: one read (single-flight).
  server.setPlan([
    {
      match: OR_MODELS,
      file: 'openrouter-models.json',
      firstByteDelayMs: 50,
    },
  ]);
  const [a, b] = await Promise.all([list(), list()]);
  t.deepEqual(a, b);
  t.is(a.state, 'ok');
  t.is(reads(), 1);

  // Within 15 minutes: no read.
  clock.advance(CATALOG_FRESH_MS - 1);
  t.is((await list()).state, 'ok');
  t.is(reads(), 1);

  // Past 15 minutes: read again; the read fails; the old rows still show.
  clock.advance(2);
  server.setPlan([{ match: OR_MODELS, status: 503 }]);
  t.is((await list()).rows.length, 4);
  t.is(reads(), 2);
  t.deepEqual(catalog.stats(backend), { reads: 2, failures: 1, failed: true });

  // Within 60 s of the failure: no read.
  clock.advance(CATALOG_RETRY_MS - 1);
  t.is((await list()).rows.length, 4);
  t.is(reads(), 2);

  // After 60 s: read again (fails again), still within 24 h.
  clock.advance(1);
  server.setPlan([{ match: OR_MODELS, status: 503 }]);
  t.is((await list()).state, 'ok');
  t.is(reads(), 3);

  // 24 h after the last good read: nothing usable.
  clock.advance(CATALOG_MAX_AGE_MS);
  server.setPlan([{ match: OR_MODELS, status: 503 }]);
  t.is((await list()).state, 'unavailable');
  t.is(reads(), 4);

  // A good read restores the catalogue.
  clock.advance(CATALOG_RETRY_MS);
  server.setPlan([{ match: OR_MODELS, file: 'openrouter-models.json' }]);
  t.is((await list()).state, 'ok');
  t.deepEqual(catalog.stats(backend), {
    reads: 5,
    failures: 3,
    failed: false,
  });
});

test('a creation answers from a usable observation and refreshes in the background', async t => {
  const server = await withServer(t, [
    { match: OR_MODELS, file: 'openrouter-models.json' },
  ]);
  const clock = makeClock();
  const catalog = makeCatalog({ now: clock.now });
  const backend = Far('Backend', {});
  const spec = openRouterSpec(server, 'or', { maxOutputTokens: 2048 });
  const resolve = modelId =>
    catalog.resolveModel({
      backend,
      spec,
      readKey: async () => KEY,
      ...(modelId === undefined ? {} : { modelId }),
    });
  // The spec's model when none is given; the window from the catalogue
  // (R4-33); the output limit from the spec, never the catalogue (R4-92).
  t.deepEqual(await resolve(), {
    modelId: 'deepseek/deepseek-v4.1-flash',
    contextLength: 163_840,
    maxOutputTokens: 2048,
  });
  t.deepEqual(await resolve('acme/alpha-a'), {
    modelId: 'acme/alpha-a',
    maxOutputTokens: 2048,
  });
  // Past freshness: the answer does not wait for the provider.
  clock.advance(CATALOG_FRESH_MS + 1);
  server.setPlan([{ match: OR_MODELS, hang: true }]);
  t.deepEqual(await resolve('acme/alpha-b'), {
    modelId: 'acme/alpha-b',
    contextLength: 8192,
    maxOutputTokens: 2048,
  });
  // The background read reaches the server (polled: the lane runs files in
  // parallel, so a fixed wait is not enough).
  const t0 = Date.now();
  while (server.requests().length < 2 && Date.now() - t0 < 5000) {
    // eslint-disable-next-line no-await-in-loop
    await flush();
  }
  t.is(server.requests().length, 2);
});

test('selection rules (R4-21): prefix, unknown model, model required; texts exact', async t => {
  const server = await withServer(t, [
    { match: OR_MODELS, file: 'openrouter-models.json' },
  ]);
  const catalog = makeCatalog();
  const backend = Far('Backend', {});
  const base = {
    backend,
    readKey: async () => KEY,
  };
  const spec = openRouterSpec(server);
  for (const modelId of ['no-prefix', '/model', 'org/', 'org model/x']) {
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(
      () => catalog.resolveModel({ ...base, spec, modelId }),
      {
        message: texts.openRouterModelPrefix,
      },
    );
  }
  // The prefix is checked before any read.
  t.is(server.requests().length, 0);
  await t.throwsAsync(
    () => catalog.resolveModel({ ...base, spec, modelId: 'acme/no-tools' }),
    { message: textOf.unknownProviderModel('acme/no-tools') },
  );
  t.is(
    textOf.unknownProviderModel('acme/no-tools'),
    'Unknown model "acme/no-tools" for the provider backend',
  );
  const { modelId: _drop, ...noModel } = spec;
  await t.throwsAsync(
    () => catalog.resolveModel({ ...base, spec: harden(noModel) }),
    { message: texts.modelRequired },
  );
  // `defaults` (the contract's fallback) applies before the spec's model.
  t.like(
    await catalog.resolveModel({
      ...base,
      spec,
      defaults: { modelId: 'acme/alpha-a' },
    }),
    { modelId: 'acme/alpha-a' },
  );
  t.is(server.requests().length, 1);
});

test('a key that cannot be read: unavailable, nothing sent, no key text kept', async t => {
  const server = await withServer(t);
  const lines = [];
  const catalog = makeCatalog();
  const page = await catalog.listModels({
    backend: Far('Backend', {}),
    spec: openRouterSpec(server),
    readKey: async () => {
      throw Error(textOf.secretFailed('REVOKED'));
    },
    log: logInto(lines),
  });
  t.is(page.state, 'unavailable');
  t.is(server.requests().length, 0);
  t.deepEqual(
    lines.map(line => JSON.parse(line)),
    [
      {
        kind: 'catalog-failed',
        message: 'model catalogue read failed: key unreadable',
      },
    ],
  );
  // No grant at all (no readKey): unavailable too.
  const none = await catalog.listModels({
    backend: Far('Backend', {}),
    spec: openRouterSpec(server),
  });
  t.is(none.state, 'unavailable');
});

test('Anthropic: x-api-key and version headers, pages by after_id, no description', async t => {
  const server = await withServer(t, [
    {
      match: AN_MODELS,
      body: {
        data: [
          {
            type: 'model',
            id: 'claude-opus-4-8',
            display_name: 'Claude Opus 4.8',
          },
        ],
        has_more: true,
        last_id: 'claude-opus-4-8',
      },
    },
    { match: AN_MODELS, file: 'anthropic-models.json' },
  ]);
  /** @type {{ url: string, headers: Record<string, string> }[]} */
  const seen = [];
  /** @type {typeof globalThis.fetch} */
  const fetch = async (url, init) => {
    seen.push({
      url: String(url),
      headers: /** @type {Record<string, string>} */ (init?.headers),
    });
    return globalThis.fetch(url, init);
  };
  const catalog = makeCatalog({ fetch });
  const backend = Far('Backend', {});
  const spec = harden({
    kind: 'anthropic',
    label: 'claude-api',
    keyGrant: Far('ReadGrant', {}),
    baseUrl: server.anthropicBaseUrl,
    modelId: 'claude-sonnet-4-6',
  });
  const page = await catalog.listModels({
    backend,
    spec,
    readKey: async () => KEY,
    request: { defaultBackend: backend },
  });
  t.true(matches(page, shapes.ModelPage));
  t.deepEqual(
    page.rows.map(row => [row.modelId, row.default, row.description]),
    [
      ['claude-sonnet-4-6', true, undefined],
      ['claude-haiku-4-5', false, undefined],
      ['claude-opus-4-8', false, undefined],
    ],
  );
  t.is(seen.length, 2);
  t.true(seen[0].url.endsWith('/v1/models?limit=1000'));
  t.true(
    seen[1].url.endsWith('/v1/models?limit=1000&after_id=claude-opus-4-8'),
  );
  t.is(seen[0].headers['anthropic-version'], '2023-06-01');
  t.is(seen[0].headers['x-api-key'], KEY);
  t.false('authorization' in seen[0].headers);
  // Anthropic ids carry no organisation prefix rule.
  t.deepEqual(
    await catalog.resolveModel({
      backend,
      spec,
      readKey: async () => KEY,
      modelId: 'claude-haiku-4-5',
    }),
    // M8 (D-M8-12): the API lists no context length; the default window.
    { modelId: 'claude-haiku-4-5', contextLength: 200_000 },
  );
});

test('an Anthropic row without a context length gets the 200,000-token window (R4-37, open decision 13)', async t => {
  const server = await withServer(t, [
    { match: AN_MODELS, file: 'anthropic-models.json' },
  ]);
  const catalog = makeCatalog();
  const backend = Far('Backend', {});
  const spec = harden({
    kind: 'anthropic',
    label: 'claude-api',
    keyGrant: Far('ReadGrant', {}),
    baseUrl: server.anthropicBaseUrl,
    modelId: 'claude-sonnet-4-6',
  });
  const readKey = async () => KEY;
  const page = await catalog.listModels({
    backend,
    spec,
    readKey,
    request: { defaultBackend: backend },
  });
  t.true(matches(page, shapes.ModelPage));
  t.deepEqual(
    page.rows.map(row => [row.modelId, row.contextLength]),
    [
      ['claude-sonnet-4-6', 200_000],
      ['claude-haiku-4-5', 200_000],
    ],
  );
  // What a creation stores as the session's contextLength.
  t.deepEqual(
    await catalog.resolveModel({
      backend,
      spec,
      readKey,
      modelId: 'claude-sonnet-4-6',
    }),
    { modelId: 'claude-sonnet-4-6', contextLength: 200_000 },
  );
});

test('pages: limit, cursor, frameBytes with long descriptions, every row once, unknown cursor ends', async t => {
  const count = 130;
  const data = [];
  for (let i = 0; i < count; i += 1) {
    data.push({
      id: `org/m${String(i).padStart(3, '0')}`,
      name: `Model ${String(count - i).padStart(3, '0')}`,
      // Over modelDescriptionUnits, three UTF-8 bytes a unit: cut.
      description: '€'.repeat(limits.modelDescriptionUnits + 50),
      architecture: {
        input_modalities: ['text'],
        output_modalities: ['text'],
      },
      supported_parameters: ['tools'],
    });
  }
  const server = await withServer(t, [{ match: OR_MODELS, body: { data } }]);
  const catalog = makeCatalog();
  const backend = Far('Backend', {});
  const spec = openRouterSpec(server, 'pages', { modelId: 'org/m064' });
  /** @type {string[]} */
  const ids = [];
  /** @type {string | undefined} */
  let after;
  let pages = 0;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const page = await catalog.listModels({
      backend,
      spec,
      readKey: async () => KEY,
      request: {
        defaultBackend: backend,
        ...(after === undefined ? {} : { after }),
      },
    });
    pages += 1;
    t.true(matches(page, shapes.ModelPage));
    t.true(messageBytes(page) <= limits.frameBytes);
    t.true(page.rows.length >= 1);
    for (const row of page.rows) {
      ids.push(row.modelId);
      t.is(row.description?.length, limits.modelDescriptionUnits);
    }
    if (page.next === undefined) break;
    t.is(page.next, page.rows[page.rows.length - 1].selectionId);
    after = page.next;
  }
  t.is(ids.length, count);
  t.is(new Set(ids).size, count);
  t.is(ids[0], 'org/m064');
  // Titles count down as ids count up: title order is id order reversed.
  t.is(ids[1], `org/m${String(count - 1).padStart(3, '0')}`);
  t.true(pages > 3);
  // A small limit without long descriptions.
  const small = await catalog.listModels({
    backend,
    spec,
    readKey: async () => KEY,
    request: { limit: 2 },
  });
  t.is(small.rows.length, 2);
  t.is(small.next, small.rows[1].selectionId);
  t.true(String(small.next).startsWith('pages:'));
  const ended = await catalog.listModels({
    backend,
    spec,
    readKey: async () => KEY,
    request: { after: 'pages:org/gone' },
  });
  t.deepEqual(ended, { rows: [], state: 'ok' });
  t.is(server.requests().length, 1);
});

test('the scripted double: one row, any model', async t => {
  const catalog = makeCatalog();
  const backend = Far('Backend', {});
  const spec = harden({ kind: 'scripted', label: 's', script: { turns: [] } });
  const page = await catalog.listModels({ backend, spec });
  t.true(matches(page, shapes.ModelPage));
  t.deepEqual(
    page.rows.map(row => row.selectionId),
    ['s:scripted'],
  );
  t.deepEqual(await catalog.resolveModel({ backend, spec }), {
    modelId: 'scripted',
  });
  t.deepEqual(await catalog.resolveModel({ backend, spec, modelId: 'any' }), {
    modelId: 'any',
  });
});

test('through the ops facet: listModels and resolveModel use the backend grant (AH/index.js wiring)', async t => {
  const server = await withServer(t, [
    { match: OR_MODELS, file: 'openrouter-models.json' },
  ]);
  /** @type {any[]} */
  const grantsRead = [];
  const impl = makeAgentHostImpl({
    blobDir: '/nonexistent-not-used',
    secrets: {
      readKey: async grant => {
        grantsRead.push(grant);
        return KEY;
      },
    },
  });
  const backend = Far('Backend', {});
  const spec = openRouterSpec(server);
  const page = await E(impl.ops).listModels(
    harden({ backend, spec, request: { defaultBackend: backend } }),
  );
  t.is(page.state, 'ok');
  t.is(page.rows[0].modelId, 'deepseek/deepseek-v4.1-flash');
  t.deepEqual(
    await E(impl.ops).resolveModel(
      harden({ backend, spec, modelId: 'anthropic/claude-sonnet-4.6' }),
    ),
    { modelId: 'anthropic/claude-sonnet-4.6', contextLength: 200_000 },
  );
  await t.throwsAsync(
    () => E(impl.ops).resolveModel(harden({ backend, spec, modelId: 'x' })),
    { message: texts.openRouterModelPrefix },
  );
  t.true(grantsRead.length >= 1);
  t.true(grantsRead.every(grant => grant === spec.keyGrant));
  // The ops guard refuses an extra key in the request.
  await t.throwsAsync(() =>
    E(impl.ops).listModels(
      harden({ backend, spec, request: { backend, other: 1 } }),
    ),
  );
  // The secrets handlers forward to the operations given.
  await t.throwsAsync(() => E(impl.ops).secretWriter(), {
    message: textOf.notBuilt('secretWriter'),
  });
});
