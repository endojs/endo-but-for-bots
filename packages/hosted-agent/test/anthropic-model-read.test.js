// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';

import {
  makeAnthropicModelRead,
  modelsFromAnthropicPage,
} from '../src/anthropic-model-read.js';

/** @param {string} id */
const row = id => ({
  type: 'model',
  id,
  display_name: `Claude ${id}`,
  created_at: '2026-01-01T00:00:00Z',
});

test('a page projects picker metadata only, with no reasoning choices of its own', t => {
  const page = modelsFromAnthropicPage({
    data: [row('claude-a'), row('claude-b')],
    has_more: true,
    first_id: 'claude-a',
    last_id: 'claude-b',
  });
  t.deepEqual(page.models, [
    {
      id: 'claude-a',
      title: 'Claude claude-a',
      description: '',
      default: false,
      defaultReasoningEffort: null,
      reasoningEfforts: [],
    },
    {
      id: 'claude-b',
      title: 'Claude claude-b',
      description: '',
      default: false,
      defaultReasoningEffort: null,
      reasoningEfforts: [],
    },
  ]);
  t.is(page.next, 'claude-b');
  t.is(modelsFromAnthropicPage({ data: [], has_more: false }).next, null);
  for (const bad of [
    null,
    [],
    { data: {} },
    { data: [row('ok')] },
    { data: [{ ...row('ok'), type: 'other' }], has_more: false },
    { data: [{ ...row('ok'), display_name: '' }], has_more: false },
    { data: [{ ...row('bad id/'), id: 'bad id' }], has_more: false },
    { data: [row('ok')], has_more: true },
    { data: [row('ok')], has_more: true, last_id: 'bad id' },
  ]) {
    t.throws(() => modelsFromAnthropicPage(bad), {
      message: /Invalid Anthropic model catalog/,
    });
  }
});

test('reads the account-scoped list under the credential as given, following pages', async t => {
  /** @type {Array<{ url: string, headers: Headers }>} */
  const requests = [];
  let reads = 0;
  const read = makeAnthropicModelRead({
    readAuthorization: async () => {
      reads += 1;
      return { header: 'bearer', token: `oat-${reads}` };
    },
    anthropicBeta: 'oauth-2025-04-20',
    fetch: /** @type {any} */ (
      async (url, init) => {
        requests.push({ url, headers: new Headers(init.headers) });
        const after = new URL(url).searchParams.get('after_id');
        return Response.json(
          after === null
            ? {
                data: [row('claude-a')],
                has_more: true,
                first_id: 'claude-a',
                last_id: 'claude-a',
              }
            : {
                data: [row('claude-b')],
                has_more: false,
                first_id: 'claude-b',
                last_id: 'claude-b',
              },
        );
      }
    ),
    now: () => 77,
  });
  const result = await read();
  t.deepEqual(
    result.models.map(model => model.id),
    ['claude-a', 'claude-b'],
  );
  t.is(result.observedAt, 77);
  t.deepEqual(
    requests.map(request => request.url),
    [
      'https://api.anthropic.com/v1/models?limit=1000',
      'https://api.anthropic.com/v1/models?limit=1000&after_id=claude-a',
    ],
  );
  for (const { headers } of requests) {
    t.is(headers.get('authorization'), 'Bearer oat-1');
    t.is(headers.get('anthropic-beta'), 'oauth-2025-04-20');
    t.is(headers.get('anthropic-version'), '2023-06-01');
    t.is(headers.get('x-api-key'), null);
  }
  // Read again: the credential is asked for again, not kept.
  await read();
  t.is(reads, 2);
  t.is(requests.at(-1)?.headers.get('authorization'), 'Bearer oat-2');
});

test('an API key travels as x-api-key with no OAuth beta', async t => {
  /** @type {Headers[]} */
  const sent = [];
  const read = makeAnthropicModelRead({
    readAuthorization: async () => ({ header: 'x-api-key', token: 'sk-key' }),
    anthropicBeta: 'oauth-2025-04-20',
    fetch: /** @type {any} */ (
      async (_url, init) => {
        sent.push(new Headers(init.headers));
        return Response.json({ data: [row('claude-a')], has_more: false });
      }
    ),
  });
  await read();
  t.is(sent[0].get('x-api-key'), 'sk-key');
  t.is(sent[0].get('authorization'), null);
  t.is(sent[0].get('anthropic-beta'), null);
});

test('refusals, malformed pages, endless pagination and credential failures are sanitized', async t => {
  /** @param {any} fetch @param {any} [readAuthorization] */
  const make = (fetch, readAuthorization) =>
    makeAnthropicModelRead({
      readAuthorization:
        readAuthorization ??
        (async () => ({ header: 'bearer', token: 'SECRET-TOKEN' })),
      fetch,
    });
  const failures = [
    make(async () => new Response('SECRET-TOKEN refused', { status: 401 })),
    make(async () => Response.json({ data: 'SECRET-TOKEN' })),
    make(async () => {
      throw Error('ECONNRESET SECRET-TOKEN');
    }),
    make(async () =>
      Response.json({
        data: [row('claude-a')],
        has_more: true,
        last_id: 'claude-a',
      }),
    ),
    make(
      async () => Response.json({ data: [], has_more: false }),
      async () => {
        throw Error('secret store SECRET-TOKEN');
      },
    ),
    make(
      async () => Response.json({ data: [], has_more: false }),
      async () => ({ header: 'bearer', token: 'has space' }),
    ),
    make(
      async () => Response.json({ data: [], has_more: false }),
      async () => ({ header: 'cookie', token: 'x' }),
    ),
  ];
  for (const read of failures) {
    // eslint-disable-next-line no-await-in-loop
    const error = await t.throwsAsync(read, {
      message: 'Anthropic model discovery failed',
    });
    t.false(String(error?.stack ?? '').includes('SECRET-TOKEN'));
    t.is(error?.cause, undefined);
  }
  t.throws(
    () =>
      makeAnthropicModelRead({
        readAuthorization: async () => ({ header: 'bearer', token: 'x' }),
        fetch: async () => new Response(''),
        anthropicBeta: 'oauth, other',
      }),
    { message: /Invalid Anthropic beta capabilities/ },
  );
});
