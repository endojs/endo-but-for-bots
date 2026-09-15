// @ts-check
import '@endo/init';

import test from 'ava';

import { readCodexNativeConfig } from '../src/codex-native-agent.js';

const base = () =>
  harden({
    ENDO_SANDBOX_RUNTIME_DIR: '/var/lib/endo/codex-runtime',
    ENDO_SANDBOX_OWNER_ID: 'codex-abc123',
    ENDO_SANDBOX_GENERATED_MAX_BYTES: '1048576',
    ENDO_SANDBOX_GENERATED_MAX_ENTRIES: '64',
    ENDO_CODEX_VOLUME_ROOT:
      '/var/lib/endo/.local/share/containers/storage/volumes',
    ENDO_CODEX_FILESYSTEM:
      '/var/lib/endo/.local/share/containers/storage/volumes',
    ENDO_CODEX_QUOTA_COMMAND: '/etc/endo/codex-quota',
  });

test('reads the runtime policy and the quota bridge together', t => {
  const config = readCodexNativeConfig(base());
  t.is(config.directory, '/var/lib/endo/codex-runtime');
  t.is(config.ownerId, 'codex-abc123');
  t.is(config.maxBytes, 1_048_576n);
  t.is(config.maxEntries, 64n);
  t.is(config.quota.quotaCommand, '/etc/endo/codex-quota');
  // The other two adapters have no quota bridge, so this default lives here.
  t.is(config.quota.sudoPath, '/usr/bin/sudo');
});

test('a runtime that cannot observe quotas is refused at construction', t => {
  // Not at the first session's volume admission, which is where an absent
  // observer would otherwise surface — as a refused mount, with nothing
  // pointing at the configuration.
  for (const name of [
    'ENDO_CODEX_VOLUME_ROOT',
    'ENDO_CODEX_FILESYSTEM',
    'ENDO_CODEX_QUOTA_COMMAND',
  ]) {
    t.throws(() => readCodexNativeConfig({ ...base(), [name]: undefined }), {
      message: new RegExp(name),
    });
  }
});

test('quota paths must be normalized, absolute and non-root', t => {
  t.throws(
    () => readCodexNativeConfig({ ...base(), ENDO_CODEX_SUDO_PATH: 'sudo' }),
    { message: /ENDO_CODEX_SUDO_PATH/ },
  );
  t.throws(
    () => readCodexNativeConfig({ ...base(), ENDO_CODEX_QUOTA_COMMAND: '/' }),
    { message: /ENDO_CODEX_QUOTA_COMMAND/ },
  );
});

test('the shared runtime policy is still enforced', t => {
  t.throws(
    () =>
      readCodexNativeConfig({ ...base(), ENDO_SANDBOX_OWNER_ID: undefined }),
    { message: /ENDO_SANDBOX_OWNER_ID/ },
  );
  t.throws(
    () =>
      readCodexNativeConfig({
        ...base(),
        ENDO_SANDBOX_GENERATED_MAX_ENTRIES: '0',
      }),
    { message: /entry budget must be positive/ },
  );
});
