// @ts-check
import '@endo/init';
import test from 'ava';

import {
  OPENROUTER_NPM,
  makeOpencodeConfig,
  parseModelRef,
} from '../src/opencode-agent-config.js';

// The config builder names no model of its own: a session's plan does.
const DEFAULT_MODEL = 'openrouter/deepseek/deepseek-v4.1-flash';

test('builds the default OpenRouter config with a fixed provider list', t => {
  const config = makeOpencodeConfig({
    model: DEFAULT_MODEL,
    systemPrompt: 'You are Floot.',
  });
  t.deepEqual(config, {
    share: 'disabled',
    model: DEFAULT_MODEL,
    small_model: DEFAULT_MODEL,
    default_agent: 'floot',
    permission: { doom_loop: 'allow' },
    provider: {
      openrouter: {
        npm: OPENROUTER_NPM,
        env: ['OPENROUTER_API_KEY'],
        options: { baseURL: 'https://openrouter.ai/api/v1' },
        whitelist: ['deepseek/deepseek-v4.1-flash'],
        models: {
          'deepseek/deepseek-v4.1-flash': {
            name: 'deepseek/deepseek-v4.1-flash',
          },
        },
      },
    },
    agent: {
      floot: { prompt: 'You are Floot.', disable: false, mode: 'primary' },
    },
  });
  t.true(Object.isFrozen(config));
  t.true(Object.isFrozen(config.provider.openrouter.models));
});

test('free router preserves the provider prefix and uses no paid small model', t => {
  const model = 'openrouter/openrouter/free';
  const config = makeOpencodeConfig({ model });
  t.is(parseModelRef(model), 'openrouter/free');
  t.is(config.model, model);
  t.is(config.small_model, model);
  t.deepEqual(config.provider.openrouter.whitelist, ['openrouter/free']);
  t.deepEqual(Object.keys(config.provider.openrouter.models), [
    'openrouter/free',
  ]);
});

test('free router catalog observations preserve the OpenRouter vendor', t => {
  const config = makeOpencodeConfig({
    model: 'openrouter/openrouter/free',
    models: {
      'openrouter/free': { limit: { context: 200_000 } },
    },
  });
  t.deepEqual(config.provider.openrouter.whitelist, ['openrouter/free']);
  t.deepEqual(config.provider.openrouter.models['openrouter/free'].limit, {
    context: 200_000,
  });
  t.is(config.small_model, 'openrouter/openrouter/free');
});

test('whitelists both models when the small model differs', t => {
  const config = makeOpencodeConfig({
    model: 'openrouter/deepseek/deepseek-v4.1-flash',
    smallModel: 'openrouter/anthropic/claude-sonnet-5',
  });
  const provider = config.provider.openrouter;
  t.deepEqual(provider.whitelist, [
    'deepseek/deepseek-v4.1-flash',
    'anthropic/claude-sonnet-5',
  ]);
  t.false(Object.hasOwn(provider.models['anthropic/claude-sonnet-5'], 'limit'));
});

test('context observations do not invent output limits or other model limits', t => {
  const config = makeOpencodeConfig({
    model: DEFAULT_MODEL,
    models: {
      'deepseek/deepseek-v4.1-flash': { limit: { context: 65_536 } },
    },
  });
  t.deepEqual(
    config.provider.openrouter.models['deepseek/deepseek-v4.1-flash'].limit,
    { context: 65_536 },
  );
  const unknown = makeOpencodeConfig({ model: 'openrouter/vendor/unknown' });
  t.false(
    Object.hasOwn(
      unknown.provider.openrouter.models['vendor/unknown'],
      'limit',
    ),
  );
});

test('preserves provider-scoped catalog keys and whitelists the whole catalog', t => {
  const config = makeOpencodeConfig({
    model: 'openrouter/mistralai/mistral-large-3',
    models: {
      'mistralai/mistral-large-3': {
        name: 'Caller name',
        limit: { context: 200_000, output: 4000 },
      },
      'x-ai/grok-4.1': { name: 'Grok' },
    },
  });
  const provider = config.provider.openrouter;
  t.deepEqual(provider.whitelist, [
    'mistralai/mistral-large-3',
    'x-ai/grok-4.1',
  ]);
  t.deepEqual(provider.models['mistralai/mistral-large-3'], {
    name: 'Caller name',
    limit: { context: 200_000, output: 4000 },
  });
  t.is(provider.models['x-ai/grok-4.1'].name, 'Grok');
});

test('accepts stealth alias model ids with a leading tilde', t => {
  const config = makeOpencodeConfig({
    model: 'openrouter/~anthropic/claude-opus-latest',
  });
  t.deepEqual(config.provider.openrouter.whitelist, [
    '~anthropic/claude-opus-latest',
  ]);
  t.is(
    parseModelRef('openrouter/~anthropic/claude-opus-latest'),
    '~anthropic/claude-opus-latest',
  );
});

test('omits prompt and mcp when they are not provided', t => {
  const config = makeOpencodeConfig({ model: DEFAULT_MODEL });
  t.deepEqual(config.agent.floot, { disable: false, mode: 'primary' });
  t.false('mcp' in config);
});

