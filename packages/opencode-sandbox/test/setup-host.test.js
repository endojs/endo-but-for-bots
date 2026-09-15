// @ts-check
import '@endo/init';
import test from 'ava';
import { createHash } from 'node:crypto';
import {
  chmod,
  mkdir,
  mkdtemp,
  readlink,
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
  stateProviderSpecifier,
} from '../src/hosted-runtime-setup.js';

// A supported entrypoint of another service is an unsupported one for the
// service under test; the retired capability-based runtime's entrypoint is
// no longer exported.
const legacyFactorySpecifier = new URL(
  '../../sandbox/src/owned-agent.js',
  import.meta.url,
).href;

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

test.serial('mints the native runtime and the state provider', async t => {
  const { runtimeDir } = await withRuntime(t);
  const tmp = await makeTmp(t, 'setup-host-state-');
  const stateDir = path.join(tmp, 'state');
  await withStateDir(t, stateDir);
  const { host, bindings, mints, stored, removed } = makeFakeHost();
  await main(host);

  t.deepEqual(
    mints.map(mint => mint.options.resultName),
    [
      ['opencode-sandbox', 'native-sandbox'],
      ['opencode-sandbox', 'state-provider'],
    ],
  );
  t.true(bindings.has(key('opencode-sandbox', 'state-provider')));
  t.is(
    mints[1].options.env.ENDO_OPENCODE_STATE_DIR,
    stateDir,
    'the provider is given the validated state root',
  );
  // The native service is constructed over a stored literal null, never a
  // host or denied-method capability, as the primary runtime: it owns the
  // validated runtime directory itself under the host-derived owner label.
  t.is(mints[0].specifier, nativeSandboxSpecifier);
  t.is(mints[0].options.powersName, 'opencode.null-powers');
  t.deepEqual(stored, [{ value: null, name: 'opencode.null-powers' }]);
  t.true(removed.some(parts => key(...parts) === key('opencode.null-powers')));
  t.false(bindings.has(key('opencode.null-powers')), 'alias removed');
  t.regex(
    mints[0].options.env.ENDO_SANDBOX_OWNER_ID,
    /^opencode-[0-9a-f]{64}$/,
  );
  t.deepEqual(mints[0].options.env, {
    ENDO_SANDBOX_OWNER_ID: mints[0].options.env.ENDO_SANDBOX_OWNER_ID,
    ENDO_SANDBOX_RUNTIME_DIR: await realpath(runtimeDir),
    ENDO_SANDBOX_GENERATED_MAX_BYTES: '9007199254740993',
    ENDO_SANDBOX_GENERATED_MAX_ENTRIES: '16',
  });
  t.false(
    bindings.has(key('opencode-sandbox', 'sandbox-factory')),
    'no capability-based factory is minted',
  );
  t.false(
    bindings.has(key('opencode-sandbox', 'fs-mounter')),
    'no shared mounter is minted',
  );
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
    t.is(mints.length, 2, 'native service and state provider both reused');
    t.is(
      mints[0].options.env.ENDO_SANDBOX_GENERATED_MAX_BYTES,
      '9007199254740993',
    );
  },
);

test.serial(
  'a bound legacy sandbox-factory refuses a new native runtime without touching it',
  async t => {
    const { runtimeDir, tmp } = await withRuntime(t);
    await withStateDir(t, path.join(tmp, 'state-root'));
    const { host, bindings, mints, stored } = makeFakeHost();
    bindings.set(key('opencode-sandbox', 'sandbox-factory'), 'old-factory');
    await t.throwsAsync(main(host), {
      message: /sandbox-factory is still bound: retire the old runtime/,
    });
    t.is(bindings.size, 1);
    t.is(
      bindings.get(key('opencode-sandbox', 'sandbox-factory')),
      'old-factory',
    );
    t.is(mints.length, 0);
    t.deepEqual(stored, [], 'refused before storing the null powers');
    // A retained native runtime beside the legacy names is kept; the legacy
    // names are reported, never read, removed, or replaced.
    const retained = makeFakeHost();
    retained.bindings.set(key('opencode-sandbox', 'sandbox-factory'), 'old');
    retained.bindings.set(key('opencode-sandbox', 'fs-mounter'), 'old-mount');
    seedFormula(
      retained,
      'native-sandbox',
      nativeSandboxSpecifier,
      runtimeEnv(runtimeDir),
    );
    await main(retained.host);
    t.deepEqual(
      retained.mints.map(mint => mint.options.resultName[1]),
      ['state-provider'],
    );
    t.is(
      retained.bindings.get(key('opencode-sandbox', 'sandbox-factory')),
      'old',
    );
    t.is(
      retained.bindings.get(key('opencode-sandbox', 'fs-mounter')),
      'old-mount',
    );
    t.deepEqual(retained.removed, []);
    t.deepEqual(
      retained.reads.map(([, id]) => id),
      ['persisted-native-sandbox', 'persisted-native-sandbox'],
      'only the native runtime is read',
    );
  },
);

