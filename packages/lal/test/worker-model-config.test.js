// @ts-check

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

test('worker model config preserves remote Ollama endpoint', async t => {
  const { model, getApiKey } = await resolveWorkerModel({
    LAL_HOST: 'https://ollama.example.com',
    LAL_MODEL: 'qwen3',
  });

  t.is(model.id, 'qwen3');
  t.is(model.name, 'ollama/qwen3');
  t.is(model.provider, 'openai');
  t.is(model.baseUrl, 'https://ollama.example.com/v1');
  t.is(await getApiKey?.('openai'), 'ollama');
});

test('worker model config upgrades qwen3 form default for hosted providers', async t => {
  const { model, getApiKey } = await resolveWorkerModel({
    LAL_HOST: 'https://api.anthropic.com',
    LAL_MODEL: 'qwen3',
  });

  t.is(model.provider, 'anthropic');
  t.is(model.id, 'claude-opus-4-5-20251101');
  t.is(getApiKey, undefined);
});
