// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';

import { mapProfileToAgentryConfig } from '../src/backend/engine.js';

/** @import { AgentryProfile } from '../src/backend/engine.js' */

test('maps a profile + model to a code-mode config.model { provider, model, baseUrl }', t => {
  const { configModel } = mapProfileToAgentryConfig({
    profile: {
      provider: 'openai',
      apiKey: 'sk-secret',
      baseUrl: 'https://api.openai.com',
    },
    model: 'gpt-4o',
  });
  t.deepEqual(configModel, {
    provider: 'openai',
    model: 'gpt-4o',
    baseUrl: 'https://api.openai.com',
  });
});

test('getApiKey returns the profile apiKey, and the key is NOT in the config record', t => {
  const mapping = mapProfileToAgentryConfig({
    profile: { provider: 'anthropic', apiKey: 'sk-ant-XYZ' },
    model: 'claude',
  });
  t.is(mapping.getApiKey(), 'sk-ant-XYZ');
  // The secret must never appear in the config that ends up in prompts/schemas.
  const serializedConfig = JSON.stringify({
    model: mapping.configModel,
    powers: mapping.configPowers,
  });
  t.false(serializedConfig.includes('sk-ant-XYZ'));
  t.is(
    /** @type {Record<string, unknown>} */ (mapping.configModel).apiKey,
    undefined,
  );
});

test('config.powers carries the pet names and git mode, defaulting sensibly', t => {
  const defaults = mapProfileToAgentryConfig({
    profile: { provider: 'ollama', apiKey: 'x' },
    model: 'qwen3',
  });
  t.deepEqual(defaults.configPowers, {
    workspacePetName: 'workspace',
    gitPetName: 'git',
    gitMode: 'readWrite',
  });
  const explicit = mapProfileToAgentryConfig({
    profile: { provider: 'ollama', apiKey: 'x' },
    model: 'qwen3',
    powers: {
      workspacePetName: 'repo',
      gitPetName: 'repoGit',
      gitMode: 'readOnly',
    },
  });
  t.deepEqual(explicit.configPowers, {
    workspacePetName: 'repo',
    gitPetName: 'repoGit',
    gitMode: 'readOnly',
  });
});

test('omits baseUrl from config.model when the profile has none', t => {
  const { configModel } = mapProfileToAgentryConfig({
    profile: { provider: 'openai', apiKey: 'k' },
    model: 'gpt-4o',
  });
  t.deepEqual(configModel, { provider: 'openai', model: 'gpt-4o' });
});

test('rejects a missing provider or model name', t => {
  t.throws(
    () =>
      mapProfileToAgentryConfig({
        // deliberately missing `provider` to exercise the guard
        profile: /** @type {AgentryProfile} */ (
          /** @type {unknown} */ ({ apiKey: 'k' })
        ),
        model: 'm',
      }),
    { message: /provider/ },
  );
  t.throws(
    () =>
      mapProfileToAgentryConfig({
        profile: { provider: 'openai', apiKey: 'k' },
        model: '',
      }),
    { message: /model name/ },
  );
});
