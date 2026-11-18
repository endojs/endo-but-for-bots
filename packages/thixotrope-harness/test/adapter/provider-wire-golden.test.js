// @ts-check
// The provider wire golden (harness review HR-SYN-3 (a), HR-SYN-17): what
// the API providers and the two model catalogues send, byte for byte, for a
// recorded set of rounds and reads against the fake servers (127.0.0.1),
// compared with `test/fixtures/provider-wire-golden.json`. Each request is
// kept as its method, path and query, header names and values in the order
// given (the key's value replaced by a placeholder) and the body text as
// sent; each round also keeps what it answered the session and the kinds of
// its event-log lines, in order. A refactor of the provider shell or the
// catalogue core must leave the file unchanged.
//
// `THIX_WRITE_GOLDEN=1` rewrites the file (only on purpose: a wire change
// is a contract change).
import '../unit/_m1a-prelude.js';

import { readFileSync, writeFileSync } from 'node:fs';
import { env } from 'node:process';

import test from '@endo/ses-ava/test.js';

import { makeAnthropicProvider } from '../../resources/agent-host/impl/providers/anthropic.js';
import { makeOpenRouterProvider } from '../../resources/agent-host/impl/providers/openrouter.js';
import { makeCatalog } from '../../resources/agent-host/impl/providers/catalog.js';
import { makePoolCatalog } from '../../resources/agent-host/impl/subscriptions/catalog.js';
import { startFakeProviderServer } from '../fixtures/fake-provider-server.mjs';
import { startFakeSubscriptionServer } from '../fixtures/fake-subscription-server.mjs';
import { KEY, runApiRound, timers } from './_m2-w21b-round.js';

const { Far } = /** @type {any} */ (globalThis);

const goldenFile = new URL(
  '../fixtures/provider-wire-golden.json',
  import.meta.url,
);

/** Header values never kept (credentials). */
const SECRET_HEADERS = new Set(['authorization', 'x-api-key']);

/**
 * A fetch that records each request before passing it on.
 * @param {any[]} into
 * @returns {typeof globalThis.fetch}
 */
const recordingFetch = into =>
  /** @type {any} */ (
    async (/** @type {any} */ url, /** @type {any} */ init = {}) => {
      const where = new URL(String(url));
      into.push({
        method: init.method ?? 'GET',
        path: `${where.pathname}${where.search}`,
        headers: Object.entries(init.headers ?? {}).map(([name, value]) => [
          name,
          SECRET_HEADERS.has(name.toLowerCase()) ? '<credential>' : value,
        ]),
        ...(init.body === undefined ? {} : { body: init.body }),
      });
      return globalThis.fetch(url, init);
    }
  );

/** A transcript with every record kind a projection hands a provider. */
const richTranscript = [
  { kind: 'message', role: 'user', content: 'first question' },
  { kind: 'message', role: 'assistant', content: 'calling a tool' },
  { kind: 'tool-call', id: 't1/r0/c0', name: 'echo', args: '{"text":"a"}' },
  { kind: 'tool-call', id: 't1/r0/c1', name: 'echo', args: 'not json' },
  { kind: 'tool-result', id: 't1/r0/c0', content: 'a' },
  { kind: 'tool-result', id: 't1/r0/c1', content: 'boom', failed: true },
  { kind: 'message', role: 'assistant', content: 'done' },
  { kind: 'message', role: 'user', content: 'second question' },
];

const echoTool = {
  name: 'echo',
  description: 'Echo the text.',
  parameters: '{"type":"object","properties":{"text":{"type":"string"}}}',
};

/**
 * What a round answered and sent.
 * @param {any} r a `runApiRound` result
 * @param {any[]} sent
 */
