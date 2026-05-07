import test from '@endo/ses-ava/prepare-endo.js';

import {
  detectProviderKind,
  getDefaultModelForHost,
  resolveModelForHost,
} from '../providers/config.js';

test('detectProviderKind recognizes Gemini OpenAI-compatible endpoint', t => {
  t.is(
    detectProviderKind(
      'https://generativelanguage.googleapis.com/v1beta/openai/',
    ),
    'gemini',
  );
});

test('getDefaultModelForHost returns Gemini default model', t => {
  t.is(
    getDefaultModelForHost(
      'https://generativelanguage.googleapis.com/v1beta/openai/',
    ),
    'gemini-2.5-pro',
  );
});

test('resolveModelForHost upgrades legacy qwen3 placeholder for Gemini', t => {
  t.is(
    resolveModelForHost(
      'https://generativelanguage.googleapis.com/v1beta/openai/',
      'qwen3',
    ),
    'gemini-2.5-pro',
  );
});

test('resolveModelForHost preserves explicit non-default OpenAI-compatible models', t => {
  t.is(resolveModelForHost('https://api.openai.com/v1', 'gpt-4o'), 'gpt-4o');
});

test('detectProviderKind recognizes OpenRouter', t => {
  t.is(detectProviderKind('https://openrouter.ai/api/v1'), 'openrouter');
});

test('getDefaultModelForHost returns the OpenRouter default model', t => {
  t.is(
    getDefaultModelForHost('https://openrouter.ai/api/v1'),
    'anthropic/claude-sonnet-4-5',
  );
});

test('resolveModelForHost upgrades legacy qwen3 placeholder for OpenRouter', t => {
  t.is(
    resolveModelForHost('https://openrouter.ai/api/v1', 'qwen3'),
    'anthropic/claude-sonnet-4-5',
  );
});

test('resolveModelForHost preserves an explicit OpenRouter model slug', t => {
  t.is(
    resolveModelForHost('https://openrouter.ai/api/v1', 'openai/gpt-4o'),
    'openai/gpt-4o',
  );
});
