// @ts-check
import '@endo/init';
import test from 'ava';

import {
  DEFAULT_LIMITS,
  DEFAULT_MODEL,
  OPENROUTER_NPM,
  makeOpencodeConfig,
  parseModelRef,
} from '../src/opencode-agent-config.js';

test('builds the default OpenRouter config with a fixed provider list', t => {
  const config = makeOpencodeConfig({ systemPrompt: 'You are Floot.' });
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
            limit: DEFAULT_LIMITS,
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
  t.is(
    provider.models['anthropic/claude-sonnet-5'].limit.context,
    DEFAULT_LIMITS.context,
  );
});

test('accepts full refs as catalog keys and whitelists the whole catalog', t => {
  const config = makeOpencodeConfig({
    model: 'openrouter/mistralai/mistral-large-3',
    models: {
      'openrouter/mistralai/mistral-large-3': {
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
  const config = makeOpencodeConfig();
  t.deepEqual(config.agent.floot, { disable: false, mode: 'primary' });
  t.false('mcp' in config);
});

test('normalizes a local mcp server map without freezing the caller input', t => {
  const mcpServers = {
    endo: { type: 'local', command: ['node', '/relay.mjs'], enabled: true },
  };
  const config = makeOpencodeConfig({ mcpServers });
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
    baseUrl: 'http://127.0.0.1:41337/api/v1',
    allowLoopbackHttp: true,
  });
  t.is(
    /** @type {any} */ (broker.provider).openrouter.options.baseURL,
    'http://127.0.0.1:41337/api/v1',
  );
  const ipv6 = makeOpencodeConfig({
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
    t.throws(() => makeOpencodeConfig({ baseUrl, allowLoopbackHttp: true }), {
      message: /baseUrl/,
    });
  }
  // Without the explicit opt-in, loopback http is not admitted at all.
  t.throws(
    () => makeOpencodeConfig({ baseUrl: 'http://127.0.0.1:41337/api/v1' }),
    { message: /must use https/ },
  );
});

test('passes through local mcp environment entries', t => {
  const config = makeOpencodeConfig({
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
  t.throws(() => makeOpencodeConfig({ agentName: 'Bad Name' }), {
    message: /agentName/,
  });
  for (const agentName of ['constructor', 'build', 'plan']) {
    t.throws(() => makeOpencodeConfig({ agentName }), {
      message: /reserved/,
    });
  }
  t.throws(
    () => makeOpencodeConfig({ baseUrl: 'http://openrouter.ai/api/v1' }),
    {
      message: /must use https/,
    },
  );
  t.throws(
    () => makeOpencodeConfig({ baseUrl: 'https://evil.example/api/v1' }),
    {
      message: /openrouter\.ai/,
    },
  );
  t.throws(
    () =>
      makeOpencodeConfig({ baseUrl: 'https://user:pass@openrouter.ai/api/v1' }),
    { message: /credentials/ },
  );
  t.throws(
    () => makeOpencodeConfig({ baseUrl: 'https://openrouter.ai/api/v2' }),
    { message: /api\/v1/ },
  );
  t.throws(
    () => makeOpencodeConfig({ baseUrl: 'https://openrouter.ai/api/v1?x=1' }),
    { message: /query or fragment/ },
  );
  t.throws(
    () => makeOpencodeConfig({ baseUrl: 'https://openrouter.ai:8443/api/v1' }),
    { message: /default https port/ },
  );
  t.throws(() => makeOpencodeConfig({ systemPrompt: '' }), {
    message: /must not be empty/,
  });
  t.throws(
    () => makeOpencodeConfig({ systemPrompt: 'x'.repeat(48 * 1024 + 1) }),
    { message: /too large/ },
  );
  // Multibyte text is rejected on UTF-8 bytes, not UTF-16 code units.
  t.throws(() => makeOpencodeConfig({ systemPrompt: 'あ'.repeat(20 * 1024) }), {
    message: /too large/,
  });
  t.throws(
    () =>
      makeOpencodeConfig(
        /** @type {any} */ ({
          models: { 'vendor/model': { limit: { context: 100, output: 100 } } },
        }),
      ),
    { message: /context must exceed output/ },
  );
  t.throws(
    () =>
      makeOpencodeConfig(
        /** @type {any} */ ({ models: { 'vendor/model': { limit: null } } }),
      ),
    { message: /must be a record/ },
  );
  t.throws(
    () =>
      makeOpencodeConfig(
        /** @type {any} */ ({
          models: { 'vendor/model': { unexpected: true } },
        }),
      ),
    { message: /unknown fields/ },
  );
  t.throws(() => makeOpencodeConfig({ models: { noslash: { name: 'x' } } }), {
    message: /must be <vendor>\/<model>/,
  });
  t.throws(
    () =>
      makeOpencodeConfig({
        models: {
          'vendor/model': { name: 'a' },
          'openrouter/vendor/model': { name: 'b' },
        },
      }),
    { message: /duplicate entry/ },
  );
});

test('rejects invalid mcp server maps', t => {
  t.throws(() => makeOpencodeConfig(/** @type {any} */ ({ mcpServers: [] })), {
    message: /must be a record/,
  });
  t.throws(
    () =>
      makeOpencodeConfig(
        /** @type {any} */ ({
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
          mcpServers: { endo: { type: 'remote', url: 'https://example.com' } },
        }),
      ),
    { message: /unknown fields|must be a local server/ },
  );
  t.throws(
    () =>
      makeOpencodeConfig(
        /** @type {any} */ ({
          mcpServers: { endo: { type: 'local', command: [] } },
        }),
      ),
    { message: /command must be a bounded array/ },
  );
  t.throws(
    () =>
      makeOpencodeConfig(
        /** @type {any} */ ({
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
