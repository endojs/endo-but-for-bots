// @ts-check
import '@endo/init';
import { createHash } from 'node:crypto';
import test from 'ava';
import { access, mkdir, mkdtemp, rm, stat, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { main } from '../setup-hosted.js';
import {
  brokerServiceSpecifier,
  sandboxSpecifier,
  sessionStorageSpecifier,
  stateProviderSpecifier,
} from '../src/hosted-runtime-setup.js';

/** @import { EndoHost } from '@endo/daemon' */

const key = (...parts) => JSON.stringify(parts.flat());

/** @param {{ failMint?: (specifier: string, options: any) => boolean, factorySpecifier?: string }} [options] */
const makeFakeHost = ({
  failMint,
  factorySpecifier = sandboxSpecifier,
} = {}) => {
  const bindings = new Map();
  const mints = [];
  const copies = [];
  const removed = [];
  /** @type {Map<string, Record<string, string | undefined>>} */
  const environments = new Map();
  environments.set(
    'sandbox-factory-id',
    harden({
      ENDO_SANDBOX_OWNER_ID: 'test-owned',
      ENDO_SANDBOX_RUNTIME_DIR: process.env.ENDO_SANDBOX_RUNTIME_DIR,
      ENDO_SANDBOX_GENERATED_MAX_BYTES: '4096',
      ENDO_SANDBOX_GENERATED_MAX_ENTRIES: '16',
    }),
  );
  environments.set(
    'state-provider-id',
    harden({ ENDO_OPENCODE_STATE_DIR: process.env.ENDO_OPENCODE_STATE_DIR }),
  );
  const reads = [];
  /** @type {Map<string, string>} Specifier reported for a persisted formula id. */
  const specifiers = new Map([['state-provider-id', stateProviderSpecifier]]);
  return {
    bindings,
    mints,
    copies,
    removed,
    environments,
    reads,
    specifiers,
    host: /** @type {EndoHost} */ (
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
                    value: specifiers.get(id) ?? factorySpecifier,
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
        async lookup(pathParts) {
          if (pathParts[1] === 'catalog') {
            return harden({ list: async () => [] });
          }
          return harden({ createBase64: async () => {} });
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
        },
      })
    ),
  };
};

const makeTmp = async (t, prefix) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.teardown(() => rm(dir, { recursive: true, force: true }));
  return dir;
};

