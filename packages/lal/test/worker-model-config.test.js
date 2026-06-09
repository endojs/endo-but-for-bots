// @ts-check
/* global process */

import test from '@endo/ses-ava/prepare-endo.js';

import { resolveWorkerModel } from '../agent.js';

test('worker model config preserves custom OpenAI-compatible /v1 endpoint', async t => {
  const { model, getApiKey } = await resolveWorkerModel({
    LAL_HOST: 'http://localhost:8080/v1',
    LAL_MODEL: 'qwen3',
  });

  t.is(model.id, 'qwen3');
  t.is(model.name, 'openai-compatible/qwen3');
  t.is(model.provider, 'openai');
  t.is(model.baseUrl, 'http://localhost:8080/v1');
  t.is(await getApiKey?.('openai'), 'ollama');
});

test('worker model config preserves remote Ollama endpoint and worker token', async t => {
  const { model, getApiKey } = await resolveWorkerModel({
    LAL_HOST: 'https://ollama.example.com',
    LAL_MODEL: 'qwen3',
    LAL_AUTH_TOKEN: 'worker-token',
  });

  t.is(model.id, 'qwen3');
  t.is(model.name, 'ollama/qwen3');
  t.is(model.provider, 'openai');
  t.is(model.baseUrl, 'https://ollama.example.com/v1');
  t.is(await getApiKey?.('openai'), 'worker-token');
});

test('worker API tokens are per worker and do not mutate process env', async t => {
  const previousOpenAIKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'ambient-token';
  await Promise.resolve();
  try {
    const first = await resolveWorkerModel({
      LAL_HOST: 'https://api.openai.com/v1',
      LAL_MODEL: 'gpt-4o',
      LAL_AUTH_TOKEN: 'first-worker-token',
    });
    const second = await resolveWorkerModel({
      LAL_HOST: 'https://api.openai.com/v1',
      LAL_MODEL: 'gpt-4o',
      LAL_AUTH_TOKEN: 'second-worker-token',
    });

    t.is(first.model.baseUrl, 'https://api.openai.com/v1');
    t.is(second.model.baseUrl, 'https://api.openai.com/v1');
    t.is(await first.getApiKey?.('openai'), 'first-worker-token');
    t.is(await second.getApiKey?.('openai'), 'second-worker-token');
    t.is(process.env.OPENAI_API_KEY, 'ambient-token');
  } finally {
    if (previousOpenAIKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = previousOpenAIKey;
    }
  }
});

test('worker model config upgrades qwen3 form default for hosted providers', async t => {
  const { model, getApiKey } = await resolveWorkerModel({
    LAL_HOST: 'https://api.anthropic.com',
    LAL_MODEL: 'qwen3',
  });

  t.is(model.provider, 'anthropic');
  t.is(model.id, 'claude-opus-4-5-20251101');
  t.is(await getApiKey?.('anthropic'), undefined);
});