const roundRecord = (r, sent) => ({
  requests: sent,
  finals: r.finals.map((/** @type {any} */ f) => ({ ...f, at: 0 })),
  failures: r.failures.map((/** @type {any} */ f) => ({ ...f, at: 0 })),
  // The kinds seen, sorted: deferred lines (`round-start`, `delta`)
  // interleave by timing, and how many deltas depends on the socket's reads.
  log: [...new Set(r.log.map((/** @type {any} */ line) => line.kind))].sort(),
});

/**
 * A page without its rows' Backend presence.
 * @param {any} page
 */
const rowsOf = page => ({
  ...page,
  rows: page.rows.map(
    (/** @type {any} */ { backend: _backend, ...row }) => row,
  ),
});

/** The rounds: [name, provider maker, server base, model, options, plan]. */
const apiRounds = /** @type {const} */ ([
  [
    'anthropic: rich transcript, two-part system, a tool, request limit',
    makeAnthropicProvider,
    'anthropicBaseUrl',
    'claude-fake-1',
    {
      transcript: richTranscript,
      system: ['The stored prompt.', 'The turn line.'],
      tools: [echoTool],
      requestOptions: { maxOutputTokens: 1234 },
    },
    [{ sse: 'anthropic-text.sse' }],
  ],
  [
    'anthropic: one message, spec output limit, no system, no tools',
    makeAnthropicProvider,
    'anthropicBaseUrl',
    'claude-fake-1',
    { spec: { maxOutputTokens: 77 } },
    [{ sse: 'anthropic-tool-use.sse' }],
  ],
  [
    'anthropic: a 401 fails the round',
    makeAnthropicProvider,
    'anthropicBaseUrl',
    'claude-fake-1',
    {},
    [{ status: 401 }],
  ],
  [
    'openrouter: rich transcript, system, a tool, effort and limit',
    makeOpenRouterProvider,
    'openRouterBaseUrl',
    'acme/model-1',
    {
      transcript: richTranscript,
      system: 'You are terse.',
      tools: [echoTool],
      requestOptions: { maxOutputTokens: 99, reasoningEffort: 'high' },
    },
    [{ sse: 'openrouter-text.sse' }],
  ],
  [
    'openrouter: tool calls, spec output limit',
    makeOpenRouterProvider,
    'openRouterBaseUrl',
    'acme/model-1',
    { spec: { maxOutputTokens: 55 } },
    [{ sse: 'openrouter-tool-calls.sse' }],
  ],
  [
    'openrouter: a model without its organisation sends nothing',
    makeOpenRouterProvider,
    'openRouterBaseUrl',
    'no-organisation',
    {},
    [],
  ],
]);

/** @returns {Promise<Record<string, any>>} */
const recordApiRounds = async () => {
  /** @type {Record<string, any>} */
  const out = {};
  for (const [name, make, base, modelId, options, plan] of apiRounds) {
    // eslint-disable-next-line no-await-in-loop
    const server = await startFakeProviderServer();
    try {
      server.setPlan([...plan]);
      /** @type {any[]} */
      const sent = [];
      // eslint-disable-next-line no-await-in-loop
      const r = await runApiRound(
        (/** @type {any} */ given) =>
          make({ ...given, fetch: recordingFetch(sent) }),
        /** @type {any} */ ({ baseUrl: server[base], modelId, ...options }),
      );
      // The deferred log lines are written a timer turn after the round.
      // eslint-disable-next-line no-await-in-loop
      await timers.delay(50);
      r.cleanup();
      out[name] = roundRecord(r, sent);
    } finally {
      // eslint-disable-next-line no-await-in-loop
      await server.close();
    }
  }
  return out;
};