test('normalizes a local mcp server map without freezing the caller input', t => {
  const mcpServers = {
    endo: { type: 'local', command: ['node', '/relay.mjs'], enabled: true },
  };
  const config = makeOpencodeConfig({ model: DEFAULT_MODEL, mcpServers });
  t.deepEqual(config.mcp, {
    endo: {
      type: 'local',
      command: ['node', '/relay.mjs'],
      enabled: true,
    },
  });
  t.false(Object.isFrozen(mcpServers));
  t.false(Object.isFrozen(mcpServers.endo));
});

test('accepts a loopback http broker endpoint and rejects any other http', t => {
  const broker = makeOpencodeConfig({
    model: DEFAULT_MODEL,
    baseUrl: 'http://127.0.0.1:41337/api/v1',
    allowLoopbackHttp: true,
  });
  t.is(
    /** @type {any} */ (broker.provider).openrouter.options.baseURL,
    'http://127.0.0.1:41337/api/v1',
  );
  const ipv6 = makeOpencodeConfig({
    model: DEFAULT_MODEL,
    baseUrl: 'http://[::1]:41337/api/v1',
    allowLoopbackHttp: true,
  });
  t.is(
    /** @type {any} */ (ipv6.provider).openrouter.options.baseURL,
    'http://[::1]:41337/api/v1',
  );
  for (const baseUrl of [
    'http://openrouter.ai/api/v1',
    'http://10.0.0.5:41337/api/v1',
    'http://0.0.0.0:41337/api/v1',
    'http://localhost:41337/api/v1',
    'http://user@127.0.0.1:41337/api/v1',
    'http://127.0.0.1/api/v1',
    'http://127.0.0.1:0/api/v1',
    'http://127.0.0.1:41337/other',
    'https://127.0.0.1:41337/api/v1',
  ]) {
    t.throws(
      () =>
        makeOpencodeConfig({
          model: DEFAULT_MODEL,
          baseUrl,
          allowLoopbackHttp: true,
        }),
      {
        message: /baseUrl/,
      },
    );
  }
  // Without the explicit opt-in, loopback http is not admitted at all.
  t.throws(
    () =>
      makeOpencodeConfig({
        model: DEFAULT_MODEL,
        baseUrl: 'http://127.0.0.1:41337/api/v1',
      }),
    { message: /must use https/ },
  );
});

test('passes through local mcp environment entries', t => {
  const config = makeOpencodeConfig({
    model: DEFAULT_MODEL,
    mcpServers: {
      endo: {
        type: 'local',
        command: ['node', '/relay.mjs'],
        environment: { SOCKET: '/run/endo.sock' },
      },
    },
  });
  const mcp = /** @type {any} */ (config.mcp);
  t.deepEqual(mcp.endo.environment, { SOCKET: '/run/endo.sock' });
  t.is(mcp.endo.enabled, true);
});

test('rejects invalid inputs', t => {
  t.throws(() => makeOpencodeConfig({ model: 'anthropic/claude-sonnet-5' }), {
    message: /must start with/,
  });
  t.throws(() => makeOpencodeConfig({ model: 'openrouter/' }), {
    message: /must be <vendor>\/<model>/,
  });
  t.throws(() => makeOpencodeConfig({ model: 'openrouter/vendor/' }), {
    message: /empty segment/,
  });
  t.throws(() => makeOpencodeConfig({ model: 'openrouter/vendor/..' }), {
    message: /invalid model segment/,
  });
  t.throws(
    () => makeOpencodeConfig({ model: DEFAULT_MODEL, agentName: 'Bad Name' }),
    {
      message: /agentName/,
    },
  );
  for (const agentName of ['constructor', 'build', 'plan']) {
    t.throws(() => makeOpencodeConfig({ model: DEFAULT_MODEL, agentName }), {
      message: /reserved/,
    });
  }
  t.throws(
    () =>
      makeOpencodeConfig({
        model: DEFAULT_MODEL,
        baseUrl: 'http://openrouter.ai/api/v1',
      }),
    {
      message: /must use https/,
    },
  );
  t.throws(
    () =>
      makeOpencodeConfig({
        model: DEFAULT_MODEL,
        baseUrl: 'https://evil.example/api/v1',
      }),
    {
      message: /openrouter\.ai/,
    },
  );
  t.throws(
    () =>
      makeOpencodeConfig({
        model: DEFAULT_MODEL,
        baseUrl: 'https://user:pass@openrouter.ai/api/v1',
      }),
    { message: /credentials/ },
  );
  t.throws(
    () =>
      makeOpencodeConfig({
        model: DEFAULT_MODEL,
        baseUrl: 'https://openrouter.ai/api/v2',
      }),
    { message: /api\/v1/ },
  );
  t.throws(
    () =>
      makeOpencodeConfig({
        model: DEFAULT_MODEL,
        baseUrl: 'https://openrouter.ai/api/v1?x=1',
      }),
    { message: /query or fragment/ },
  );
  t.throws(
    () =>
      makeOpencodeConfig({
        model: DEFAULT_MODEL,
        baseUrl: 'https://openrouter.ai:8443/api/v1',
      }),
    { message: /default https port/ },
  );
  t.throws(
    () => makeOpencodeConfig({ model: DEFAULT_MODEL, systemPrompt: '' }),
    {
      message: /must not be empty/,
    },
  );
  t.throws(
    () =>
      makeOpencodeConfig({
        model: DEFAULT_MODEL,
        systemPrompt: 'x'.repeat(48 * 1024 + 1),
      }),
    { message: /too large/ },
  );
  // Multibyte text is rejected on UTF-8 bytes, not UTF-16 code units.
  t.throws(
    () =>
      makeOpencodeConfig({
        model: DEFAULT_MODEL,
        systemPrompt: 'あ'.repeat(20 * 1024),
      }),
    {
      message: /too large/,
    },
  );
  t.throws(
    () =>
      makeOpencodeConfig(
        /** @type {any} */ ({
          model: DEFAULT_MODEL,
          models: { 'vendor/model': { limit: null } },
        }),
      ),
    { message: /must be a record/ },
  );
  t.throws(
    () =>
      makeOpencodeConfig(
        /** @type {any} */ ({
          model: DEFAULT_MODEL,
          models: { 'vendor/model': { unexpected: true } },
        }),
      ),
    { message: /unknown fields/ },
  );
  t.throws(
    () =>
      makeOpencodeConfig({
        model: DEFAULT_MODEL,
        models: { noslash: { name: 'x' } },
      }),
    {
      message: /must be <vendor>\/<model>/,
    },
  );
});