test.serial(
  'a leftover ownership marker or generated-files root under the native label refuses the mint',
  async t => {
    const { runtimeDir, tmp } = await withRuntime(t);
    await withStateDir(t, path.join(tmp, 'state-root'));
    const ownerId = `opencode-${createHash('sha256').update('fake-host-id').digest('hex')}`;
    // A retired runtime under the same label left its marker behind: the
    // daemon would bind the native formula and then refuse it at construction.
    const marker = path.join(runtimeDir, `${ownerId}.owner`);
    await symlink('endo-sandbox-owner-v1-stale', marker);
    const marked = makeFakeHost();
    await t.throwsAsync(main(marked.host), {
      message: /still holds .*\.owner": the native runtime would claim it/,
    });
    t.deepEqual(marked.mints, []);
    t.deepEqual(marked.stored, []);
    t.is(marked.bindings.size, 0, 'refused before the directory is made');
    t.is(await readlink(marker), 'endo-sandbox-owner-v1-stale', 'untouched');
    await rm(marker);
    const files = path.join(runtimeDir, `${ownerId}.files`);
    await mkdir(files, { mode: 0o700 });
    const rooted = makeFakeHost();
    await t.throwsAsync(main(rooted.host), {
      message: /still holds .*\.files": the native runtime would claim it/,
    });
    t.deepEqual(rooted.mints, []);
    t.deepEqual(rooted.stored, []);
    t.is(rooted.bindings.size, 0, 'refused before the directory is made');
    t.true((await stat(files)).isDirectory(), 'untouched');
    await rm(files, { recursive: true });
    // Another owner's leftovers are not this runtime's to judge: not probed,
    // not removed.
    const foreign = path.join(runtimeDir, 'other.owner');
    await symlink('endo-sandbox-owner-v1-other', foreign);
    const fresh = makeFakeHost();
    await main(fresh.host);
    t.deepEqual(
      fresh.mints.map(mint => mint.options.resultName[1]),
      ['native-sandbox', 'state-provider'],
    );
    t.is(await readlink(foreign), 'endo-sandbox-owner-v1-other', 'untouched');
  },
);

test.serial(
  'effective roots are selected independently for retained runtime and state formulas',
  async t => {
    await null;
    for (const [hasNative, hasState] of [
      [false, false],
      [true, false],
      [false, true],
      [true, true],
    ]) {
      // eslint-disable-next-line no-await-in-loop
      const { runtimeDir, tmp } = await withRuntime(t);
      const fake = makeFakeHost();
      const storedState = path.join(tmp, 'persisted-state');
      if (hasNative) {
        seedFormula(
          fake,
          'native-sandbox',
          nativeSandboxSpecifier,
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
        [!hasNative && 'native-sandbox', !hasState && 'state-provider'].filter(
          Boolean,
        ),
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
      'native-sandbox',
      nativeSandboxSpecifier,
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
  'stored state placement is checked before creating or retaining the runtime',
  async t => {
    await null;
    for (const hasNative of [false, true]) {
      // eslint-disable-next-line no-await-in-loop
      const { runtimeDir, tmp } = await withRuntime(t);
      const fake = makeFakeHost();
      seedFormula(fake, 'state-provider', stateProviderSpecifier, {
        ENDO_OPENCODE_STATE_DIR: tmp,
      });
      if (hasNative)
        seedFormula(
          fake,
          'native-sandbox',
          nativeSandboxSpecifier,
          runtimeEnv(runtimeDir),
        );
      // eslint-disable-next-line no-await-in-loop
      await t.throwsAsync(main(fake.host), { message: /must be disjoint/ });
      t.deepEqual(fake.mints, []);
      t.is(fake.bindings.size, hasNative ? 2 : 1);
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
    seedFormula(unsupported, 'state-provider', legacyFactorySpecifier, {
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
    // A service minted beside the retired factory keeps the private child it
    // was given; placement is checked where it is, not where the current
    // environment points.
    const nativeDir = path.join(runtimeDir, 'native');
    await mkdir(nativeDir, { mode: 0o700 });
    const fake = makeFakeHost();
    seedFormula(fake, 'native-sandbox', nativeSandboxSpecifier, {
      ...runtimeEnv(nativeDir),
      ENDO_SANDBOX_OWNER_ID: 'persisted-owner-native',
    });
    await withEnv(t, { ENDO_SANDBOX_RUNTIME_DIR: 'ignored-relative-path' });
    await main(fake.host);
    t.deepEqual(
      fake.mints.map(mint => mint.options.resultName[1]),
      ['state-provider'],
    );
    t.deepEqual(fake.stored, [], 'no replacement powers are stored');
    // A retained service whose persisted runtime would contain guest storage
    // is refused before any mint: its placement is checked against the
    // effective roots.
    const elsewhere = path.join(tmp, 'native-elsewhere');
    await mkdir(elsewhere, { mode: 0o700 });
    await withStateDir(t, path.join(elsewhere, 'future-guest-state'));
    const misplaced = makeFakeHost();
    seedFormula(misplaced, 'native-sandbox', nativeSandboxSpecifier, {
      ...runtimeEnv(elsewhere),
      ENDO_SANDBOX_OWNER_ID: 'persisted-owner-native',
    });
    await t.throwsAsync(main(misplaced.host), { message: /must be disjoint/ });
    t.deepEqual(misplaced.mints, []);
    await withStateDir(t, path.join(tmp, 'state-root'));
    // An unsupported entrypoint under the native name — the retired
    // capability-based runtime's, say — is refused, not replaced.
    const unsupported = makeFakeHost();
    seedFormula(
      unsupported,
      'native-sandbox',
      legacyFactorySpecifier,
      runtimeEnv(nativeDir),
    );
    await t.throwsAsync(main(unsupported.host), {
      message: /unsupported entrypoint/,
    });
    t.deepEqual(unsupported.mints, []);
    t.deepEqual(unsupported.stored, []);
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
  t.is(mints.length, 1, 'the native service is a harmless pre-state mint');
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