/** @returns {Promise<Record<string, any>>} */
const recordCatalogReads = async () => {
  /** @type {Record<string, any>} */
  const out = {};
  const server = await startFakeProviderServer();
  try {
    server.setPlan([
      {
        match: { method: 'GET', path: '/api/v1/models' },
        file: 'openrouter-models.json',
      },
      {
        match: { method: 'GET', path: '/v1/models' },
        file: 'anthropic-models.json',
      },
    ]);
    for (const [kind, baseUrl, modelId] of [
      ['openrouter', server.openRouterBaseUrl, 'acme/alpha-a'],
      ['anthropic', server.anthropicBaseUrl, 'claude-fake-1'],
    ]) {
      /** @type {any[]} */
      const sent = [];
      /** @type {any[]} */
      const log = [];
      const catalog = makeCatalog({ fetch: recordingFetch(sent) });
      const backend = Far('Backend', {});
      const spec = harden({ kind, label: kind, baseUrl, modelId });
      // eslint-disable-next-line no-await-in-loop
      const page = await catalog.listModels({
        backend,
        spec,
        readKey: async () => KEY,
        log: (/** @type {string} */ k, fields = {}) =>
          log.push({ kind: k, ...fields }),
        request: { defaultBackend: backend },
      });
      out[`catalogue ${kind}`] = { requests: sent, page: rowsOf(page), log };
    }
  } finally {
    await server.close();
  }
  return out;
};

/** @returns {Promise<Record<string, any>>} */
const recordPoolCatalogReads = async () => {
  /** @type {Record<string, any>} */
  const out = {};
  const tokenOf = (/** @type {string} */ name) =>
    ['fake', 'access', 'golden', name].join('-');
  for (const [kind, provider, path, file] of [
    ['claude-pool', 'claude', '/v1/models', 'claude-models.json'],
    ['codex-pool', 'codex', '/backend-api/codex/models', 'codex-models.json'],
  ]) {
    // eslint-disable-next-line no-await-in-loop
    const server = await startFakeSubscriptionServer({
      credentialTag: () => 'a',
    });
    try {
      server.setPlan([
        { match: { method: 'GET', path, credential: 'a' }, file },
      ]);
      /** @type {any[]} */
      const sent = [];
      /** @type {any} */
      const entry = harden({
        member: Far('PoolMember', {}),
        label: 'a',
        provider,
        weight: 1,
        key: 'k-a',
        state: 'active',
      });
      const catalog = makePoolCatalog({
        fetch: recordingFetch(sent),
        now: () => 1_000_000,
        members: async () => [entry],
        readCredential: async () =>
          harden({
            accessToken: tokenOf('a'),
            accountId: 'account-a',
            expiresAtMs: 4_000_000_000_000,
          }),
      });
      const backend = Far('Backend', {});
      const spec = harden({
        kind,
        label: 'pool',
        members: [entry.member],
        baseUrl: server.url,
      });
      // eslint-disable-next-line no-await-in-loop
      const page = await catalog.listModels({ backend, spec });
      out[`pool catalogue ${kind}`] = { requests: sent, page: rowsOf(page) };
    } finally {
      // eslint-disable-next-line no-await-in-loop
      await server.close();
    }
  }
  return out;
};

test('the API providers and both catalogues send what the golden file holds', async t => {
  const recorded = JSON.parse(
    JSON.stringify({
      rounds: await recordApiRounds(),
      catalogues: {
        ...(await recordCatalogReads()),
        ...(await recordPoolCatalogReads()),
      },
    }),
  );
  if (env.THIX_WRITE_GOLDEN === '1') {
    writeFileSync(goldenFile, `${JSON.stringify(recorded, null, 2)}\n`);
    t.pass('golden written');
    return;
  }
  const golden = JSON.parse(readFileSync(goldenFile, 'utf8'));
  t.deepEqual(Object.keys(recorded.rounds), Object.keys(golden.rounds));
  for (const name of Object.keys(golden.rounds)) {
    t.deepEqual(recorded.rounds[name], golden.rounds[name], name);
  }
  for (const name of Object.keys(golden.catalogues)) {
    t.deepEqual(recorded.catalogues[name], golden.catalogues[name], name);
  }
  t.deepEqual(Object.keys(recorded.catalogues), Object.keys(golden.catalogues));
});
