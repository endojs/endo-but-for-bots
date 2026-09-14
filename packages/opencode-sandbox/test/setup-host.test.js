// @ts-check
import '@endo/init';
import test from 'ava';
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { main } from '../setup-host.js';
import {
  nativeSandboxSpecifier,
  sandboxSpecifier,
  stateProviderSpecifier,
} from '../src/hosted-runtime-setup.js';

/** @import { EndoHost } from '@endo/daemon' */

const key = (...parts) => JSON.stringify(parts.flat());

const makeFakeHost = () => {
  const bindings = new Map();
  const mints = [];
  const formulas = new Map();
  const environments = new Map();
  const reads = [];
  /** @type {Array<{ value: unknown, name: string }>} */
  const stored = [];
  /** @type {string[][]} */
  const removed = [];
  return {
    bindings,
    mints,
    formulas,
    environments,
    reads,
    stored,
    removed,
    host: /** @type {EndoHost} */ (
      /** @type {unknown} */ ({
        async has(...parts) {
          return bindings.has(key(...parts));
        },
        async makeDirectory(...parts) {
          bindings.set(key(...parts), 'dir');
        },
        async storeValue(value, name) {
          stored.push({ value, name });
          bindings.set(key(name), `stored-${stored.length}`);
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
          const id = `formula-${mints.length}`;
          environments.set(id, harden({ ...options.env }));
          bindings.set(key(...result), id);
          formulas.set(
            id,
            harden({
              type: 'make-unconfined',
              properties: { specifier: { kind: 'literal', value: specifier } },
            }),
          );
        },
        async identify(...parts) {
          return parts[0] === '@agent'
            ? 'fake-host-id'
            : bindings.get(key(...parts));
        },
        async diagnostics() {
          return harden({
            getFormula: async id => {
              reads.push(['formula', id]);
              return formulas.get(id);
            },
          });
        },
        async getFormulaEnvironment(id) {
          reads.push(['env', id]);
          return environments.get(id);
        },
      })
    ),
  };
};

const seedFormula = (fake, name, specifier, env) => {
  const id = `persisted-${name}`;
  fake.bindings.set(key('opencode-sandbox', name), id);
  fake.formulas.set(
    id,
    harden({
      type: 'make-unconfined',
      properties: { specifier: { kind: 'literal', value: specifier } },
    }),
  );
  fake.environments.set(id, harden({ ...env }));
  return id;
};

const runtimeEnv = directory =>
  harden({
    ENDO_SANDBOX_RUNTIME_DIR: directory,
    ENDO_SANDBOX_OWNER_ID: 'persisted-owner',
    ENDO_SANDBOX_GENERATED_MAX_BYTES: '4096',
    ENDO_SANDBOX_GENERATED_MAX_ENTRIES: '16',
  });

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

const withStateDir = async (t, value) => {
  const previous = process.env.ENDO_OPENCODE_STATE_DIR;
  if (value === undefined) {
    delete process.env.ENDO_OPENCODE_STATE_DIR;
  } else {
    process.env.ENDO_OPENCODE_STATE_DIR = value;
  }
  t.teardown(() => {
    if (previous === undefined) {
      delete process.env.ENDO_OPENCODE_STATE_DIR;
    } else {
      process.env.ENDO_OPENCODE_STATE_DIR = previous;
    }
  });
};

const makeTmp = async (t, prefix) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.teardown(() => rm(dir, { recursive: true, force: true }));
  return dir;
};

const withRuntime = async t => {
  const tmp = await makeTmp(t, 'setup-host-runtime-');
  const runtimeDir = path.join(tmp, 'runtime');
  await mkdir(runtimeDir, { mode: 0o700 });
  await withEnv(t, {
    ENDO_OPENCODE_SANDBOX_OWNER_ID: undefined,
    ENDO_SANDBOX_RUNTIME_DIR: runtimeDir,
    ENDO_SANDBOX_GENERATED_MAX_BYTES: '9007199254740993',
    ENDO_SANDBOX_GENERATED_MAX_ENTRIES: '16',
    ENDO_OPENCODE_STATE_DIR: path.join(tmp, 'state'),
    ENDO_OPENCODE_WORKSPACE_DIR: path.join(tmp, 'workspaces'),
    ENDO_OPENCODE_MCP_DIR: path.join(tmp, 'mcp'),
  });
  return { runtimeDir, tmp };
};

