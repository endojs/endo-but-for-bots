// @ts-check
// M2 W2.2 bench: the model catalogue in the adapter (Node only, no vat, no
// run lock). A 4,096-model OpenRouter catalogue (the reader's bound) with
// 1,000-unit descriptions from the fake provider server (127.0.0.1):
// - catalog.read.cold: the first listing (key, GET, parse, validate,
//   filter, sort, first page);
// - catalog.page.warm: a page from the cache, first and deep cursors;
// - catalog.resolve.warm: resolveModel of a pinned model from the cache.
// Prints one JSON line per row.
//
//   node test/adapter/m2-w22-catalog.bench.mjs
import '../../scripts/_init.mjs';

import { performance } from 'node:perf_hooks';

const { installGuestPrelude } = await import('../../scripts/guest-prelude.js');
installGuestPrelude();

const { stats, emit, runIdentity, loadAvg } =
  await import('../../perf/_harness.mjs');
/* eslint-disable import/no-relative-packages */
const { messageBytes } = await import('../../guest/lib/bounded.js');
/* eslint-enable import/no-relative-packages */
const { makeCatalog } =
  await import('../../resources/agent-host/impl/providers/catalog.js');
const { startFakeProviderServer } =
  await import('../fixtures/fake-provider-server.mjs');

const { Far } = /** @type {any} */ (globalThis);

const MODELS = 4096;
const SAMPLES = 200;
const extra = {
  ...(await runIdentity()),
  crankBudget: 50_000_000,
  load: loadAvg(),
  models: MODELS,
  note: 'Node only: the adapter catalogue; no vat, no hub',
};

const data = [];
for (let i = 0; i < MODELS; i += 1) {
  data.push({
    id: `org${i % 64}/model-${i}`,
    name: `Model ${(i * 7919) % MODELS}`,
    description: 'd'.repeat(1000),
    context_length: 1000 + i,
    architecture: { input_modalities: ['text'], output_modalities: ['text'] },
    top_provider: { max_completion_tokens: 4096 },
    supported_parameters: ['tools', 'max_tokens'],
  });
}
const body = JSON.stringify({ data });

const server = await startFakeProviderServer();
try {
  const cold = [];
  const bodyBytes = Buffer.byteLength(body);
  for (let run = 0; run < 5; run += 1) {
    server.setPlan([
      { match: { method: 'GET', path: '/api/v1/models' }, body },
    ]);
    const catalog = makeCatalog();
    const backend = Far('Backend', {});
    const spec = harden({
      kind: 'openrouter',
      label: 'bench',
      keyGrant: Far('ReadGrant', {}),
      baseUrl: server.openRouterBaseUrl,
      modelId: 'org0/model-0',
    });
    const t0 = performance.now();
    // eslint-disable-next-line no-await-in-loop
    const page = await catalog.listModels({
      backend,
      spec,
      readKey: async () => 'not a real key',
      request: { defaultBackend: backend },
    });
    cold.push(performance.now() - t0);
    if (page.state !== 'ok') throw Error('bench catalogue unavailable');
  }
  await stats('catalog.read.cold', cold, { extra: { ...extra, bodyBytes } });

  server.setPlan([{ match: { method: 'GET', path: '/api/v1/models' }, body }]);
  const catalog = makeCatalog();
  const backend = Far('Backend', {});
  const spec = harden({
    kind: 'openrouter',
    label: 'bench',
    keyGrant: Far('ReadGrant', {}),
    baseUrl: server.openRouterBaseUrl,
    modelId: 'org0/model-0',
  });
  const base = {
    backend,
    spec,
    readKey: async () => 'not a real key',
  };
  const first = await catalog.listModels({
    ...base,
    request: { defaultBackend: backend },
  });
  // Walk every page once, then time first and deep pages.
  const cursors = [];
  let after;
  let pages = 0;
  let largest = 0;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const page = await catalog.listModels({
      ...base,
      request: { defaultBackend: backend, ...(after ? { after } : {}) },
    });
    pages += 1;
    largest = Math.max(largest, messageBytes(page));
    cursors.push(after);
    if (page.next === undefined) break;
    after = page.next;
  }
  const firstTimes = [];
  const deepTimes = [];
  const deep = cursors[Math.floor(cursors.length * 0.9)];
  for (let i = 0; i < SAMPLES; i += 1) {
    let t0 = performance.now();
    // eslint-disable-next-line no-await-in-loop
    await catalog.listModels({ ...base, request: { defaultBackend: backend } });
    firstTimes.push(performance.now() - t0);
    t0 = performance.now();
    // eslint-disable-next-line no-await-in-loop
    await catalog.listModels({
      ...base,
      request: { defaultBackend: backend, after: deep },
    });
    deepTimes.push(performance.now() - t0);
  }
  const shape = {
    pages,
    rowsFirstPage: first.rows.length,
    largestPageBytes: largest,
  };
  await stats('catalog.page.warm.first', firstTimes, {
    extra: { ...extra, ...shape },
  });
  await stats('catalog.page.warm.deep', deepTimes, {
    extra: { ...extra, ...shape },
  });
  const resolveTimes = [];
  for (let i = 0; i < SAMPLES; i += 1) {
    const t0 = performance.now();
    // eslint-disable-next-line no-await-in-loop
    await catalog.resolveModel({
      ...base,
      modelId: `org${(i * 7) % 64}/model-${i * 7}`,
    });
    resolveTimes.push(performance.now() - t0);
  }
  await stats('catalog.resolve.warm', resolveTimes, {
    extra: { ...extra, reads: server.requests().length },
  });
  emit({ metric: 'catalog.bench.done', ...extra });
} finally {
  await server.close();
}
