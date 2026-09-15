// @ts-check
import '@endo/init';

import test from 'ava';

import {
  readCodexHostConfig,
  readCodexHostConfigEnv,
} from '../src/codex-host-config.js';

const digest = `sha256:${'a'.repeat(64)}`;
const listenerDigest = `sha256:${'b'.repeat(64)}`;

/** The configuration Codex Sol was actually provisioned with, minimized. */
const base = () =>
  harden({
    accountRef: 'acct-123',
    directory: '/var/lib/endo/codex-subscription-v2',
    filesystem: '/var/lib/endo/.local/share/containers/storage/volumes',
    imageRef: `localhost/codex-subscription@${digest}`,
    listenerImageRef: `localhost/endo-provider@${listenerDigest}`,
    maxSessions: 2,
    models: [{ id: 'gpt-5.6-sol', isDefault: true }],
    projectIds: { first: 42_020, last: 43_019 },
    quotaCommand: '/etc/endo/codex-quota',
    stateBytes: '268435456',
    volumeRoot: '/var/lib/endo/.local/share/containers/storage/volumes',
    workspaceBytes: '536870912',
  });

test('reads the deployed configuration', t => {
  const config = readCodexHostConfig(base());
  t.is(config.imageDigest, digest);
  t.is(config.accountRef, 'acct-123');
  t.deepEqual(config.volumeLimits, {
    workspaceBytes: 536_870_912n,
    stateBytes: 268_435_456n,
  });
  t.deepEqual(config.projectIds, { first: 42_020, last: 43_019 });
});

test('defaults are the ones the deployment relies on', t => {
  const config = readCodexHostConfig(base());
  t.false(config.diagnostics);
  // Absent means broker-only. A stale rollout config that set this was what
  // made revival throw "Invalid public network configuration".
  t.false(config.publicInternet);
  t.is(config.sudoPath, '/usr/bin/sudo');
  t.is(config.flockPath, '/usr/bin/flock');
  t.deepEqual([...config.secretPath], ['secrets', 'codex-subscription-auth']);
});

test('an unknown key is refused rather than ignored', t => {
  // A setting this version cannot honour must not silently enable something
  // other than what the operator wrote.
  t.throws(() => readCodexHostConfig({ ...base(), pubicInternet: true }), {
    message: /unknown keys.*pubicInternet/s,
  });
});

test('a tagged slice image is refused', t => {
  t.throws(
    () =>
      readCodexHostConfig({
        ...base(),
        imageRef: 'localhost/codex-subscription:0.152.0',
      }),
    { message: /must be pinned to a digest/ },
  );
});

test('an unpinned listener image is refused', t => {
  t.throws(
    () =>
      readCodexHostConfig({
        ...base(),
        listenerImageRef: 'localhost/endo-provider:latest',
      }),
    { message: /listenerImageRef.*digest-pinned/s },
  );
});

test('a byte budget must be a MiB-aligned decimal string', t => {
  t.throws(() => readCodexHostConfig({ ...base(), stateBytes: 268_435_456 }), {
    message: /stateBytes.*written as a string/s,
  });
  t.throws(
    () => readCodexHostConfig({ ...base(), workspaceBytes: '536870913' }),
    { message: /workspaceBytes.*MiB-aligned/s },
  );
});

test('a project ID range must be ordered and bounded', t => {
  t.throws(
    () =>
      readCodexHostConfig({ ...base(), projectIds: { first: 100, last: 100 } }),
    { message: /projectIds/ },
  );
  t.throws(
    () =>
      readCodexHostConfig({
        ...base(),
        projectIds: { first: 100, last: 200, step: 2 },
      }),
    { message: /projectIds/ },
  );
});

test('every host path must be normalized, absolute and non-root', t => {
  for (const key of [
    'directory',
    'filesystem',
    'quotaCommand',
    'volumeRoot',
    'sudoPath',
    'flockPath',
  ]) {
    t.throws(() => readCodexHostConfig({ ...base(), [key]: 'relative/path' }), {
      message: new RegExp(key),
    });
    t.throws(() => readCodexHostConfig({ ...base(), [key]: '/' }), {
      message: new RegExp(key),
    });
    t.throws(() => readCodexHostConfig({ ...base(), [key]: '/a/../b' }), {
      message: new RegExp(key),
    });
  }
});

test('an account reference is required and pinned', t => {
  t.throws(() => readCodexHostConfig({ ...base(), accountRef: '' }), {
    message: /accountRef/,
  });
  t.throws(() => readCodexHostConfig({ ...base(), accountRef: 'has spaces' }), {
    message: /accountRef/,
  });
});

test('models need plain provider ids', t => {
  t.throws(() => readCodexHostConfig({ ...base(), models: [] }), {
    message: /models/,
  });
  t.throws(
    () => readCodexHostConfig({ ...base(), models: [{ id: 'openai/gpt' }] }),
    { message: /provider model id/ },
  );
});

test('the env reader names the variable it refused', t => {
  t.throws(() => readCodexHostConfigEnv({}), {
    message: /CODEX_HOST_CONFIG is required/,
  });
  t.throws(() => readCodexHostConfigEnv({ CODEX_HOST_CONFIG: '{' }), {
    message: /CODEX_HOST_CONFIG is not valid JSON/,
  });
  t.is(
    readCodexHostConfigEnv({ CODEX_HOST_CONFIG: JSON.stringify(base()) })
      .accountRef,
    'acct-123',
  );
});