test.serial('mints the factory, mounter, and state provider', async t => {
  const { runtimeDir } = await withRuntime(t);
  const tmp = await makeTmp(t, 'setup-host-state-');
  const stateDir = path.join(tmp, 'state');
  await withStateDir(t, stateDir);
  const { host, bindings, mints, stored, removed } = makeFakeHost();
  await main(host);

  t.deepEqual(
    mints.map(mint => mint.options.resultName),
    [
      ['opencode-sandbox', 'sandbox-factory'],
      ['opencode-sandbox', 'native-sandbox'],
      ['opencode-sandbox', 'fs-mounter'],
      ['opencode-sandbox', 'state-provider'],
    ],
  );
  t.true(bindings.has(key('opencode-sandbox', 'state-provider')));
  t.is(
    mints[3].options.env.ENDO_OPENCODE_STATE_DIR,
    stateDir,
    'the provider is given the validated state root',
  );
  // The native service is constructed over a stored literal null, never a
  // host or denied-method capability, in its own private runtime directory
  // under the validated one and under a derived owner label.
  t.is(mints[1].specifier, nativeSandboxSpecifier);
  t.is(mints[1].options.powersName, 'opencode.null-powers');
  t.deepEqual(stored, [{ value: null, name: 'opencode.null-powers' }]);
  t.true(removed.some(parts => key(...parts) === key('opencode.null-powers')));
  t.false(bindings.has(key('opencode.null-powers')), 'alias removed');
  const nativeDir = path.join(await realpath(runtimeDir), 'native');
  // eslint-disable-next-line no-bitwise
  t.is((await stat(nativeDir)).mode & 0o777, 0o700);
  t.deepEqual(mints[1].options.env, {
    ENDO_SANDBOX_RUNTIME_DIR: nativeDir,
    ENDO_SANDBOX_OWNER_ID: `${mints[0].options.env.ENDO_SANDBOX_OWNER_ID}-native`,
    ENDO_SANDBOX_GENERATED_MAX_BYTES: '9007199254740993',
    ENDO_SANDBOX_GENERATED_MAX_ENTRIES: '16',
  });
  t.regex(
    mints[0].options.env.ENDO_SANDBOX_OWNER_ID,
    /^opencode-[0-9a-f]{64}$/,
  );
  t.is(mints[0].specifier, sandboxSpecifier);
  t.deepEqual(mints[0].options.env, {
    ENDO_SANDBOX_OWNER_ID: mints[0].options.env.ENDO_SANDBOX_OWNER_ID,
    ENDO_SANDBOX_RUNTIME_DIR: await realpath(runtimeDir),
    ENDO_SANDBOX_GENERATED_MAX_BYTES: '9007199254740993',
    ENDO_SANDBOX_GENERATED_MAX_ENTRIES: '16',
  });
});

