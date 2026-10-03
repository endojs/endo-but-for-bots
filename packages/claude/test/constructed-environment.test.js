// @ts-check
// spell-out-exempt: `CLAUDE_CONFIG_DIR` is Claude Code's own variable name.

import test from '@endo/ses-ava/prepare-endo.js';

import {
  CREDENTIAL_ENVIRONMENT_KEYS,
  buildConstructedEnvironment,
} from '../src/constructed-environment.js';

/**
 * @param {Record<string, string>} [credentialEnvironment]
 */
const spec = (credentialEnvironment = { ANTHROPIC_AUTH_TOKEN: 'lease' }) => ({
  configDirectory: '/scratch/turn/config',
  pathValue: '/opt/claude/bin',
  credentialEnvironment,
});

test('the environment is built from nothing plus the grant', t => {
  const env = buildConstructedEnvironment(
    spec({
      ANTHROPIC_AUTH_TOKEN: 'lease',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:4000',
    }),
  );
  t.deepEqual(env, {
    PATH: '/opt/claude/bin',
    HOME: '/scratch/turn/config',
    CLAUDE_CONFIG_DIR: '/scratch/turn/config',
    TMPDIR: '/scratch/turn/config',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    DISABLE_AUTOUPDATER: '1',
    ANTHROPIC_AUTH_TOKEN: 'lease',
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:4000',
  });
  t.true(Object.isFrozen(env));
});

test('the parent environment never leaks in', t => {
  const env = buildConstructedEnvironment(spec());
  for (const key of ['ENDO_SOCK', 'HTTPS_PROXY', 'XDG_RUNTIME_DIR', 'USER']) {
    t.false(key in env, key);
  }
});

test('a grant may deliver only the supported credential variables', t => {
  t.deepEqual(CREDENTIAL_ENVIRONMENT_KEYS, [
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_BASE_URL',
  ]);
  for (const key of [
    'CLAUDE_CODE_OAUTH_TOKEN',
    'PATH',
    'HOME',
    'NODE_OPTIONS',
  ]) {
    t.throws(() => buildConstructedEnvironment(spec({ [key]: 'value' })), {
      message: /unsupported variable/,
    });
  }
  t.throws(() => buildConstructedEnvironment(spec({})), {
    message: /no authenticating variable/,
  });
  t.throws(() => buildConstructedEnvironment(spec({ ANTHROPIC_API_KEY: '' })));
});

test('a routing variable alone does not authenticate', t => {
  t.throws(
    () =>
      buildConstructedEnvironment(
        spec({ ANTHROPIC_BASE_URL: 'http://127.0.0.1:4000' }),
      ),
    { message: /no authenticating variable/ },
  );
  t.notThrows(() =>
    buildConstructedEnvironment(
      spec({
        ANTHROPIC_API_KEY: 'key',
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:4000',
      }),
    ),
  );
});

test('a refused variable is named but its value is not', t => {
  const error = t.throws(() =>
    buildConstructedEnvironment(
      spec({ CLAUDE_CODE_OAUTH_TOKEN: 'secret-bytes' }),
    ),
  );
  t.false(error?.message.includes('secret-bytes'));
});

test('a credential holding a NUL is refused without quoting it', t => {
  const error = t.throws(() =>
    buildConstructedEnvironment(spec({ ANTHROPIC_API_KEY: 'sk-secret\0x' })),
  );
  t.regex(error?.message ?? '', /must not contain a NUL/);
  t.false(error?.message.includes('sk-secret'));
});

test('the locale variables take the given language', t => {
  const env = buildConstructedEnvironment({
    ...spec(),
    language: 'en_US.UTF-8',
  });
  t.is(env.LANG, 'en_US.UTF-8');
  t.is(env.LC_ALL, 'en_US.UTF-8');
});
