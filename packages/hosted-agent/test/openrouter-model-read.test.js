// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';

import {
  makeOpenRouterModelRead,
  modelsFromOpenRouterCatalog,
} from '../src/openrouter-model-read.js';

const model = harden({
  id: 'openrouter/free',
  name: 'Free auto route',
  description: 'Provider description',
  context_length: null,
  architecture: { input_modalities: ['text'], output_modalities: ['text'] },
  supported_parameters: ['tools'],
});

test('agent projection filters text tools and never invents routes or reasoning choices', async t => {
  const read = makeOpenRouterModelRead({
    readKey: async () => 'key',
    fetch: async () =>
      Response.json({
        data: [
          model,
          {
            ...model,
            id: 'vendor/concrete',
            reasoning: {
              mandatory: true,
              supported_efforts: ['high', 'low'],
              default_effort: 'low',
            },
          },
          {
            ...model,
            id: 'vendor/generic',
            supported_parameters: ['tools', 'reasoning'],
            reasoning: {
              mandatory: false,
              default_effort: 'high',
            },
          },
          { ...model, id: 'vendor/no-tools', supported_parameters: [] },
          {
            ...model,
            id: 'vendor/image-output',
            architecture: {
              input_modalities: ['text'],
              output_modalities: ['image'],
            },
          },
          {
            ...model,
            id: 'vendor/audio-input',
            architecture: {
              input_modalities: ['audio'],
              output_modalities: ['text'],
            },
          },
        ],
      }),
  });
  const projected = modelsFromOpenRouterCatalog((await read()).models);
  t.deepEqual(
    projected.map(row => row.id),
    [model.id, 'vendor/concrete', 'vendor/generic'],
  );
  t.deepEqual(projected[0].reasoningEfforts, []);
  t.is(projected[0].defaultReasoningEffort, null);
  t.deepEqual(projected[1].reasoningEfforts, ['high', 'low']);
  t.is(projected[1].defaultReasoningEffort, 'low');
  t.deepEqual(projected[2].reasoningEfforts, []);
  t.is(projected[2].defaultReasoningEffort, null);
  t.true(projected.every(row => row.default === false));
  t.true(Object.isFrozen(projected));
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
        maxOutputTokens: null,
        inputModalities: ['text'],
        outputModalities: ['text'],
        supportedParameters: ['tools'],
        reasoning: null,
      },
    ],
  });
  t.true(Object.isFrozen(result.models[0]));
});

test('output observations are independent and free-route metadata is not a guaranteed window', async t => {
  let output = 4096;
  const read = makeOpenRouterModelRead({
    readKey: async () => 'test-key',
    fetch: async () =>
      Response.json({
        data: [{ ...model, top_provider: { max_completion_tokens: output } }],
      }),
  });
  const first = modelsFromOpenRouterCatalog((await read()).models)[0];
  t.is(first.id, 'openrouter/free');
  t.is(first.maxOutputTokens, 4096);
  t.false(Object.hasOwn(first, 'contextLength'));
  output = 2048;
  t.is(
    modelsFromOpenRouterCatalog((await read()).models)[0].maxOutputTokens,
    2048,
  );
});

for (const topProvider of [
  undefined,
  null,
  {},
  { max_completion_tokens: null },
]) {
  test(`missing output metadata stays unknown: ${JSON.stringify(topProvider)}`, async t => {
    const read = makeOpenRouterModelRead({
      readKey: async () => 'test-key',
      fetch: async () =>
        Response.json({ data: [{ ...model, top_provider: topProvider }] }),
    });
    const raw = (await read()).models;
    t.is(raw[0].maxOutputTokens, null);
    t.false(
      Object.hasOwn(modelsFromOpenRouterCatalog(raw)[0], 'maxOutputTokens'),
    );
  });
}

for (const output of [0, -1, 1.5, '4096', 0x1_0000_0000]) {
  test(`rejects invalid provider output metadata ${output}`, async t => {
    const read = makeOpenRouterModelRead({
      readKey: async () => 'test-key',
      fetch: async () =>
        Response.json({
          data: [{ ...model, top_provider: { max_completion_tokens: output } }],
        }),
    });
    await t.throwsAsync(read, { message: 'OpenRouter model discovery failed' });
  });
}

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
