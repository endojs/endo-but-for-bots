// @ts-check
import '@endo/init';

import test from 'ava';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { renewableCredentialsSpecifier } from '@endo/hosted-agent/managed-renewable-credentials.js';

import { main } from '../setup-hosted.js';
import {
  backendSpecifier,
  nativeSandboxSpecifier,
  stateProviderSpecifier,
} from '../src/hosted-runtime-setup.js';

const key = (...parts) => JSON.stringify(parts.flat());

const digest = `sha256:${'a'.repeat(64)}`;
const listenerRef = `localhost/endo-provider@sha256:${'b'.repeat(64)}`;
const ownerId = 'codex-test-owner';
const accountId = 'account-a';

// What the fake reports for a persisted formula it has no entry for: a generic
// entrypoint no service accepts.
const unsupportedSpecifier = new URL('../src/codex-client.js', import.meta.url)
  .href;

/**
 * @param {{ backendConfig?: any, credentialState?: any,
 *   nativeEnv?: Record<string, string> }} [options]
 */
const makeFakeHost = ({
  backendConfig = undefined,
  credentialState = { version: 'BrokerOAuthStateV1', accountId },
  nativeEnv = {},
} = {}) => {
  const bindings = new Map();
  /** @type {any[]} */
  const mints = [];
  /** @type {any[]} */
  const stored = [];
  /** @type {any[]} */
  const copies = [];
  /** @type {any[]} */
  const removed = [];
  const environments = new Map();
  const specifiers = new Map();
  const powersIds = new Map();
  const bind = (namePath, id, specifier, env) => {
    bindings.set(key(...namePath), id);
    specifiers.set(id, specifier);
    environments.set(id, harden(env));
  };
  bind(
    ['codex-sandbox', 'native-sandbox'],
    'native-id',
    nativeSandboxSpecifier,
    {
      ENDO_SANDBOX_RUNTIME_DIR: '/var/lib/endo/codex-runtime',
      ENDO_SANDBOX_OWNER_ID: ownerId,
      ENDO_SANDBOX_GENERATED_MAX_BYTES: '4096',
      ENDO_SANDBOX_GENERATED_MAX_ENTRIES: '16',
      ENDO_CODEX_VOLUME_ROOT: '/var/lib/endo/volumes',
      ENDO_CODEX_FILESYSTEM: '/var/lib/endo/volumes',
      ENDO_CODEX_QUOTA_COMMAND: '/etc/endo/codex-quota',
      ...nativeEnv,
    },
  );
  bind(
    ['codex-sandbox', 'state-provider'],
    'state-id',
    stateProviderSpecifier,
    {
      ENDO_CODEX_STATE_DIR: '/var/lib/endo/codex-state',
    },
  );
  bindings.set(key('floot', 'controller-profile'), 'dir');
  if (backendConfig) {
    bind(['codex-sandbox', 'backend'], 'backend-id', backendSpecifier, {
      CODEX_HOST_CONFIG: JSON.stringify(backendConfig),
    });
  }
  const credential = harden({
    readBase64WithGeneration: async () =>
      harden({
        base64: btoa(JSON.stringify(credentialState)),
        generation: 7n,
      }),
  });
  const host = harden({
    async identify(...parts) {
      if (parts[0] === '@agent') return 'fake-host-id';
      return bindings.get(key(...parts));
    },
    async diagnostics() {
      return harden({
        getFormula: async id =>
          harden({
            type: 'make-unconfined',
            properties: {
              powers: { kind: 'reference', identifier: powersIds.get(id) },
              specifier: {
                kind: 'literal',
                value: specifiers.get(id) ?? unsupportedSpecifier,
              },
            },
          }),
      });
    },
    async getFormulaEnvironment(id) {
      return environments.get(id);
    },
    async has(...parts) {
      return bindings.has(key(...parts));
    },
    async lookup(pathOrName) {
      const parts = Array.isArray(pathOrName) ? pathOrName : [pathOrName];
      if (parts[0] === '@secrets') {
        return harden({
          list: async () =>
            harden([
              { petNamePaths: [['secrets', 'codex-subscription-auth']] },
            ]),
        });
      }
      if (key(...parts) === key('codex-sandbox', 'credential'))
        return credential;
      return harden({ name: key(...parts) });
    },
    async storeValue(value, name) {
      stored.push({ value, name });
      bindings.set(key(name), 'marshal');
    },
    async copy(from, to) {
      copies.push({ from, to });
      bindings.set(key(...to), bindings.get(key(...from)) ?? 'cap');
    },
    async remove(...parts) {
      removed.push(parts);
      bindings.delete(key(...parts));
    },
    async makeUnconfined(worker, specifier, options) {
      if (typeof options.powersName !== 'string')
        throw Error('powersName must be one pet name');
      mints.push({ worker, specifier, options });
      const result = Array.isArray(options.resultName)
        ? options.resultName
        : [options.resultName];
      bindings.set(key(...result), `${result.at(-1)}-id`);
      specifiers.set(`${result.at(-1)}-id`, specifier);
      environments.set(`${result.at(-1)}-id`, options.env);
      powersIds.set(
        `${result.at(-1)}-id`,
        bindings.get(key(options.powersName)),
      );
    },
  });
  return { host, bindings, mints, stored, copies, removed, bind };
};

