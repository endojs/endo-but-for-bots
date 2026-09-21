// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';

import { makeOpenRouterModelRead } from '../src/openrouter-model-read.js';

const model = harden({
  id: 'openrouter/free',
  name: 'Free auto route',
  description: 'Provider description',
  context_length: null,
  architecture: { input_modalities: ['text'], output_modalities: ['text'] },
  supported_parameters: ['tools'],
});

test('reads only the account-filtered catalog and refreshes credentials per call', async t => {
  let reads = 0;
  const requests = [];
  const read = makeOpenRouterModelRead({
    readKey: async () => `key-${(reads += 1)}`,
    fetch: async (url, options) => {
      requests.push({ url, options });
      return Response.json({ data: [{ ...model, secretExtra: 'discard me' }] });
    },
    now: () => 0,
  });
  const result = await read();
  await read();
  t.is(reads, 2);
  t.is(requests.length, 2);
  t.is(requests[0].url, 'https://openrouter.ai/api/v1/models/user');
  t.like(requests[0].options, {
    method: 'GET',
    redirect: 'error',
    credentials: 'omit',
    cache: 'no-store',
    referrerPolicy: 'no-referrer',
    headers: { authorization: 'Bearer key-1' },
  });
  t.true(requests[0].options?.signal instanceof AbortSignal);
  t.deepEqual(result, {
    observedAt: 0,
    models: [
      {
        id: model.id,
        title: model.name,
        description: model.description,
        contextLength: null,
        inputModalities: ['text'],
        outputModalities: ['text'],
        supportedParameters: ['tools'],
        reasoning: null,
      },
    ],
  });
  t.true(Object.isFrozen(result.models[0]));
});

test('retains advertised reasoning metadata without inventing effort choices', async t => {
  const read = makeOpenRouterModelRead({
    readKey: async () => 'key',
    fetch: async () =>
      Response.json({
        data: [
          {
            ...model,
            reasoning: {
              supported_efforts: ['high', 'low'],
              default_effort: 'low',
              mandatory: true,
            },
          },
        ],
      }),
  });
  t.deepEqual((await read()).models[0].reasoning, {
    supportedEfforts: ['high', 'low'],
    defaultEffort: 'low',
    mandatory: true,
    defaultEnabled: null,
    supportsMaxTokens: null,
  });
});

for (const [name, payload] of Object.entries({
  duplicate: { data: [model, model] },
  incomplete: { data: [model], total_count: 2 },
  nextPage: { data: [model], links: { next: 'https://attacker.invalid/' } },
  invalidId: { data: [{ ...model, id: 'bad\nroute' }] },
  invalidCapabilities: {
    data: [{ ...model, supported_parameters: ['tools', 'tools'] }],
  },
  invalidDefault: {
    data: [
      {
        ...model,
        reasoning: {
          supported_efforts: ['low'],
          default_effort: 'high',
          mandatory: false,
        },
      },
    ],
  },
  tooMany: { data: Array(4097).fill(model) },
})) {
  test(`rejects ${name} catalog without fallback`, async t => {
    let requests = 0;
    const read = makeOpenRouterModelRead({
      readKey: async () => 'key',
      fetch: async () => {
        requests += 1;
        return Response.json(payload);
      },
    });
    await t.throwsAsync(read, { message: 'OpenRouter model discovery failed' });
    t.is(requests, 1);
  });
}

test('sanitizes transport and credential-reader failures', async t => {
  for (const credentialFailure of [false, true]) {
    const read = makeOpenRouterModelRead({
      readKey: async () => {
        if (credentialFailure) throw Error('SECRET');
        return 'key';
      },
      fetch: async () => {
        throw Error('SECRET');
      },
    });
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(read, { message: 'OpenRouter model discovery failed' });
  }
});

test('preserves unknown effort lists without constructing a static catalog', async t => {
  const read = makeOpenRouterModelRead({
    readKey: async () => 'key',
    fetch: async () =>
      Response.json({
        data: [
          {
            ...model,
            reasoning: { mandatory: false, supported_efforts: null },
          },
        ],
      }),
  });
  const result = await read();
  t.deepEqual(result.models[0].reasoning, {
    supportedEfforts: null,
    defaultEffort: null,
    mandatory: false,
    defaultEnabled: null,
    supportsMaxTokens: null,
  });
});

for (const [name, response] of Object.entries({
  refused: () => new Response('SECRET', { status: 403 }),
  invalidJson: () => new Response('SECRET'),
  invalidUtf8: () => new Response(new Uint8Array([0xff])),
  oversized: () => new Response(new Uint8Array(16 * 1024 * 1024 + 1)),
  abortedBody: () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new DOMException('SECRET', 'AbortError'));
        },
      }),
    ),
})) {
  test(`sanitizes ${name} response`, async t => {
    const read = makeOpenRouterModelRead({
      readKey: async () => 'key',
      fetch: async () => response(),
    });
    await t.throwsAsync(read, { message: 'OpenRouter model discovery failed' });
  });
}