test('catalog keys are exact provider ids, not aliases of full refs', t => {
  const config = makeOpencodeConfig({
    model: DEFAULT_MODEL,
    models: {
      'vendor/model': { name: 'a' },
      'openrouter/vendor/model': { name: 'b' },
    },
  });
  t.is(config.provider.openrouter.models['vendor/model'].name, 'a');
  t.is(config.provider.openrouter.models['openrouter/vendor/model'].name, 'b');
});

test('partial observed limits remain independent without fabricated fields or ordering', t => {
  for (const limit of [
    { output: 4096 },
    { context: 100, output: 100 },
    { context: 1, output: 4096 },
  ]) {
    const config = makeOpencodeConfig({
      model: DEFAULT_MODEL,
      models: { 'vendor/model': { limit } },
    });
    t.deepEqual(config.provider.openrouter.models['vendor/model'].limit, limit);
  }
  for (const limit of [
    {},
    { output: 0 },
    { output: -1 },
    { output: 1.5 },
    { output: 0x1_0000_0000 },
    { output: '4096' },
    { output: null },
    { output: 4096, unknown: 1 },
  ]) {
    t.throws(() =>
      makeOpencodeConfig(
        /** @type {any} */ ({
          model: DEFAULT_MODEL,
          models: { 'vendor/model': { limit } },
        }),
      ),
    );
  }
});

test('rejects invalid mcp server maps', t => {
  t.throws(
    () =>
      makeOpencodeConfig(
        /** @type {any} */ ({ model: DEFAULT_MODEL, mcpServers: [] }),
      ),
    {
      message: /must be a record/,
    },
  );
  t.throws(
    () =>
      makeOpencodeConfig(
        /** @type {any} */ ({
          model: DEFAULT_MODEL,
          mcpServers: JSON.parse(
            '{"__proto__":{"type":"local","command":["node"]}}',
          ),
        }),
      ),
    { message: /key .* is invalid/ },
  );
  t.throws(
    () =>
      makeOpencodeConfig(
        /** @type {any} */ ({
          model: DEFAULT_MODEL,
          mcpServers: { endo: { type: 'remote', url: 'https://example.com' } },
        }),
      ),
    { message: /unknown fields|must be a local server/ },
  );
  t.throws(
    () =>
      makeOpencodeConfig(
        /** @type {any} */ ({
          model: DEFAULT_MODEL,
          mcpServers: { endo: { type: 'local', command: [] } },
        }),
      ),
    { message: /command must be a bounded array/ },
  );
  t.throws(
    () =>
      makeOpencodeConfig(
        /** @type {any} */ ({
          model: DEFAULT_MODEL,
          mcpServers: { endo: { type: 'local', command: ['node'], extra: 1 } },
        }),
      ),
    { message: /unknown fields/ },
  );
});

test('parseModelRef returns the provider-scoped model id', t => {
  t.is(
    parseModelRef('openrouter/deepseek/deepseek-v4.1-flash'),
    'deepseek/deepseek-v4.1-flash',
  );
  t.is(
    parseModelRef('openrouter/google/gemini-3-pro:free'),
    'google/gemini-3-pro:free',
  );
  t.throws(() => parseModelRef('openrouter//bad'), {
    message: /empty segment|invalid vendor segment/,
  });
  t.throws(() => parseModelRef(''), { message: /must start with/ });
});
