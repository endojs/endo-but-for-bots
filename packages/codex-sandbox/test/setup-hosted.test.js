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
      mints.push({ worker, specifier, options });
      const result = Array.isArray(options.resultName)
        ? options.resultName
        : [options.resultName];
      bindings.set(key(...result), `${result.at(-1)}-id`);
      specifiers.set(`${result.at(-1)}-id`, specifier);
      environments.set(`${result.at(-1)}-id`, options.env);
    },
  });
  return { host, bindings, mints, stored, copies, removed };
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
    ENDO_CODEX_MODELS: JSON.stringify([{ id: 'gpt-5.6-sol', isDefault: true }]),
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

test.serial('requires the host-side formulas', async t => {
  await baseEnv(t);
  const fake = makeFakeHost();
  fake.bindings.delete(key('codex-sandbox', 'state-provider'));
  await t.throwsAsync(main(fake.host, { exec: noExec }), {
    message: /state-provider.*run setup-host\.js first/s,
  });
  t.deepEqual(fake.mints, []);
});

test.serial('refuses an owner label the runtime does not run as', async t => {
  // The volume registry records one owner and refuses a change outright, so a
  // disagreement is a migration, not a restart.
  await baseEnv(t);
  withEnv(t, { ENDO_CODEX_SANDBOX_OWNER_ID: 'codex-other' });
  const fake = makeFakeHost();
  await t.throwsAsync(main(fake.host, { exec: noExec }), {
    message: /native-sandbox runs as .*codex-test-owner.*codex-other/s,
  });
  t.deepEqual(fake.mints, []);
});

test.serial('mints the credential, the backend, and binds Floot', async t => {
  const base = await baseEnv(t);
  const fake = makeFakeHost();
  await main(fake.host, { exec: noExec });

  const credentialMint = fake.mints.find(
    mint => mint.specifier === renewableCredentialsSpecifier,
  );
  t.truthy(credentialMint);
  t.is(credentialMint.options.powersName, '@agent');
  t.deepEqual(credentialMint.options.env, {
    CREDENTIAL_SECRET_PATH: JSON.stringify([
      'secrets',
      'codex-subscription-auth',
    ]),
    CREDENTIAL_LABEL: 'Codex',
  });

  const backendMint = fake.mints.find(
    mint => mint.specifier === backendSpecifier,
  );
  t.truthy(backendMint);
  // The backend is minted under a temporary name first, so a failed mint leaves
  // the live backend and Floot's binding to it working.
  t.deepEqual(backendMint.options.resultName, [
    'codex-sandbox',
    'backend-next',
  ]);
  t.is(backendMint.options.powersName, 'codex.backend-powers');

  // Its powers is a record of exactly three capabilities, and the temporary
  // name that carried it is removed again.
  const [bundle] = fake.stored;
  t.deepEqual(Object.keys(bundle.value).sort(), [
    'credential',
    'sandbox',
    'stateProvider',
  ]);
  t.true(
    fake.removed.some(parts => key(...parts) === key('codex.backend-powers')),
  );

  const config = JSON.parse(backendMint.options.env.CODEX_HOST_CONFIG);
  t.is(config.accountRef, accountId);
  t.is(config.ownerId, ownerId);
  t.is(config.imageRef, `localhost/codex-subscription@${digest}`);
  t.deepEqual(config.projectIds, { first: 42_020, last: 43_019 });
  // The daemon's own 9P mount programs are recorded with the rest of the
  // configuration, so the backend never reads a process environment for them.
  t.deepEqual(config.mounterEnv, {
    NINEP_MOUNT_PROGRAM: '/run/wrappers/bin/sudo /nix/store/x/bin/mount',
    NINEP_UMOUNT_PROGRAM: '/run/wrappers/bin/sudo /nix/store/x/bin/umount',
    NINEP_SUDO: '1',
  });
  // Absent means broker-only; a stale rollout flag is what made revival throw.
  t.false('publicInternet' in config);
  t.false('diagnostics' in config);

  t.true(
    fake.copies.some(
      ({ to }) =>
        key(...to) === key('floot', 'controller-profile', 'codex-backend'),
    ),
  );
  // The private host root is created with the mode the registry expects.
  // eslint-disable-next-line no-bitwise
  t.is((await stat(path.join(base, 'host'))).mode & 0o777, 0o700);
});

