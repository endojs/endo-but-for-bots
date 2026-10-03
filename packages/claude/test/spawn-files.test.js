// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  makeSpawnFilesPreparer,
  OAUTH_TOKEN_PREFIX,
  DISABLED_BUILTIN_PLUGINS,
} from '../src/spawn-files.js';

/** @param {string} credential */
const prepareWith = async credential => {
  const parentDir = await fs.mkdtemp(path.join(os.tmpdir(), 'spawn-files-'));
  const prepare = makeSpawnFilesPreparer({
    parentDir,
    pathValue: '/usr/bin:/bin',
    credentialFor: async () => credential,
  });
  const files = await prepare({
    sessionTag: 'tag',
    mcpConfigJson: '{"mcpServers":{}}',
    settingsJson: JSON.stringify({ apiKeyHelper: 'placeholder' }),
  });
  const settings = JSON.parse(await fs.readFile(files.settingsPath, 'utf-8'));
  const entries = await fs.readdir(path.dirname(files.settingsPath));
  return { parentDir, files, settings, entries };
};

test('an API key is presented through the apiKeyHelper', async t => {
  const { parentDir, files, settings, entries } =
    await prepareWith('sk-ant-api03-key');
  t.deepEqual(settings, {
    apiKeyHelper: files.apiKeyHelperCommand,
    enabledPlugins: DISABLED_BUILTIN_PLUGINS,
  });
  t.true(entries.includes('credential'));
  await files.cleanup();
  await fs.rm(parentDir, { recursive: true, force: true });
});

test('a subscription OAuth token is presented as ANTHROPIC_AUTH_TOKEN', async t => {
  const token = `${OAUTH_TOKEN_PREFIX}01-token`;
  const { parentDir, files, settings, entries } = await prepareWith(token);
  t.deepEqual(settings, {
    env: { ANTHROPIC_AUTH_TOKEN: token },
    enabledPlugins: DISABLED_BUILTIN_PLUGINS,
  });
  t.false(entries.includes('credential'), 'no credential file is written');
  const stat = await fs.stat(files.settingsPath);
  t.is(stat.mode % 0o1000, 0o600);
  await files.cleanup();
  await fs.rm(parentDir, { recursive: true, force: true });
});