const withEnv = (t, values) => {
  const previous = new Map();
  for (const [name, value] of Object.entries(values)) {
    previous.set(name, process.env[name]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = /** @type {string} */ (value);
  }
  t.teardown(() => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
};

const baseEnv = async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'codex-setup-'));
  t.teardown(() => rm(base, { recursive: true, force: true }));
  withEnv(t, {
    ENDO_CODEX_ENABLE: '1',
    ENDO_CODEX_SANDBOX_OWNER_ID: ownerId,
    ENDO_CODEX_HOST_DIR: path.join(base, 'host'),
    ENDO_CODEX_SANDBOX_IMAGE: `oci:localhost/codex-subscription@${digest}`,
    ENDO_CODEX_BROKER_LISTENER_IMAGE: listenerRef,
    ENDO_CODEX_VOLUME_ROOT: '/var/lib/endo/volumes',
    ENDO_CODEX_FILESYSTEM: '/var/lib/endo/volumes',
    ENDO_CODEX_QUOTA_COMMAND: '/etc/endo/codex-quota',
    ENDO_CODEX_PROJECT_IDS: JSON.stringify({ first: 42_020, last: 43_019 }),
    ENDO_CODEX_MAX_SESSIONS: '2',
    ENDO_CODEX_STATE_BYTES: '268435456',
    ENDO_CODEX_MODELS: JSON.stringify([
      {
        id: 'model-a',
        displayName: 'Model A',
        isDefault: true,
        defaultReasoningEffort: null,
        supportedReasoningEfforts: [],
      },
    ]),
    ENDO_CODEX_NATIVE_PROFILE: JSON.stringify({
      uid: 1000,
      gid: 1000,
      memoryBytes: '536870912',
      cpuQuotaMicros: '200000',
      pids: 128,
      cpuPeriodMicros: 100_000,
      maxConcurrentOperations: 1,
    }),
    NINEP_MOUNT_PROGRAM: '/run/wrappers/bin/sudo /nix/store/x/bin/mount',
    NINEP_UMOUNT_PROGRAM: '/run/wrappers/bin/sudo /nix/store/x/bin/umount',
    NINEP_SUDO: '1',
    ENDO_CODEX_ACCOUNT_REF: undefined,
    ENDO_CODEX_PUBLIC_INTERNET: undefined,
    ENDO_CODEX_DIAGNOSTICS: undefined,
    ENDO_FLOOT_DIR: 'floot',
  });
  return base;
};

const noExec = async () => {
  throw Error('podman must not be consulted for an already-pinned image');
};

test.serial('missing configuration enables nothing', async t => {
  await baseEnv(t);
  withEnv(t, { ENDO_CODEX_ENABLE: undefined });
  const fake = makeFakeHost();
  await main(fake.host, { exec: noExec });
  t.deepEqual(fake.mints, []);
});

test.serial('refuses an owner label the runtime does not run as', async t => {
  await baseEnv(t);
  withEnv(t, { ENDO_CODEX_SANDBOX_OWNER_ID: 'codex-other' });
  const fake = makeFakeHost();
  await t.throwsAsync(main(fake.host, { exec: noExec }), {
    message: /owner differs/,
  });
  t.deepEqual(fake.mints, []);
});

test.serial(
  'mints retained credential/broker/storage and a replaceable daemon-owned backend',
  async t => {
    const base = await baseEnv(t);
    const fake = makeFakeHost();
    await main(fake.host, { exec: noExec });
    const credential = fake.mints.find(
      mint => mint.specifier === renewableCredentialsSpecifier,
    );
    t.is(credential.options.powersName, '@agent');
    const broker = fake.mints.find(
      mint => mint.options.resultName.at(-1) === 'broker-service',
    );
    const storage = fake.mints.find(
      mint => mint.options.resultName.at(-1) === 'session-storage',
    );
    const backend = fake.mints.find(
      mint => mint.specifier === backendSpecifier,
    );
    t.is(broker.options.powersName, 'codex.broker-service-powers');
    t.is(storage.options.powersName, 'codex.session-storage-powers');
    t.is(backend.options.powersName, '@agent');
    t.deepEqual(fake.stored, [], 'no legacy credential/runtime powers bundle');
    const config = JSON.parse(broker.options.env.CODEX_BROKER_CONFIG);
    t.is(config.accountRef, accountId);
    t.is(config.imageRef, `localhost/codex-subscription@${digest}`);
    t.false(config.publicInternet);
    t.false(config.diagnostics);
    t.false('projectIds' in config);
    t.false('volumeRoot' in config);
    t.deepEqual(JSON.parse(backend.options.env.CODEX_MOUNTER_ENV), {
      NINEP_MOUNT_PROGRAM: '/run/wrappers/bin/sudo /nix/store/x/bin/mount',
      NINEP_UMOUNT_PROGRAM: '/run/wrappers/bin/sudo /nix/store/x/bin/umount',
      NINEP_SUDO: '1',
    });
    t.is(
      storage.options.env.CODEX_WORKSPACE_BASE_DIR,
      path.join(base, 'host', 'workspaces'),
    );
    t.true(
      fake.copies.some(
        ({ to }) =>
          key(...to) === key('floot', 'controller-profile', 'codex-backend'),
      ),
    );
    // eslint-disable-next-line no-bitwise
    t.is((await stat(path.join(base, 'host', 'broker'))).mode & 0o777, 0o700);
    await main(fake.host, { exec: noExec });
    t.is(
      fake.mints.filter(
        mint => mint.options.resultName.at(-1) === 'broker-service',
      ).length,
      1,
    );
    t.is(
      fake.mints.filter(mint => mint.specifier === backendSpecifier).length,
      2,
    );
  },
);

