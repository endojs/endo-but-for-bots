// @ts-check
import '@endo/init';
import test from 'ava';
import { access, mkdir, mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { inferCredentialKind, main } from '../setup-hosted.js';
import {
  brokerServiceSpecifier,
  nativeSandboxSpecifier,
  sessionStorageSpecifier,
  stateProviderSpecifier,
} from '../src/hosted-runtime-setup.js';

/** @import { EndoHost } from '@endo/daemon' */

const key = (...parts) => JSON.stringify(parts.flat());
const digest = `sha256:${'a'.repeat(64)}`;
const image = `oci:localhost/claude@${digest}`;
const listenerImageRef = `localhost/listener@sha256:${'c'.repeat(64)}`;
const profile = harden({
  uid: 1000,
  gid: 1000,
  memoryBytes: '536870912',
  cpuQuotaMicros: '200000',
  pids: 128,
  cpuPeriodMicros: 100_000,
  maxConcurrentOperations: 1,
});

// What the fake reports for a persisted formula it has no entry for: a
// generic entrypoint no service accepts.
const unsupportedSpecifier = 'file:///generic-agent.js';

/** The exec every mint-path test hands setup: a pinned image is never inspected. */
const refuseInspect = async (file, args) => {
  throw Error(`unexpected exec ${file} ${args.join(' ')}`);
};

/**
 * A fake host with `setup-host.js`'s artifacts present. Every persisted
 * formula id is `<name>-id`; the fake reports the specifier registered for
 * it, or a generic one. The secrets manager starts empty unless seeded, and a
 * managed credential bound at the host root reports the kind it was seeded
 * with.
 * @param {{ failMint?: (specifier: string, options: any) => boolean }} [options]
 */
const makeFakeHost = ({ failMint } = {}) => {
  const bindings = new Map();
  /** @type {any[]} */
  const mints = [];
  /** @type {any[]} */
  const copies = [];
  /** @type {string[][]} */
  const removed = [];
  /** @type {Array<{ name: string, description: string, base64: string }>} */
  const secrets = [];
  /** @type {Map<string, string>} A managed credential's kind, by name. */
  const credentialKinds = new Map();
  /** @type {Map<string, Record<string, string | undefined>>} */
  const environments = new Map();
  environments.set(
    'native-sandbox-id',
    harden({
      ENDO_SANDBOX_OWNER_ID: 'test-owned-native',
      ENDO_SANDBOX_RUNTIME_DIR: process.env.ENDO_SANDBOX_RUNTIME_DIR,
      ENDO_SANDBOX_GENERATED_MAX_BYTES: '4096',
      ENDO_SANDBOX_GENERATED_MAX_ENTRIES: '16',
    }),
  );
  environments.set(
    'state-provider-id',
    harden({ ENDO_CLAUDE_STATE_DIR: process.env.ENDO_CLAUDE_STATE_DIR }),
  );
  /** @type {string[][]} */
  const reads = [];
  /** @type {Map<string, string>} */
  const specifiers = new Map([
    ['state-provider-id', stateProviderSpecifier],
    ['native-sandbox-id', nativeSandboxSpecifier],
  ]);
  for (const name of ['state-provider', 'native-sandbox']) {
    bindings.set(key('claude-sandbox', name), `${name}-id`);
  }
  bindings.set(key('floot', 'controller-profile'), 'dir');
  const host = /** @type {EndoHost} */ (
    /** @type {unknown} */ ({
      async identify(...parts) {
        if (parts[0] === '@agent') return 'fake-host-id';
        return bindings.has(key(...parts)) ? `${parts.at(-1)}-id` : undefined;
      },
      async diagnostics() {
        return harden({
          getFormula: async id => {
            reads.push(['formula', id]);
            return harden({
              type: 'make-unconfined',
              properties: {
                specifier: {
                  kind: 'literal',
                  value: specifiers.get(id) ?? unsupportedSpecifier,
                },
              },
            });
          },
        });
      },
      async getFormulaEnvironment(id) {
        reads.push(['env', id]);
        return environments.get(id);
      },
      async has(...parts) {
        return bindings.has(key(...parts));
      },
      async lookup(...parts) {
        const pathParts = parts.flat();
        if (pathParts[0] === '@secrets' && pathParts[1] === 'catalog') {
          return harden({
            list: async () =>
              secrets.map(secret => ({
                petNamePaths: [['secrets', secret.name]],
              })),
          });
        }
        if (pathParts[0] === '@secrets' && pathParts[1] === 'create') {
          return harden({
            createBase64: async (name, description, base64) => {
              secrets.push({ name, description, base64 });
              bindings.set(key('secrets', name), `secret-${name}`);
            },
          });
        }
        const kind = credentialKinds.get(pathParts[0]);
        if (pathParts.length === 1 && kind !== undefined) {
          return harden({
            __getMethodNames__: async () => ['storage', 'issue', 'revoke'],
            storage: async () => 'secrets-manager',
            kind: async () => kind,
          });
        }
        throw Error(`unexpected lookup ${pathParts.join('/')}`);
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
        if (failMint && failMint(specifier, options)) {
          throw Error('mint failed');
        }
        mints.push({ worker, specifier, options });
        const result = Array.isArray(options.resultName)
          ? options.resultName
          : [options.resultName];
        bindings.set(key(...result), 'cap');
        if (/managed-credentials-module\.js$/.test(specifier)) {
          credentialKinds.set(result.at(-1), options.env.CREDENTIALS_KIND);
        }
      },
    })
  );
  /** Seed a retained managed credential and its secret. */
  const seedCredential = (name, kind) => {
    bindings.set(key(name), 'cap');
    bindings.set(key('secrets', name), `secret-${name}`);
    secrets.push({ name, description: `Anthropic ${kind}`, base64: '' });
    credentialKinds.set(name, kind);
  };
  /** Seed a retained broker service with the given persisted profile. */
  const seedBroker = config => {
    bindings.set(key('claude-sandbox', 'broker-service'), 'broker-service-id');
    specifiers.set('broker-service-id', brokerServiceSpecifier);
    environments.set(
      'broker-service-id',
      harden({ CLAUDE_BROKER_CONFIG: JSON.stringify(config) }),
    );
  };
  return {
    host,
    bindings,
    mints,
    copies,
    removed,
    environments,
    reads,
    specifiers,
    secrets,
    credentialKinds,
    seedCredential,
    seedBroker,
  };
};

const withEnv = async (t, values) => {
  const previous = new Map();
  for (const [name, value] of Object.entries(values)) {
    previous.set(name, process.env[name]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  t.teardown(() => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
};

/** @param {import('ava').ExecutionContext} t */
const baseEnv = async t => {
  const base = await realpath(
    await mkdtemp(path.join(os.tmpdir(), 'claude-setup-hosted-')),
  );
  t.teardown(() => rm(base, { recursive: true, force: true }));
  const runtime = path.join(base, 'runtime');
  await mkdir(runtime, { mode: 0o700 });
  await withEnv(t, {
    ENDO_SANDBOX_RUNTIME_DIR: runtime,
    ENDO_CLAUDE_STATE_DIR: path.join(base, 'state'),
    ENDO_CLAUDE_WORKSPACE_DIR: path.join(base, 'workspaces'),
    ENDO_CLAUDE_MCP_DIR: path.join(base, 'mcp'),
    ENDO_CLAUDE_CREDS_NAME: 'test-creds',
    CLAUDE_CREDS_NAME: undefined,
    ENDO_CLAUDE_CREDS_KIND: undefined,
    CLAUDE_CREDS_KIND: undefined,
    ENDO_CLAUDE_OAUTH_TOKEN: undefined,
    CLAUDE_CODE_OAUTH_TOKEN: undefined,
    ENDO_FLOOT_AUTH_TOKEN: 'sk-ant-api-seed',
    ANTHROPIC_API_KEY: undefined,
    FLOOT_AUTH_TOKEN: undefined,
    ENDO_FLOOT_DIR: 'floot',
    ENDO_CLAUDE_BACKEND_NAME: undefined,
    CLAUDE_BACKEND_NAME: undefined,
    ENDO_CLAUDE_SANDBOX_IMAGE: image,
    ENDO_CLAUDE_BROKER_LISTENER_IMAGE: listenerImageRef,
    ENDO_CLAUDE_BROKER_DIR: path.join(base, 'broker'),
    ENDO_CLAUDE_BROKER_OWNER_ID: 'test-broker',
    ENDO_CLAUDE_PUBLIC_INTERNET: undefined,
    ENDO_CLAUDE_ANTHROPIC_BETA: undefined,
    ENDO_CLAUDE_NATIVE_PROFILE: JSON.stringify(profile),
    NINEP_SUDO: undefined,
    NINEP_MOUNT_PROGRAM: undefined,
    NINEP_UMOUNT_PROGRAM: undefined,
    ENDO_NINEP_SUDO: undefined,
    ENDO_NINEP_MOUNT_PROGRAM: undefined,
    ENDO_NINEP_UMOUNT_PROGRAM: undefined,
  });
  return base;
};

const backendMint = mints =>
  mints.find(mint => /claude-backend-module\.js$/.test(mint.specifier));
const brokerMint = mints =>
  mints.find(mint => mint.specifier === brokerServiceSpecifier);
const credentialMint = mints =>
  mints.find(mint => /managed-credentials-module\.js$/.test(mint.specifier));

/** The broker profile a retained service reports. */
const retainedBrokerConfig = (overrides = {}) => ({
  ownerId: 'persisted-broker',
  directory: '/srv/persisted-broker',
  imageRef: `localhost/claude@${digest}`,
  imageDigest: digest,
  listenerImageRef,
  models: ['claude-sonnet-4-6'],
  credentialKind: 'apiKey',
  ...overrides,
});

test('inferCredentialKind reads the token prefix and nothing else', t => {
  t.is(inferCredentialKind('sk-ant-oat01-abc'), 'oauthToken');
  t.is(inferCredentialKind('sk-ant-api03-abc'), 'apiKey');
  t.is(inferCredentialKind('something-else'), undefined);
});

test.serial('requires setup-host.js artifacts before any mint', async t => {
  await baseEnv(t);
  const noProvider = makeFakeHost();
  noProvider.bindings.delete(key('claude-sandbox', 'state-provider'));
  await t.throwsAsync(main(noProvider.host), { message: /state-provider/ });
  const noNative = makeFakeHost();
  noNative.bindings.delete(key('claude-sandbox', 'native-sandbox'));
  await t.throwsAsync(main(noNative.host), { message: /native-sandbox/ });
  t.deepEqual(noNative.mints, []);
  const generic = makeFakeHost();
  generic.specifiers.set('native-sandbox-id', unsupportedSpecifier);
  await t.throwsAsync(main(generic.host), {
    message: /Retire the old runtime/,
  });
  t.deepEqual(generic.mints, []);
});

test.serial(
  'refuses before any mint what the backend or broker would refuse: image, listener, profile, and mount settings',
  async t => {
    const base = await baseEnv(t);
    /** @type {[Record<string, string | undefined>, RegExp][]} */
    const refused = [
      [
        { ENDO_CLAUDE_BROKER_LISTENER_IMAGE: undefined },
        /ENDO_CLAUDE_BROKER_LISTENER_IMAGE is required/,
      ],
      [
        { ENDO_CLAUDE_BROKER_LISTENER_IMAGE: 'localhost/listener:latest' },
        /ENDO_CLAUDE_BROKER_LISTENER_IMAGE must be/,
      ],
      [
        { ENDO_CLAUDE_BROKER_OWNER_ID: 'Not A Label' },
        /ENDO_CLAUDE_BROKER_OWNER_ID must match/,
      ],
      [
        { ENDO_CLAUDE_BROKER_DIR: 'relative/broker' },
        /ENDO_CLAUDE_BROKER_DIR must be a normalized absolute path/,
      ],
      [
        { ENDO_CLAUDE_SANDBOX_IMAGE: 'oci:localhost/claude@sha256:zzz' },
        /sandbox image digest is invalid/,
      ],
      [
        { ENDO_CLAUDE_SANDBOX_IMAGE: 'oci:-rm' },
        /Invalid Claude sandbox image/,
      ],
      [
        { ENDO_CLAUDE_NATIVE_PROFILE: undefined },
        /ENDO_CLAUDE_NATIVE_PROFILE is required/,
      ],
      [
        {
          ENDO_CLAUDE_NATIVE_PROFILE: JSON.stringify({
            ...profile,
            uid: 'root',
          }),
        },
        /uid: .* Must be a number/,
      ],
      [
        { ENDO_NINEP_UMOUNT_PROGRAM: 'rm -rf' },
        /"NINEP_UMOUNT_PROGRAM" must invoke "umount"/,
      ],
      [{ ENDO_NINEP_SUDO: '0' }, /"NINEP_SUDO" must be "1" when present/],
      [
        { ENDO_CLAUDE_WORKSPACE_DIR: `${path.join(base, 'workspaces')}/` },
        /ENDO_CLAUDE_WORKSPACE_DIR .*must be a normalized absolute path/,
      ],
      [
        { ENDO_CLAUDE_MCP_DIR: path.join(base, 'runtime', 'mcp') },
        /must be disjoint/,
      ],
      [
        { ENDO_CLAUDE_CREDS_KIND: 'password' },
        /credential kind must be one of/,
      ],
      [
        { ENDO_CLAUDE_ANTHROPIC_BETA: 'oauth-2025-04-20, interleaved' },
        /ENDO_CLAUDE_ANTHROPIC_BETA must be a comma-separated capability list/,
      ],
      // ...and before Podman is asked to pin an unpinned image.
      [
        {
          ENDO_CLAUDE_ANTHROPIC_BETA: 'oauth-2025-04-20, interleaved',
          ENDO_CLAUDE_SANDBOX_IMAGE: 'oci:localhost/claude:latest',
        },
        /ENDO_CLAUDE_ANTHROPIC_BETA must be a comma-separated capability list/,
      ],
      // A minted broker needs its credential kind named or inferable; a
      // secret created in Secrets with no seed here does not default to
      // `apiKey`, and a developer shell's bare CLI variable is not a seed.
      [
        { ENDO_FLOOT_AUTH_TOKEN: undefined },
        /ENDO_CLAUDE_CREDS_KIND is required when no seed token/,
      ],
      [
        {
          ENDO_FLOOT_AUTH_TOKEN: undefined,
          CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-bare',
          ANTHROPIC_API_KEY: 'sk-ant-api03-bare',
        },
        /ENDO_CLAUDE_CREDS_KIND is required when no seed token/,
      ],
      [
        { ENDO_FLOOT_AUTH_TOKEN: 'token-with-no-known-prefix' },
        /ENDO_CLAUDE_CREDS_KIND is required: the seed token's prefix/,
      ],
      [
        { ENDO_FLOOT_AUTH_TOKEN: undefined, ENDO_CLAUDE_CREDS_KIND: 'apiKey' },
        /Anthropic secret must first be/,
      ],
    ];
    for (const [values, message] of refused) {
      // eslint-disable-next-line no-await-in-loop
      await withEnv(t, values);
      const fake = makeFakeHost();
      // eslint-disable-next-line no-await-in-loop
      await t.throwsAsync(main(fake.host, { exec: refuseInspect }), {
        message,
      });
      t.deepEqual(fake.mints, [], `refused before any mint: ${message}`);
      t.deepEqual(fake.secrets, [], `refused before any secret: ${message}`);
      // Restore the base value for the next row.
      // eslint-disable-next-line no-await-in-loop
      await withEnv(t, {
        ENDO_CLAUDE_BROKER_LISTENER_IMAGE: listenerImageRef,
        ENDO_CLAUDE_BROKER_OWNER_ID: 'test-broker',
        ENDO_CLAUDE_BROKER_DIR: path.join(base, 'broker'),
        ENDO_CLAUDE_SANDBOX_IMAGE: image,
        ENDO_CLAUDE_NATIVE_PROFILE: JSON.stringify(profile),
        ENDO_NINEP_UMOUNT_PROGRAM: undefined,
        ENDO_NINEP_SUDO: undefined,
        ENDO_CLAUDE_WORKSPACE_DIR: path.join(base, 'workspaces'),
        ENDO_CLAUDE_MCP_DIR: path.join(base, 'mcp'),
        ENDO_CLAUDE_CREDS_KIND: undefined,
        ENDO_CLAUDE_ANTHROPIC_BETA: undefined,
        ENDO_FLOOT_AUTH_TOKEN: 'sk-ant-api-seed',
        CLAUDE_CODE_OAUTH_TOKEN: undefined,
        ANTHROPIC_API_KEY: undefined,
      });
    }
    await t.throwsAsync(access(path.join(base, 'workspaces')), {
      code: 'ENOENT',
    });
    await t.throwsAsync(access(path.join(base, 'broker')), {
      code: 'ENOENT',
    });
  },
);

test.serial(
  'mints the managed credential, the broker over its secret, the storage owner, and the backend, then binds Floot',
  async t => {
    const base = await baseEnv(t);
    await withEnv(t, {
      ENDO_NINEP_SUDO: '1',
      ENDO_NINEP_MOUNT_PROGRAM: 'sudo -n mount',
      ENDO_CLAUDE_PUBLIC_INTERNET: '1',
    });
    const fake = makeFakeHost();
    await main(fake.host, { exec: refuseInspect });
    t.deepEqual(
      fake.mints.map(mint => [mint.options.resultName].flat().join('/')),
      [
        'test-creds',
        'claude-sandbox/broker-service',
        'claude-sandbox/session-storage',
        'claude-sandbox/backend-next',
      ],
    );
    // The seed entered the secrets manager once; the credential caplet reads
    // it through a delegated facet and reports the inferred kind.
    t.deepEqual(fake.secrets, [
      {
        name: 'test-creds',
        description: 'Anthropic apiKey',
        base64: btoa('sk-ant-api-seed'),
      },
    ]);
    const credential = credentialMint(fake.mints);
    t.is(credential?.options.powersName, 'test-creds-secret-read');
    t.deepEqual(credential?.options.env, {
      CREDENTIALS_KIND: 'apiKey',
      CREDENTIALS_LABEL: 'Anthropic',
    });
    t.false(fake.bindings.has(key('test-creds-secret-read')));
    // The broker reads the secret through its own delegated facet and
    // persists the pinned image, the credential kind, and the catalog.
    const broker = brokerMint(fake.mints);
    t.is(broker?.options.powersName, 'test-creds.broker-read');
    t.true(
      fake.copies.some(
        ({ from, to }) =>
          key(...from) === key('secrets', 'test-creds') &&
          key(...to) === key('test-creds.broker-read'),
      ),
    );
    t.false(fake.bindings.has(key('test-creds.broker-read')));
    const config = JSON.parse(broker?.options.env.CLAUDE_BROKER_CONFIG ?? '');
    t.deepEqual(config, {
      ownerId: 'test-broker',
      directory: path.join(base, 'broker'),
      imageRef: `localhost/claude@${digest}`,
      imageDigest: digest,
      listenerImageRef,
      models: [
        'claude-haiku-4-5-20251001',
        'claude-sonnet-4-6',
        'claude-sonnet-5',
        'claude-opus-4-8',
        'claude-opus-5',
      ],
      credentialKind: 'apiKey',
      publicInternet: true,
    });
    // eslint-disable-next-line no-bitwise
    t.is((await stat(path.join(base, 'broker'))).mode & 0o777, 0o700);
    const storage = fake.mints[2];
    t.is(storage.specifier, sessionStorageSpecifier);
    t.is(storage.options.powersName, 'claude.state-provider-powers');
    t.deepEqual(storage.options.env, {
      CLAUDE_WORKSPACE_BASE_DIR: path.join(base, 'workspaces'),
      CLAUDE_MCP_DIR: path.join(base, 'mcp'),
    });
    t.false(
      fake.bindings.has(key('claude.state-provider-powers')),
      'alias removed',
    );
    const backend = backendMint(fake.mints);
    t.is(backend?.options.powersName, '@agent');
    t.deepEqual(backend?.options.env, {
      CLAUDE_WORKSPACE_BASE_DIR: path.join(base, 'workspaces'),
      CLAUDE_MCP_DIR: path.join(base, 'mcp'),
      CLAUDE_NATIVE_PROFILE: JSON.stringify(profile),
      CLAUDE_MOUNTER_ENV: JSON.stringify({
        NINEP_SUDO: '1',
        NINEP_MOUNT_PROGRAM: 'sudo -n mount',
      }),
    });
    // The backend is minted under a temporary name and swapped in.
    t.true(fake.bindings.has(key('claude-sandbox', 'backend')));
    t.false(fake.bindings.has(key('claude-sandbox', 'backend-next')));
    t.true(
      fake.copies.some(
        ({ from, to }) =>
          from.join('/') === 'claude-sandbox/backend' &&
          to.join('/') === 'floot/controller-profile/claude-backend',
      ),
    );
    // eslint-disable-next-line no-bitwise
    t.is((await stat(path.join(base, 'mcp'))).mode & 0o777, 0o700);
  },
);

test.serial(
  'a subscription token seeds an oauthToken credential and a Bearer-token broker; an unpinned image is pinned through Podman',
  async t => {
    const base = await baseEnv(t);
    const pinned = `sha256:${'b'.repeat(64)}`;
    await withEnv(t, {
      ENDO_FLOOT_AUTH_TOKEN: undefined,
      ENDO_CLAUDE_OAUTH_TOKEN: 'sk-ant-oat01-seed',
      ENDO_CLAUDE_SANDBOX_IMAGE: 'oci:localhost/claude:latest',
      ENDO_CLAUDE_ANTHROPIC_BETA: 'oauth-2025-04-20,interleaved-thinking',
    });
    const fake = makeFakeHost();
    /** @type {string[][]} */
    const inspected = [];
    await main(fake.host, {
      exec: async (file, args) => {
        inspected.push([file, ...args]);
        return { stdout: `${pinned}\n` };
      },
    });
    t.deepEqual(inspected, [
      [
        'podman',
        'image',
        'inspect',
        '--format',
        '{{.Digest}}',
        'localhost/claude:latest',
      ],
    ]);
    t.is(fake.secrets[0]?.description, 'Anthropic oauthToken');
    t.is(
      credentialMint(fake.mints)?.options.env.CREDENTIALS_KIND,
      'oauthToken',
    );
    const config = JSON.parse(
      brokerMint(fake.mints)?.options.env.CLAUDE_BROKER_CONFIG ?? '',
    );
    t.like(config, {
      // The tag is resolved AWAY: `name:tag@digest` is a reference the
      // native runtime refuses, so the pin drops the tag it was found under.
      imageRef: `localhost/claude@${pinned}`,
      imageDigest: pinned,
      credentialKind: 'oauthToken',
      anthropicBeta: 'oauth-2025-04-20,interleaved-thinking',
    });
    t.false(Object.hasOwn(config, 'publicInternet'));
    t.truthy(backendMint(fake.mints));
    await access(path.join(base, 'broker'));
  },
);

test.serial(
  'retains an existing credential, broker, and storage owner; the persisted credential kind governs',
  async t => {
    const base = await baseEnv(t);
    // Nothing names a kind and no seed is offered: the retained broker's
    // persisted kind is the credential's, and the current broker and root
    // settings are not reapplied.
    // The pinned slice image equals the retained broker's, so nothing reaches
    // Podman; an absent listener image is what a retained broker allows.
    await withEnv(t, {
      ENDO_FLOOT_AUTH_TOKEN: undefined,
      ENDO_CLAUDE_BROKER_LISTENER_IMAGE: undefined,
    });
    const fake = makeFakeHost();
    fake.seedCredential('test-creds', 'oauthToken');
    fake.seedBroker(retainedBrokerConfig({ credentialKind: 'oauthToken' }));
    fake.bindings.set(
      key('claude-sandbox', 'session-storage'),
      'session-storage-id',
    );
    fake.specifiers.set('session-storage-id', sessionStorageSpecifier);
    fake.environments.set(
      'session-storage-id',
      harden({
        CLAUDE_WORKSPACE_BASE_DIR: path.join(base, 'persisted-workspaces'),
        CLAUDE_MCP_DIR: path.join(base, 'persisted-mcp'),
      }),
    );
    await main(fake.host, { exec: refuseInspect });
    t.deepEqual(
      fake.mints.map(mint => [mint.options.resultName].flat().join('/')),
      ['claude-sandbox/backend-next'],
    );
    t.deepEqual(fake.secrets.length, 1, 'no second secret');
    t.like(backendMint(fake.mints)?.options.env, {
      CLAUDE_WORKSPACE_BASE_DIR: path.join(base, 'persisted-workspaces'),
      CLAUDE_MCP_DIR: path.join(base, 'persisted-mcp'),
    });
    t.false(
      Object.hasOwn(
        backendMint(fake.mints)?.options.env ?? {},
        'CLAUDE_MOUNTER_ENV',
      ),
      'settings are re-read on every run',
    );
    await t.throwsAsync(access(path.join(base, 'broker')), {
      code: 'ENOENT',
    });
    // A run naming the other kind is refused before any mint or secret: the
    // retained broker would keep sending the persisted header.
    await withEnv(t, { ENDO_CLAUDE_OAUTH_TOKEN: undefined });
    await withEnv(t, { ENDO_FLOOT_AUTH_TOKEN: 'sk-ant-api-other' });
    const switched = makeFakeHost();
    switched.seedCredential('test-creds', 'oauthToken');
    switched.seedBroker(retainedBrokerConfig({ credentialKind: 'oauthToken' }));
    await t.throwsAsync(main(switched.host, { exec: refuseInspect }), {
      message:
        /reads a "oauthToken" credential and cannot switch to "apiKey": remove it, then either remove the "test-creds" credential/,
    });
    t.deepEqual(switched.mints, []);
    // A retained broker whose persisted profile is unreadable refuses too.
    await withEnv(t, { ENDO_FLOOT_AUTH_TOKEN: undefined });
    const corrupt = makeFakeHost();
    corrupt.seedCredential('test-creds', 'oauthToken');
    corrupt.seedBroker({ ownerId: 'only' });
    await t.throwsAsync(main(corrupt.host, { exec: refuseInspect }), {
      message: /Invalid Claude broker configuration/,
    });
    t.deepEqual(corrupt.mints, []);
  },
);

test.serial(
  'a retained broker whose pins no longer match the configuration is refused before any mint',
  async t => {
    await baseEnv(t);
    const other = `sha256:${'e'.repeat(64)}`;
    // The operator bumped the slice image; the retained broker still pins the
    // old digest. Retaining it silently would leave every slice on the old
    // image while the unit environment claims the new one.
    await withEnv(t, {
      ENDO_CLAUDE_SANDBOX_IMAGE: `oci:localhost/claude@${other}`,
    });
    const bumped = makeFakeHost();
    bumped.seedCredential('test-creds', 'apiKey');
    bumped.seedBroker(retainedBrokerConfig());
    await t.throwsAsync(main(bumped.host, { exec: refuseInspect }), {
      message: new RegExp(
        `pins Claude sandbox image "${digest}" but the configuration now names "${other}"; a live broker cannot be re-pinned in place: remove "claude-sandbox/broker-service" when no session depends on it, then rerun setup`,
      ),
    });
    t.deepEqual(bumped.mints, [], 'refused before the credential mint');
    // A tag is resolved (read-only) to compare; matching the retained digest
    // retains the broker exactly as a pinned reference would.
    await withEnv(t, { ENDO_CLAUDE_SANDBOX_IMAGE: 'oci:localhost/claude:latest' });
    const resolved = makeFakeHost();
    resolved.seedCredential('test-creds', 'apiKey');
    resolved.seedBroker(retainedBrokerConfig());
    const inspected = [];
    await main(resolved.host, {
      exec: async (file, args) => {
        inspected.push([file, ...args]);
        return { stdout: `${digest}\n` };
      },
    });
    t.is(inspected.length, 1);
    t.deepEqual(
      resolved.mints.map(mint => [mint.options.resultName].flat().join('/')),
      ['claude-sandbox/session-storage', 'claude-sandbox/backend-next'],
      'the broker is retained, not re-minted',
    );
    // The listener image is compared the same way when the environment names
    // one.
    await withEnv(t, {
      ENDO_CLAUDE_SANDBOX_IMAGE: image,
      ENDO_CLAUDE_BROKER_LISTENER_IMAGE: `localhost/listener@${other}`,
    });
    const listener = makeFakeHost();
    listener.seedCredential('test-creds', 'apiKey');
    listener.seedBroker(retainedBrokerConfig());
    await t.throwsAsync(main(listener.host, { exec: refuseInspect }), {
      message: /runs listener image "localhost\/listener@sha256:c+" but the configuration now names "localhost\/listener@sha256:e+"/,
    });
    t.deepEqual(listener.mints, []);
  },
);

test.serial(
  'a failed backend mint leaves the live backend and Floot binding intact',
  async t => {
    await baseEnv(t);
    const fake = makeFakeHost({
      failMint: specifier => /claude-backend-module\.js$/.test(specifier),
    });
    fake.bindings.set(key('claude-sandbox', 'backend'), 'old-backend');
    fake.bindings.set(
      key('floot', 'controller-profile', 'claude-backend'),
      'old-backend',
    );
    await t.throwsAsync(main(fake.host, { exec: refuseInspect }), {
      message: /mint failed/,
    });
    t.is(fake.bindings.get(key('claude-sandbox', 'backend')), 'old-backend');
    t.is(
      fake.bindings.get(key('floot', 'controller-profile', 'claude-backend')),
      'old-backend',
    );
  },
);