const withEnv = async (t, values) => {
  const previous = new Map();
  for (const [name, value] of Object.entries(values)) {
    previous.set(name, process.env[name]);
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
  t.teardown(() => {
    for (const [name, value] of previous) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  });
};

const preflightHost = () => {
  const fake = makeFakeHost();
  for (const name of ['sandbox-factory', 'state-provider', 'native-sandbox']) {
    fake.bindings.set(key('opencode-sandbox', name), 'cap');
  }
  fake.bindings.set(key('floot', 'controller-profile'), 'dir');
  return fake;
};

const baseEnv = async t => {
  const base = await makeTmp(t, 'setup-hosted-');
  const runtime = path.join(base, 'runtime');
  await mkdir(runtime, { mode: 0o700 });
  await withEnv(t, {
    ENDO_SANDBOX_RUNTIME_DIR: runtime,
    ENDO_OPENCODE_STATE_DIR: path.join(base, 'state'),
    ENDO_OPENCODE_WORKSPACE_DIR: path.join(base, 'workspaces'),
    ENDO_OPENCODE_MCP_DIR: path.join(base, 'mcp'),
    ENDO_OPENCODE_CREDS_NAME: 'test-auth',
    ENDO_OPENROUTER_API_KEY: 'seed-token',
    ENDO_FLOOT_DIR: 'floot',
    // Daemon-owned sessions require the broker and the resource profile.
    ENDO_OPENCODE_BROKER_LISTENER_IMAGE: `localhost/listener@sha256:${'c'.repeat(64)}`,
    ENDO_OPENCODE_BROKER_DIR: path.join(base, 'broker'),
    ENDO_OPENCODE_BROKER_OWNER_ID: 'test-broker',
    ENDO_OPENCODE_SANDBOX_IMAGE: `oci:localhost/opencode@sha256:${'a'.repeat(64)}`,
    ENDO_OPENCODE_NATIVE_PROFILE: JSON.stringify({
      uid: 1000,
      gid: 1000,
      memoryBytes: '536870912',
      cpuQuotaMicros: '200000',
      pids: 128,
      cpuPeriodMicros: 100_000,
      maxConcurrentOperations: 1,
    }),
  });
  return base;
};

test.serial('requires setup-host.js artifacts', async t => {
  await baseEnv(t);
  const noFactory = makeFakeHost();
  await t.throwsAsync(main(noFactory.host), { message: /sandbox-factory/ });

  const noProvider = makeFakeHost();
  noProvider.bindings.set(key('opencode-sandbox', 'sandbox-factory'), 'cap');
  await t.throwsAsync(main(noProvider.host), { message: /state-provider/ });

  const noNative = makeFakeHost();
  noNative.bindings.set(key('opencode-sandbox', 'sandbox-factory'), 'cap');
  noNative.bindings.set(key('opencode-sandbox', 'state-provider'), 'cap');
  await t.throwsAsync(main(noNative.host), { message: /native-sandbox/ });
  t.is(noNative.mints.length, 0, 'no mint precedes the preflight failures');
});

test.serial(
  'standalone hosted setup refuses a generic factory before any mutation',
  async t => {
    await baseEnv(t);
    const fake = makeFakeHost({
      factorySpecifier: new URL('../../sandbox/src/agent.js', import.meta.url)
        .href,
    });
    for (const name of [
      'sandbox-factory',
      'state-provider',
      'native-sandbox',
    ]) {
      fake.bindings.set(key('opencode-sandbox', name), 'cap');
    }
    await t.throwsAsync(main(fake.host), { message: /Retire the old runtime/ });
    t.deepEqual(fake.mints, []);
    t.deepEqual(fake.removed, []);
    t.deepEqual(fake.copies, []);
  },
);

test.serial(
  'standalone hosted setup refuses guest storage inside the runtime parent',
  async t => {
    const base = await baseEnv(t);
    await withEnv(t, {
      ENDO_OPENCODE_MCP_DIR: path.join(base, 'runtime', 'mcp'),
    });
    const fake = preflightHost();
    await t.throwsAsync(main(fake.host), { message: /must be disjoint/ });
    t.deepEqual(fake.mints, []);
  },
);

test.serial(
  'hosted setup validates retained runtime and state roots rather than current env',
  async t => {
    const base = await baseEnv(t);
    const fake = preflightHost();
    await withEnv(t, {
      ENDO_SANDBOX_RUNTIME_DIR: path.join(base, 'ignored-runtime'),
      ENDO_OPENCODE_STATE_DIR: path.join(base, 'ignored-state'),
      ENDO_OPENCODE_WORKSPACE_DIR: path.join(
        base,
        'runtime',
        'guest-workspaces',
      ),
    });
    await t.throwsAsync(main(fake.host), { message: /must be disjoint/ });
    t.deepEqual(fake.mints, []);
    await withEnv(t, {
      ENDO_OPENCODE_WORKSPACE_DIR: path.join(base, 'workspaces'),
    });
    fake.environments.set(
      'state-provider-id',
      harden({ ENDO_OPENCODE_STATE_DIR: base }),
    );
    await t.throwsAsync(main(fake.host), { message: /must be disjoint/ });
    t.deepEqual(fake.mints, []);
  },
);

test.serial(
  'hosted setup needs no replacement runtime or state env for retained formulas',
  async t => {
    await baseEnv(t);
    const fake = preflightHost();
    await withEnv(t, {
      ENDO_SANDBOX_RUNTIME_DIR: undefined,
      ENDO_OPENCODE_STATE_DIR: undefined,
    });
    await main(fake.host);
    t.is(fake.mints.length, 4, 'credential, broker, session storage, backend');
    t.deepEqual(fake.reads, [
      ['formula', 'sandbox-factory-id'],
      ['env', 'sandbox-factory-id'],
      ['formula', 'state-provider-id'],
      ['env', 'state-provider-id'],
    ]);
  },
);

test.serial(
  'mints the backend under a temp name and rebinds the Floot profile',
  async t => {
    await baseEnv(t);
    const { host, bindings, mints, copies, removed } = preflightHost();
    await main(host);

    t.is(mints.length, 4, 'credential + broker + session storage + backend');
    t.regex(mints[0].specifier, /managed-credentials-module\.js$/);
    t.is(mints[1].specifier, brokerServiceSpecifier);
    t.is(mints[2].specifier, sessionStorageSpecifier);
    t.regex(mints[3].specifier, /opencode-backend-module\.js$/);
    t.deepEqual(mints[3].options.resultName, [
      'opencode-sandbox',
      'backend-next',
    ]);
    t.true(
      bindings.has(key('opencode-sandbox', 'backend')),
      'backend is live under its final name',
    );
    t.false(
      bindings.has(key('opencode-sandbox', 'backend-next')),
      'the temporary mint is removed after the swap',
    );
    t.true(
      bindings.has(key('floot', 'controller-profile', 'opencode-backend')),
      'the factory facet is bound into the Floot profile',
    );
    t.deepEqual(copies.at(-1), {
      from: ['opencode-sandbox', 'backend'],
      to: ['floot', 'controller-profile', 'opencode-backend'],
    });
    t.deepEqual(removed.at(-1), ['opencode-sandbox', 'backend-next']);
  },
);

test.serial(
  'mints the session storage owner over the state provider with the persisted roots',
  async t => {
    const base = await baseEnv(t);
    const { host, bindings, mints, copies, removed } = preflightHost();
    await main(host);
    const storage = mints.find(
      mint => mint.specifier === sessionStorageSpecifier,
    );
    t.truthy(storage);
    t.deepEqual(storage?.options.resultName, [
      'opencode-sandbox',
      'session-storage',
    ]);
    t.is(storage?.options.powersName, 'opencode.state-provider-powers');
    t.deepEqual(storage?.options.env, {
      OPENCODE_WORKSPACE_BASE_DIR: path.join(base, 'workspaces'),
      OPENCODE_MCP_DIR: path.join(base, 'mcp'),
    });
    t.true(
      copies.some(
        ({ from, to }) =>
          key(...from) === key('opencode-sandbox', 'state-provider') &&
          key(...to) === key('opencode.state-provider-powers'),
      ),
      'the powers alias is copied from the state provider',
    );
    t.true(
      removed.some(
        parts => key(...parts) === key('opencode.state-provider-powers'),
      ),
    );
    t.false(bindings.has(key('opencode.state-provider-powers')));
    t.true(mints.some(mint => mint.specifier === brokerServiceSpecifier));
  },
);

test.serial(
  'refuses to mint the backend without the broker image or the profile',
  async t => {
    const base = await baseEnv(t);
    await withEnv(t, { ENDO_OPENCODE_BROKER_LISTENER_IMAGE: undefined });
    const noBroker = preflightHost();
    await t.throwsAsync(main(noBroker.host), {
      message: /ENDO_OPENCODE_BROKER_LISTENER_IMAGE is required/,
    });
    t.deepEqual(noBroker.mints, [], 'refused before any mint');
    // The workspace root itself is absent: the refusal precedes the mkdir
    // that would otherwise create it after the credential mint.
    await t.throwsAsync(
      access(path.join(base, 'workspaces')),
      { code: 'ENOENT' },
      'refused before any directory creation',
    );
    await baseEnv(t);
    await withEnv(t, { ENDO_OPENCODE_NATIVE_PROFILE: undefined });
    const noProfile = preflightHost();
    await t.throwsAsync(main(noProfile.host), {
      message: /ENDO_OPENCODE_NATIVE_PROFILE is required/,
    });
    t.deepEqual(noProfile.mints, []);
  },
);

test.serial(
  'mints the broker service from the managed credential when the listener image is configured',
  async t => {
    const base = await baseEnv(t);
    const digest = `sha256:${'b'.repeat(64)}`;
    const listenerImageRef = `localhost/listener@sha256:${'c'.repeat(64)}`;
    await withEnv(t, {
      ENDO_OPENCODE_BROKER_LISTENER_IMAGE: listenerImageRef,
      ENDO_OPENCODE_BROKER_DIR: path.join(base, 'broker'),
      ENDO_OPENCODE_BROKER_OWNER_ID: 'operator-broker',
      ENDO_OPENCODE_SANDBOX_IMAGE: 'oci:localhost/opencode:latest',
      ENDO_OPENCODE_PUBLIC_INTERNET: '1',
    });
    const { host, bindings, mints, copies, removed } = preflightHost();
    /** @type {string[][]} */
    const inspected = [];
    await main(host, {
      exec: async (file, args) => {
        inspected.push([file, ...args]);
        return { stdout: `${digest}\n` };
      },
    });
    t.deepEqual(inspected, [
      [
        'podman',
        'image',
        'inspect',
        '--format',
        '{{.Digest}}',
        'localhost/opencode:latest',
      ],
    ]);
    const broker = mints.find(
      mint => mint.specifier === brokerServiceSpecifier,
    );
    t.truthy(broker);
    t.deepEqual(broker?.options.resultName, [
      'opencode-sandbox',
      'broker-service',
    ]);
    t.is(broker?.options.powersName, 'test-auth.broker-read');
    /** @type {{ models: string[] }} */
    const config = JSON.parse(broker?.options.env.OPENCODE_BROKER_CONFIG ?? '');
    t.like(config, {
      ownerId: 'operator-broker',
      directory: path.join(base, 'broker'),
      imageRef: `localhost/opencode:latest@${digest}`,
      imageDigest: digest,
      listenerImageRef,
      publicInternet: true,
    });
    t.true(Array.isArray(config.models) && config.models.length > 0);
    t.true(config.models.every(model => !model.startsWith('openrouter/')));
    // eslint-disable-next-line no-bitwise
    t.is((await stat(path.join(base, 'broker'))).mode & 0o777, 0o700);
    t.true(
      copies.some(
        ({ from, to }) =>
          key(...from) === key('secrets', 'test-auth') &&
          key(...to) === key('test-auth.broker-read'),
      ),
    );
    t.true(
      removed.some(parts => key(...parts) === key('test-auth.broker-read')),
    );
    t.false(bindings.has(key('test-auth.broker-read')));
    t.deepEqual(
      mints.map(mint => [mint.options.resultName].flat().at(-1)),
      ['test-auth', 'broker-service', 'session-storage', 'backend-next'],
    );
  },
);

test.serial(
  'retains an existing broker service and session storage without re-minting',
  async t => {
    const base = await baseEnv(t);
    await withEnv(t, {
      ENDO_OPENCODE_BROKER_LISTENER_IMAGE: `localhost/listener@sha256:${'c'.repeat(64)}`,
    });
    const fake = preflightHost();
    for (const name of ['broker-service', 'session-storage']) {
      fake.bindings.set(key('opencode-sandbox', name), 'cap');
    }
    fake.specifiers.set('broker-service-id', brokerServiceSpecifier);
    fake.specifiers.set('session-storage-id', sessionStorageSpecifier);
    const digest = `sha256:${'b'.repeat(64)}`;
    const brokerEnv = harden({
      OPENCODE_BROKER_CONFIG: JSON.stringify({
        ownerId: 'persisted-broker',
        directory: '/persisted/broker',
        imageRef: `localhost/opencode@${digest}`,
        imageDigest: digest,
        listenerImageRef: `localhost/listener@sha256:${'d'.repeat(64)}`,
        models: ['anthropic/claude-sonnet-4'],
      }),
    });
    fake.environments.set('broker-service-id', brokerEnv);
    // The retained owner's roots are effective; the backend is re-minted with
    // them, not with the current environment's roots, so its new sessions stay
    // where this owner can remove them.
    const persistedRoots = harden({
      OPENCODE_WORKSPACE_BASE_DIR: path.join(base, 'persisted-workspaces'),
      OPENCODE_MCP_DIR: path.join(base, 'persisted-mcp'),
    });
    fake.environments.set('session-storage-id', persistedRoots);
    await main(fake.host);
    t.deepEqual(
      fake.mints.map(mint => [mint.options.resultName].flat().at(-1)),
      ['test-auth', 'backend-next'],
    );
    t.true(fake.reads.some(([, id]) => id === 'broker-service-id'));
    t.true(fake.reads.some(([, id]) => id === 'session-storage-id'));
    const backend = fake.mints.find(mint =>
      /opencode-backend-module\.js$/.test(mint.specifier),
    );
    t.deepEqual(Object.keys(backend?.options.env ?? {}).sort(), [
      'OPENCODE_MCP_DIR',
      'OPENCODE_NATIVE_PROFILE',
      'OPENCODE_WORKSPACE_BASE_DIR',
    ]);
    t.like(backend?.options.env, persistedRoots);
    await stat(persistedRoots.OPENCODE_MCP_DIR);
    // A retained broker under an unsupported entrypoint is refused before the
    // credential mint or any directory creation, with no storage owner to
    // refuse first.
    const brokerOnly = preflightHost();
    brokerOnly.bindings.set(key('opencode-sandbox', 'broker-service'), 'cap');
    await t.throwsAsync(main(brokerOnly.host), {
      message: /unsupported entrypoint/,
    });
    t.deepEqual(brokerOnly.mints, [], 'the broker is verified before any mint');
    t.true(brokerOnly.reads.some(([, id]) => id === 'broker-service-id'));
    // With no storage owner the environment's roots apply; the retained run
    // above created only the persisted ones.
    await t.throwsAsync(access(path.join(base, 'workspaces')), {
      code: 'ENOENT',
    });
    // A retained service under an unsupported entrypoint is refused, not
    // replaced. The broker is retained here too, so nothing reaches Podman.
    const unsupported = preflightHost();
    for (const name of ['broker-service', 'session-storage']) {
      unsupported.bindings.set(key('opencode-sandbox', name), 'cap');
    }
    unsupported.specifiers.set('broker-service-id', brokerServiceSpecifier);
    unsupported.environments.set('broker-service-id', brokerEnv);
    await t.throwsAsync(main(unsupported.host), {
      message: /unsupported entrypoint/,
    });
    t.deepEqual(
      unsupported.mints,
      [],
      'the storage owner is read for its roots before any mint',
    );
  },
);

test.serial(
  'derives the broker owner label from the host identity when none is configured',
  async t => {
    const base = await baseEnv(t);
    await withEnv(t, {
      ENDO_OPENCODE_BROKER_LISTENER_IMAGE: `localhost/listener@sha256:${'c'.repeat(64)}`,
      ENDO_OPENCODE_BROKER_DIR: path.join(base, 'broker'),
      ENDO_OPENCODE_BROKER_OWNER_ID: undefined,
      ENDO_OPENCODE_SANDBOX_IMAGE: `oci:localhost/opencode@sha256:${'b'.repeat(64)}`,
    });
    const { host, mints } = preflightHost();
    await main(host);
    const broker = mints.find(
      mint => mint.specifier === brokerServiceSpecifier,
    );
    const expected = `opencode-${createHash('sha256').update('fake-host-id').digest('hex').slice(0, 48)}`;
    t.like(JSON.parse(broker?.options.env.OPENCODE_BROKER_CONFIG ?? ''), {
      ownerId: expected,
    });
  },
);

test.serial(
  'refuses before any mint what a minted owner could not construct',
  async t => {
    const base = await baseEnv(t);
    // A trailing separator passes placement but the storage owner's own root
    // check refuses it; the daemon would keep the unconstructible formula.
    await withEnv(t, {
      ENDO_OPENCODE_WORKSPACE_DIR: `${path.join(base, 'workspaces')}/`,
    });
    const slash = preflightHost();
    await t.throwsAsync(main(slash.host), {
      message:
        /ENDO_OPENCODE_WORKSPACE_DIR .*must be a normalized absolute path/,
    });
    t.deepEqual(slash.mints, []);
    await withEnv(t, {
      ENDO_OPENCODE_WORKSPACE_DIR: path.join(base, 'workspaces'),
      ENDO_OPENCODE_BROKER_LISTENER_IMAGE: `localhost/listener@sha256:${'c'.repeat(64)}`,
      ENDO_OPENCODE_BROKER_DIR: 'relative-broker',
      ENDO_OPENCODE_BROKER_OWNER_ID: 'Operator',
    });
    const relativeDir = preflightHost();
    await t.throwsAsync(main(relativeDir.host), {
      message: /ENDO_OPENCODE_BROKER_DIR must be a normalized absolute path/,
    });
    t.deepEqual(relativeDir.mints, [], 'refused before any mint');
    await t.throwsAsync(access(path.join(base, 'workspaces')), {
      code: 'ENOENT',
    });
    await withEnv(t, { ENDO_OPENCODE_BROKER_DIR: path.join(base, 'broker') });
    const badOwner = preflightHost();
    await t.throwsAsync(main(badOwner.host), {
      message: /ENDO_OPENCODE_BROKER_OWNER_ID must match/,
    });
    t.deepEqual(badOwner.mints, [], 'refused before any mint');
    // A mutable listener tag passes the persisted config shape but the broker
    // kit refuses it at construction; refuse it before Podman is even asked.
    await withEnv(t, {
      ENDO_OPENCODE_BROKER_OWNER_ID: 'operator-broker',
      ENDO_OPENCODE_BROKER_LISTENER_IMAGE: 'localhost/listener:latest',
    });
    const mutableListener = preflightHost();
    /** @type {string[][]} */
    const inspected = [];
    await t.throwsAsync(
      main(mutableListener.host, {
        exec: async (file, args) => {
          inspected.push([file, ...args]);
          return { stdout: `sha256:${'b'.repeat(64)}\n` };
        },
      }),
      { message: /ENDO_OPENCODE_BROKER_LISTENER_IMAGE must be/ },
    );
    t.deepEqual(inspected, [], 'refused before resolving the slice image');
    t.deepEqual(mutableListener.mints, [], 'refused before any mint');
    // A malformed pinned digest (the broker kit's own check) or an option-like
    // name (which Podman would misparse) is refused before any mint, without
    // asking Podman.
    await withEnv(t, {
      ENDO_OPENCODE_BROKER_LISTENER_IMAGE: `localhost/listener@sha256:${'c'.repeat(64)}`,
      ENDO_OPENCODE_SANDBOX_IMAGE: 'oci:localhost/opencode@sha256:zzz',
    });
    const badDigest = preflightHost();
    await t.throwsAsync(
      main(badDigest.host, {
        exec: async (file, args) => {
          inspected.push([file, ...args]);
          return { stdout: `sha256:${'b'.repeat(64)}\n` };
        },
      }),
      { message: /sandbox image digest is invalid/ },
    );
    t.deepEqual(inspected, [], 'refused before resolving the slice image');
    t.deepEqual(badDigest.mints, [], 'refused before any mint');
    await t.throwsAsync(access(path.join(base, 'workspaces')), {
      code: 'ENOENT',
    });
    await withEnv(t, { ENDO_OPENCODE_SANDBOX_IMAGE: 'oci:-rm' });
    const optionLike = preflightHost();
    await t.throwsAsync(
      main(optionLike.host, {
        exec: async (file, args) => {
          inspected.push([file, ...args]);
          return { stdout: `sha256:${'b'.repeat(64)}\n` };
        },
      }),
      { message: /Invalid OpenCode sandbox image/ },
    );
    t.deepEqual(inspected, [], 'refused before resolving the slice image');
    t.deepEqual(optionLike.mints, [], 'refused before any mint');
  },
);

test.serial(
  'validates the operator native profile before any mint and records it for the backend',
  async t => {
    await baseEnv(t);
    const text = JSON.stringify({
      uid: 1000,
      gid: 1000,
      memoryBytes: '536870912',
      cpuQuotaMicros: '200000',
      pids: 128,
      cpuPeriodMicros: 100_000,
      maxConcurrentOperations: 2,
    });
    await withEnv(t, { ENDO_OPENCODE_NATIVE_PROFILE: text });
    const valid = preflightHost();
    await main(valid.host);
    const backend = valid.mints.find(mint =>
      /opencode-backend-module\.js$/.test(mint.specifier),
    );
    t.is(backend?.options.env.OPENCODE_NATIVE_PROFILE, text);
    await withEnv(t, {
      ENDO_OPENCODE_NATIVE_PROFILE: JSON.stringify({ uid: 'root' }),
    });
    const invalid = preflightHost();
    await t.throwsAsync(main(invalid.host), {
      message: /decimal digit strings/,
    });
    t.deepEqual(invalid.mints, []);
  },
);

test.serial('ignores bare OPENCODE_* variables the daemon strips', async t => {
  await baseEnv(t);
  await withEnv(t, {
    OPENCODE_BACKEND_NAME: 'hijacked',
    OPENCODE_CLIENT_NAME: 'hijacked-client',
    FLOOT_AUTH_SECRET_NAME: 'hijacked-secret',
  });
  const { host, bindings } = preflightHost();
  await main(host);

  t.true(bindings.has(key('test-auth')), 'ENDO_ creds name wins');
  t.false(bindings.has(key('hijacked-secret')));
  t.true(
    bindings.has(key('floot', 'controller-profile', 'opencode-backend')),
    'the backend stays at its conventional name',
  );
  t.false(bindings.has(key('hijacked')));
});

test.serial(
  'does not derive the credential from Floot provider variables',
  async t => {
    await baseEnv(t);
    await withEnv(t, {
      ENDO_OPENCODE_CREDS_NAME: undefined,
      ENDO_FLOOT_AUTH_SECRET_NAME: 'floot-auth',
      FLOOT_AUTH_SECRET_NAME: 'floot-auth',
    });
    const { host, bindings } = preflightHost();
    await main(host);
    t.true(
      bindings.has(key('openrouter-auth')),
      'defaults to the documented OpenRouter secret name',
    );
    t.false(
      bindings.has(key('floot-auth')),
      'never wraps a possibly non-OpenRouter provider secret',
    );
  },
);

test.serial(
  'a failed replacement mint leaves the live backend and Floot binding intact',
  async t => {
    await baseEnv(t);
    const failing = makeFakeHost({
      failMint: specifier => /opencode-backend-module\.js$/.test(specifier),
    });
    failing.bindings.set(
      key('floot', 'controller-profile', 'opencode-backend'),
      'old-backend',
    );
    for (const name of [
      'sandbox-factory',
      'state-provider',
      'native-sandbox',
    ]) {
      failing.bindings.set(key('opencode-sandbox', name), 'cap');
    }
    failing.bindings.set(key('floot', 'controller-profile'), 'dir');
    failing.bindings.set(key('opencode-sandbox', 'backend'), 'old-backend');
    await t.throwsAsync(main(failing.host), { message: /mint failed/ });
    t.is(
      failing.bindings.get(key('opencode-sandbox', 'backend')),
      'old-backend',
      'the old backend is untouched',
    );
    t.is(
      failing.bindings.get(
        key('floot', 'controller-profile', 'opencode-backend'),
      ),
      'old-backend',
      'Floot still resolves the old backend',
    );
  },
);

test.serial(
  'rebinds the profile in place over an existing binding',
  async t => {
    await baseEnv(t);
    const fake = preflightHost();
    fake.bindings.set(
      key('floot', 'controller-profile', 'opencode-backend'),
      'stale',
    );
    await main(fake.host);
    t.is(
      fake.bindings.get(key('floot', 'controller-profile', 'opencode-backend')),
      'cap',
      'copy overwrote the stale binding',
    );
    t.false(
      fake.removed.some(
        parts =>
          key(...parts) ===
          key('floot', 'controller-profile', 'opencode-backend'),
      ),
      'no remove-then-copy window for the profile binding',
    );
  },
);

test.serial('rejects a symlinked MCP base directory', async t => {
  const base = await baseEnv(t);
  const target = path.join(base, 'mcp-target');
  const link = path.join(base, 'mcp-link');
  await mkdir(target, { mode: 0o700 });
  await symlink(target, link);
  await withEnv(t, { ENDO_OPENCODE_MCP_DIR: link });
  const { host, mints } = preflightHost();
  await t.throwsAsync(main(host), { message: /must not be a symlink/ });
  t.is(mints.length, 1, 'the credential mint preceded the MCP check');
});