test.serial(
  'runtime configuration fails before provisioning mutations',
  async t => {
    await withRuntime(t);
    for (const values of [
      { ENDO_SANDBOX_RUNTIME_DIR: undefined },
      { ENDO_SANDBOX_GENERATED_MAX_BYTES: undefined },
      { ENDO_SANDBOX_GENERATED_MAX_ENTRIES: undefined },
      { ENDO_SANDBOX_GENERATED_MAX_BYTES: '1e3' },
      { ENDO_SANDBOX_GENERATED_MAX_ENTRIES: '0' },
      { ENDO_OPENCODE_SANDBOX_OWNER_ID: '../escape' },
    ]) {
      const original = { ...process.env };
      for (const [name, value] of Object.entries(values)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      const { host, mints, bindings } = makeFakeHost();
      // eslint-disable-next-line no-await-in-loop
      await t.throwsAsync(main(host));
      t.is(mints.length, 0);
      t.is(bindings.size, 0);
      for (const name of Object.keys(values)) {
        if (original[name] === undefined) delete process.env[name];
        else process.env[name] = original[name];
      }
    }
  },
);

test.serial(
  'runtime directory is private and disjoint from guest storage including symlink aliases',
  async t => {
    const { runtimeDir: runtime } = await withRuntime(t);
    await chmod(runtime, 0o755);
    await t.throwsAsync(main(makeFakeHost().host), {
      message: /must be private/,
    });
    await chmod(runtime, 0o700);
    const alias = `${runtime}-alias`;
    await symlink(runtime, alias);
    await withEnv(t, {
      ENDO_OPENCODE_WORKSPACE_DIR: path.join(alias, 'future-workspace'),
    });
    const { host, mints, bindings } = makeFakeHost();
    await t.throwsAsync(main(host), { message: /must be disjoint/ });
    t.is(mints.length, 0);
    t.is(bindings.size, 0);
  },
);

test.serial(
  'explicit owner is persisted and an existing owned formula is reused',
  async t => {
    await withRuntime(t);
    await withEnv(t, { ENDO_OPENCODE_SANDBOX_OWNER_ID: 'operator-chosen' });
    const { host, mints } = makeFakeHost();
    await main(host);
    t.is(mints[0].options.env.ENDO_SANDBOX_OWNER_ID, 'operator-chosen');
    await withEnv(t, {
      ENDO_SANDBOX_GENERATED_MAX_BYTES: 'changed-and-ignored',
    });
    await main(host);
    t.is(
      mints.length,
      4,
      'factory, native service, mounter, and state provider all reused',
    );
    t.is(
      mints[0].options.env.ENDO_SANDBOX_GENERATED_MAX_BYTES,
      '9007199254740993',
    );
  },
);

test.serial(
  'existing generic factory is refused without replacing or mutating it',
  async t => {
    await withRuntime(t);
    const { host, bindings, formulas, mints } = makeFakeHost();
    bindings.set(key('opencode-sandbox', 'sandbox-factory'), 'old-factory');
    formulas.set(
      'old-factory',
      harden({
        type: 'make-unconfined',
        properties: {
          specifier: {
            kind: 'literal',
            value: new URL('../../sandbox/src/agent.js', import.meta.url).href,
          },
        },
      }),
    );
    await t.throwsAsync(main(host), { message: /Retire the old runtime/ });
    t.is(bindings.size, 1);
    t.is(
      bindings.get(key('opencode-sandbox', 'sandbox-factory')),
      'old-factory',
    );
    t.is(mints.length, 0);
  },
);

test.serial(
  'effective roots are selected independently for retained factory and state formulas',
  async t => {
    await null;
    for (const [hasFactory, hasState] of [
      [false, false],
      [true, false],
      [false, true],
      [true, true],
    ]) {
      // eslint-disable-next-line no-await-in-loop
      const { runtimeDir, tmp } = await withRuntime(t);
      const fake = makeFakeHost();
      const storedState = path.join(tmp, 'persisted-state');
      if (hasFactory) {
        seedFormula(
          fake,
          'sandbox-factory',
          sandboxSpecifier,
          runtimeEnv(runtimeDir),
        );
        // eslint-disable-next-line no-await-in-loop
        await withEnv(t, {
          ENDO_SANDBOX_RUNTIME_DIR: 'ignored-relative-path',
          ENDO_SANDBOX_GENERATED_MAX_BYTES: undefined,
          ENDO_SANDBOX_GENERATED_MAX_ENTRIES: undefined,
        });
      }
      if (hasState) {
        seedFormula(fake, 'state-provider', stateProviderSpecifier, {
          ENDO_OPENCODE_STATE_DIR: storedState,
        });
        // eslint-disable-next-line no-await-in-loop
        await withEnv(t, { ENDO_OPENCODE_STATE_DIR: 'ignored-state-path' });
      }
      // eslint-disable-next-line no-await-in-loop
      await main(fake.host);
      const names = fake.mints.map(mint => mint.options.resultName[1]);
      t.deepEqual(
        names,
        [
          !hasFactory && 'sandbox-factory',
          'native-sandbox',
          'fs-mounter',
          !hasState && 'state-provider',
        ].filter(Boolean),
      );
      t.deepEqual(
        fake.reads.filter(([kind]) => kind === 'env').map(([, id]) => id),
        fake.reads.filter(([kind]) => kind === 'formula').map(([, id]) => id),
      );
      if (hasState) {
        t.is(
          fake.environments.get('persisted-state-provider')
            .ENDO_OPENCODE_STATE_DIR,
          storedState,
        );
      }
    }
  },
);

test.serial(
  'stored runtime placement wins over a misleading current environment',
  async t => {
    const { runtimeDir, tmp } = await withRuntime(t);
    const fake = makeFakeHost();
    seedFormula(
      fake,
      'sandbox-factory',
      sandboxSpecifier,
      runtimeEnv(runtimeDir),
    );
    const other = path.join(tmp, 'different-runtime');
    await mkdir(other, { mode: 0o700 });
    await withEnv(t, {
      ENDO_SANDBOX_RUNTIME_DIR: other,
      ENDO_OPENCODE_MCP_DIR: path.join(runtimeDir, 'future-guest-mcp'),
    });
    await t.throwsAsync(main(fake.host), { message: /must be disjoint/ });
    t.deepEqual(fake.mints, []);
    t.is(fake.bindings.size, 1);
  },
);

test.serial(
  'stored state placement is checked before creating or retaining a factory',
  async t => {
    await null;
    for (const hasFactory of [false, true]) {
      // eslint-disable-next-line no-await-in-loop
      const { runtimeDir, tmp } = await withRuntime(t);
      const fake = makeFakeHost();
      seedFormula(fake, 'state-provider', stateProviderSpecifier, {
        ENDO_OPENCODE_STATE_DIR: tmp,
      });
      if (hasFactory)
        seedFormula(
          fake,
          'sandbox-factory',
          sandboxSpecifier,
          runtimeEnv(runtimeDir),
        );
      // eslint-disable-next-line no-await-in-loop
      await t.throwsAsync(main(fake.host), { message: /must be disjoint/ });
      t.deepEqual(fake.mints, []);
      t.is(fake.bindings.size, hasFactory ? 2 : 1);
    }
  },
);

test.serial(
  'state provider requires a supported entrypoint and persisted state root',
  async t => {
    await withRuntime(t);
    const missing = makeFakeHost();
    seedFormula(missing, 'state-provider', stateProviderSpecifier, {});
    await t.throwsAsync(main(missing.host), {
      message: /persisted ENDO_OPENCODE_STATE_DIR/,
    });
    t.deepEqual(missing.mints, []);
    const unsupported = makeFakeHost();
    seedFormula(unsupported, 'state-provider', sandboxSpecifier, {
      ENDO_OPENCODE_STATE_DIR: '/ignored',
    });
    await t.throwsAsync(main(unsupported.host), {
      message: /unsupported entrypoint/,
    });
    t.deepEqual(unsupported.mints, []);
    t.deepEqual(
      unsupported.reads.map(([kind]) => kind),
      ['formula'],
    );
  },
);

test.serial(
  'retains an existing native sandbox service with its persisted runtime',
  async t => {
    const { runtimeDir, tmp } = await withRuntime(t);
    await withStateDir(t, path.join(tmp, 'state-root'));
    const nativeDir = path.join(runtimeDir, 'native');
    await mkdir(nativeDir, { mode: 0o700 });
    const fake = makeFakeHost();
    seedFormula(
      fake,
      'sandbox-factory',
      sandboxSpecifier,
      runtimeEnv(runtimeDir),
    );
    seedFormula(fake, 'native-sandbox', nativeSandboxSpecifier, {
      ...runtimeEnv(nativeDir),
      ENDO_SANDBOX_OWNER_ID: 'persisted-owner-native',
    });
    await main(fake.host);
    t.deepEqual(
      fake.mints.map(mint => mint.options.resultName[1]),
      ['fs-mounter', 'state-provider'],
    );
    t.deepEqual(fake.stored, [], 'no replacement powers are stored');
    // A retained service whose persisted runtime would contain guest storage
    // is refused before any mint, like the factory: its placement is checked
    // against the effective roots, not assumed from the factory's.
    const elsewhere = path.join(tmp, 'native-elsewhere');
    await mkdir(elsewhere, { mode: 0o700 });
    await withStateDir(t, path.join(elsewhere, 'future-guest-state'));
    const misplaced = makeFakeHost();
    seedFormula(
      misplaced,
      'sandbox-factory',
      sandboxSpecifier,
      runtimeEnv(runtimeDir),
    );
    seedFormula(misplaced, 'native-sandbox', nativeSandboxSpecifier, {
      ...runtimeEnv(elsewhere),
      ENDO_SANDBOX_OWNER_ID: 'persisted-owner-native',
    });
    await t.throwsAsync(main(misplaced.host), { message: /must be disjoint/ });
    t.deepEqual(misplaced.mints, []);
    await withStateDir(t, path.join(tmp, 'state-root'));
    // An unsupported entrypoint under the native name is refused, not replaced.
    const unsupported = makeFakeHost();
    seedFormula(
      unsupported,
      'sandbox-factory',
      sandboxSpecifier,
      runtimeEnv(runtimeDir),
    );
    seedFormula(
      unsupported,
      'native-sandbox',
      sandboxSpecifier,
      runtimeEnv(nativeDir),
    );
    await t.throwsAsync(main(unsupported.host), {
      message: /unsupported entrypoint/,
    });
    t.deepEqual(unsupported.mints, []);
  },
);

test.serial(
  'refuses a symlinked native runtime directory before minting the service',
  async t => {
    const { runtimeDir, tmp } = await withRuntime(t);
    await withStateDir(t, path.join(tmp, 'state-root'));
    const target = path.join(tmp, 'native-target');
    await mkdir(target, { mode: 0o700 });
    await symlink(target, path.join(runtimeDir, 'native'));
    const fake = makeFakeHost();
    await t.throwsAsync(main(fake.host), { message: /must not be a symlink/ });
    t.deepEqual(
      fake.mints.map(mint => mint.options.resultName[1]),
      ['sandbox-factory'],
      'the factory mint precedes the refused native runtime',
    );
    t.deepEqual(fake.stored, []);
  },
);

test.serial('rejects a relative state root before minting', async t => {
  await withRuntime(t);
  await withStateDir(t, 'relative/opencode-state');
  const { host, mints } = makeFakeHost();
  await t.throwsAsync(main(host), { message: /must be absolute/ });
  t.is(mints.length, 0);
});

test.serial('rejects the filesystem root', async t => {
  await withRuntime(t);
  await withStateDir(t, '/');
  const { host, mints } = makeFakeHost();
  await t.throwsAsync(main(host), { message: /normalized, non-root/ });
  t.is(mints.length, 0);
});

test.serial('rejects a symlinked state root', async t => {
  await withRuntime(t);
  const target = await makeTmp(t, 'setup-host-target-');
  const link = `${await makeTmp(t, 'setup-host-link-')}-link`;
  await symlink(target, link);
  t.teardown(() => rm(link, { force: true }));
  await withStateDir(t, link);
  const { host, bindings, mints } = makeFakeHost();
  await t.throwsAsync(main(host), { message: /must not be a symlink/ });
  t.false(
    bindings.has(key('opencode-sandbox', 'state-provider')),
    'no provider is minted against a rejected root',
  );
  t.is(
    mints.length,
    3,
    'factory, native service, and mounter are harmless pre-state mints',
  );
});

test.serial('rejects a state root that is a file', async t => {
  await withRuntime(t);
  const dir = await makeTmp(t, 'setup-host-file-');
  const file = path.join(dir, 'state');
  await writeFile(file, 'not a directory\n');
  await withStateDir(t, file);
  const { host, bindings } = makeFakeHost();
  await t.throwsAsync(main(host), { message: /must be a directory/ });
  t.false(bindings.has(key('opencode-sandbox', 'state-provider')));
});

test.serial(
  'adopts an existing private root but refuses a foreign-owned one',
  async t => {
    await withRuntime(t);
    const tmp = await makeTmp(t, 'setup-host-adopt-');
    const stateDir = path.join(tmp, 'state');
    await mkdir(stateDir, { mode: 0o700 });
    await chmod(stateDir, 0o755);
    await withStateDir(t, stateDir);
    const { host, bindings } = makeFakeHost();
    await main(host);
    t.true(bindings.has(key('opencode-sandbox', 'state-provider')));
    t.is((await stat(stateDir)).mode % 0o1000, 0o700, 'loose mode tightened');
  },
);