test.serial('resolves an unpinned slice image through Podman', async t => {
  await baseEnv(t);
  withEnv(t, {
    ENDO_CODEX_SANDBOX_IMAGE: 'oci:localhost/codex-subscription:0.152.0',
  });
  const fake = makeFakeHost();
  await main(fake.host, {
    exec: async () => ({ stdout: `${digest}\n` }),
  });
  const backendMint = fake.mints.find(
    mint => mint.specifier === backendSpecifier,
  );
  const config = JSON.parse(backendMint.options.env.CODEX_HOST_CONFIG);
  // The tag it was reached by is dropped: `name:tag@digest` is a reference the
  // native runtime refuses.
  t.is(config.imageRef, `localhost/codex-subscription@${digest}`);
});

test.serial(
  'refuses a credential that is not a normalized state record',
  async t => {
    await baseEnv(t);
    const fake = makeFakeHost({
      credentialState: { tokens: { access_token: 'x' } },
    });
    await t.throwsAsync(main(fake.host, { exec: noExec }), {
      message: /Import and normalize the Codex subscription credential/,
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

test.serial(
  'refuses to re-point an existing backend at another account',
  async t => {
    await baseEnv(t);
    const fake = makeFakeHost({
      backendConfig: {
        accountRef: 'account-z',
        directory: '/var/lib/endo/codex',
        filesystem: '/var/lib/endo/volumes',
        imageRef: `localhost/codex-subscription@${digest}`,
        listenerImageRef: listenerRef,
        maxSessions: 2,
        models: [{ id: 'gpt-5.6-sol' }],
        ownerId,
        projectIds: { first: 42_020, last: 43_019 },
        quotaCommand: '/etc/endo/codex-quota',
        stateBytes: '268435456',
        volumeRoot: '/var/lib/endo/volumes',
      },
    });
    await t.throwsAsync(main(fake.host, { exec: noExec }), {
      message: /pinned to account .*account-z.*migration/s,
    });
    t.false(fake.mints.some(mint => mint.specifier === backendSpecifier));
  },
);

test.serial(
  'a malformed setting is refused before anything is minted',
  async t => {
    await baseEnv(t);
    withEnv(t, { ENDO_CODEX_STATE_BYTES: '268435457' });
    const fake = makeFakeHost();
    await t.throwsAsync(main(fake.host, { exec: noExec }), {
      message: /stateBytes.*MiB-aligned/s,
    });
    t.deepEqual(fake.mints, []);
    t.deepEqual(fake.stored, []);
  },
);

test.serial('public internet and diagnostics are opt-in', async t => {
  await baseEnv(t);
  withEnv(t, {
    ENDO_CODEX_PUBLIC_INTERNET: '1',
    ENDO_CODEX_DIAGNOSTICS: '1',
  });
  const fake = makeFakeHost();
  await main(fake.host, { exec: noExec });
  const backendMint = fake.mints.find(
    mint => mint.specifier === backendSpecifier,
  );
  const config = JSON.parse(backendMint.options.env.CODEX_HOST_CONFIG);
  t.true(config.publicInternet);
  t.true(config.diagnostics);
});

test.serial('a rerun retains the backend instead of re-minting it', async t => {
  // The caplet constructs the provider listener, which takes an exclusive lock
  // keyed by the owner label, so minting a replacement beside the live one
  // fails with "Provider runtime owner is already active" — which aborted
  // setup on the second daemon start, before the Floot binding.
  await baseEnv(t);
  const first = makeFakeHost();
  await main(first.host, { exec: noExec });
  const minted = first.mints.find(mint => mint.specifier === backendSpecifier);
  const configText = minted.options.env.CODEX_HOST_CONFIG;

  const second = makeFakeHost({ backendConfig: JSON.parse(configText) });
  await main(second.host, { exec: noExec });
  t.false(second.mints.some(mint => mint.specifier === backendSpecifier));
  t.deepEqual(second.stored, []);
  // Floot is still re-bound, so a profile that lost the name recovers.
  t.true(
    second.copies.some(
      ({ to }) =>
        key(...to) === key('floot', 'controller-profile', 'codex-backend'),
    ),
  );
});

test.serial(
  'a changed configuration is refused, not applied beside the live one',
  async t => {
    await baseEnv(t);
    const first = makeFakeHost();
    await main(first.host, { exec: noExec });
    const configText = first.mints.find(
      mint => mint.specifier === backendSpecifier,
    ).options.env.CODEX_HOST_CONFIG;

    const changed = makeFakeHost({ backendConfig: JSON.parse(configText) });
    withEnv(t, { ENDO_CODEX_MAX_SESSIONS: '3' });
    await t.throwsAsync(main(changed.host, { exec: noExec }), {
      message: /configuration changed.*retire/s,
    });
    t.false(changed.mints.some(mint => mint.specifier === backendSpecifier));
  },
);