test.serial('resolves an unpinned slice image through Podman', async t => {
  await baseEnv(t);
  withEnv(t, {
    ENDO_CODEX_SANDBOX_IMAGE: 'oci:localhost/codex-subscription:0.152.0',
  });
  const fake = makeFakeHost();
  await main(fake.host, { exec: async () => ({ stdout: `${digest}\n` }) });
  const broker = fake.mints.find(
    mint => mint.options.resultName.at(-1) === 'broker-service',
  );
  t.is(
    JSON.parse(broker.options.env.CODEX_BROKER_CONFIG).imageRef,
    `localhost/codex-subscription@${digest}`,
  );
});

test.serial(
  'refuses a non-normalized credential before publishing services',
  async t => {
    await baseEnv(t);
    const fake = makeFakeHost({
      credentialState: { tokens: { access_token: 'x' } },
    });
    await t.throwsAsync(main(fake.host, { exec: noExec }), {
      message: /normalized Codex subscription/,
    });
    t.false(fake.mints.some(mint => mint.specifier === backendSpecifier));
  },
);

test.serial(
  'refuses an account that disagrees with the credential',
  async t => {
    await baseEnv(t);
    withEnv(t, { ENDO_CODEX_ACCOUNT_REF: 'account-b' });
    const fake = makeFakeHost();
    await t.throwsAsync(main(fake.host, { exec: noExec }), {
      message: /account changed/,
    });
  },
);

test.serial('retained broker configuration cannot silently change', async t => {
  await baseEnv(t);
  const fake = makeFakeHost();
  await main(fake.host, { exec: noExec });
  const before = fake.mints.length;
  withEnv(t, { ENDO_CODEX_PUBLIC_INTERNET: '1' });
  await t.throwsAsync(main(fake.host, { exec: noExec }), {
    message: /retained service configuration changed/,
  });
  t.is(fake.mints.length, before);
});

test.serial('invalid native profile is refused before minting', async t => {
  await baseEnv(t);
  withEnv(t, { ENDO_CODEX_NATIVE_PROFILE: '{}' });
  const fake = makeFakeHost();
  await t.throwsAsync(main(fake.host, { exec: noExec }), {
    message: /Native profile/,
  });
  t.deepEqual(fake.mints, []);
});

test.serial(
  'retained storage refuses a rebound state-provider identity',
  async t => {
    await baseEnv(t);
    const fake = makeFakeHost();
    await main(fake.host, { exec: noExec });
    const before = fake.mints.length;
    fake.bind(
      ['codex-sandbox', 'state-provider'],
      'replacement-state-id',
      stateProviderSpecifier,
      { ENDO_CODEX_STATE_DIR: '/var/lib/endo/replacement-state' },
    );
    await t.throwsAsync(main(fake.host, { exec: noExec }), {
      message: /retained service dependency changed/,
    });
    t.is(fake.mints.length, before);
  },
);

test.serial(
  'daemon-prefixed projection settings reach the recorded backend',
  async t => {
    await baseEnv(t);
    withEnv(t, {
      ENDO_NINEP_SUDO: '1',
      ENDO_NINEP_MOUNT_PROGRAM: '/trusted/mount',
      ENDO_NINEP_UMOUNT_PROGRAM: '/trusted/umount',
      NINEP_MOUNT_PROGRAM: '/ignored/mount',
    });
    const fake = makeFakeHost();
    await main(fake.host, { exec: noExec });
    const backend = fake.mints.find(
      mint => mint.options.resultName.at(-1) === 'backend-next',
    );
    t.deepEqual(JSON.parse(backend.options.env.CODEX_MOUNTER_ENV), {
      NINEP_SUDO: '1',
      NINEP_MOUNT_PROGRAM: '/trusted/mount',
      NINEP_UMOUNT_PROGRAM: '/trusted/umount',
    });
  },
);

test.serial('public internet and diagnostics are opt-in', async t => {
  await baseEnv(t);
  withEnv(t, { ENDO_CODEX_PUBLIC_INTERNET: '1', ENDO_CODEX_DIAGNOSTICS: '1' });
  const fake = makeFakeHost();
  await main(fake.host, { exec: noExec });
  const broker = fake.mints.find(
    mint => mint.options.resultName.at(-1) === 'broker-service',
  );
  const config = JSON.parse(broker.options.env.CODEX_BROKER_CONFIG);
  t.true(config.publicInternet);
  t.true(config.diagnostics);
});
