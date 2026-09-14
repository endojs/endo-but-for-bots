// @ts-check
import '@endo/init';
import test from 'ava';
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { main } from '../setup-host.js';
import {
  nativeSandboxSpecifier,
  stateProviderSpecifier,
} from '../src/hosted-runtime-setup.js';

/** @import { EndoHost } from '@endo/daemon' */

const key = (...parts) => JSON.stringify(parts.flat());

/**
 * A fake host. The inbox-form factory's own objects (`service`, `profile`,
 * `handle`, `readme.md`) and the legacy `fs-mounter` read as present so its
 * setup is skipped; `sandbox-factory`, `native-sandbox`, and `state-provider`
 * are minted unless seeded.
 */
const makeFakeHost = () => {
  const bindings = new Map();
  const formulas = new Map();
  const environments = new Map();
  /** @type {any[]} */
  const mints = [];
  /** @type {Array<{ value: unknown, name: string }>} */
  const stored = [];
  /** @type {string[][]} */
  const removed = [];
  /** @type {string[][]} */
  const reads = [];
  for (const name of [
    'fs-mounter',
    'service',
    'profile',
    'handle',
    'readme.md',
  ]) {
    bindings.set(key('claude-sandbox', name), 'legacy');
  }
  bindings.set(key('claude-sandbox'), 'dir');
  const seedFormula = (name, specifier, env) => {
    const id = `persisted-${name}`;
    bindings.set(key('claude-sandbox', name), id);
    formulas.set(id, {
      type: 'make-unconfined',
      properties: { specifier: { kind: 'literal', value: specifier } },
    });
    environments.set(id, harden({ ...env }));
    return id;
  };
  const host = /** @type {EndoHost} */ (
    /** @type {unknown} */ (
      harden({
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
          formulas.set(id, {
            type: 'make-unconfined',
            properties: { specifier: { kind: 'literal', value: specifier } },
          });
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
    )
  );
  return { host, bindings, mints, stored, removed, reads, seedFormula };
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
const withRuntime = async t => {
  const tmp = await realpath(
    await mkdtemp(path.join(os.tmpdir(), 'claude-setup-host-')),
  );
  t.teardown(() => rm(tmp, { recursive: true, force: true }));
  const runtimeDir = path.join(tmp, 'runtime');
  await mkdir(runtimeDir, { mode: 0o700 });
  await withEnv(t, {
    ENDO_CLAUDE_SANDBOX_OWNER_ID: undefined,
    ENDO_SANDBOX_RUNTIME_DIR: runtimeDir,
    ENDO_SANDBOX_GENERATED_MAX_BYTES: '4096',
    ENDO_SANDBOX_GENERATED_MAX_ENTRIES: '16',
    ENDO_CLAUDE_STATE_DIR: path.join(tmp, 'state'),
    ENDO_CLAUDE_WORKSPACE_DIR: path.join(tmp, 'workspaces'),
    ENDO_CLAUDE_MCP_DIR: path.join(tmp, 'mcp'),
  });
  return { runtimeDir, tmp };
};

const runtimeEnv = directory =>
  harden({
    ENDO_SANDBOX_RUNTIME_DIR: directory,
    ENDO_SANDBOX_OWNER_ID: 'persisted-owner-native',
    ENDO_SANDBOX_GENERATED_MAX_BYTES: '4096',
    ENDO_SANDBOX_GENERATED_MAX_ENTRIES: '16',
  });

test.serial(
  'mints the legacy factory, the native runtime over the runtime directory, and the state provider',
  async t => {
    const { runtimeDir, tmp } = await withRuntime(t);
    const { host, mints, stored, removed, bindings } = makeFakeHost();
    await main(host);
    t.deepEqual(
      mints.map(mint => mint.options.resultName),
      [
        ['claude-sandbox', 'sandbox-factory'],
        ['claude-sandbox', 'native-sandbox'],
        ['claude-sandbox', 'state-provider'],
      ],
    );
    const [factory, native, state] = mints;
    t.regex(factory.options.env.ENDO_SANDBOX_OWNER_ID, /^claude-[0-9a-f]{64}$/);
    t.deepEqual(factory.options.env, {
      ENDO_SANDBOX_OWNER_ID: factory.options.env.ENDO_SANDBOX_OWNER_ID,
    });
    // The native service is constructed over a stored literal null and owns
    // the validated runtime directory itself under a derived label.
    t.is(native.specifier, nativeSandboxSpecifier);
    t.is(native.options.powersName, 'claude.null-powers');
    t.deepEqual(stored, [{ value: null, name: 'claude.null-powers' }]);
    t.true(removed.some(parts => key(...parts) === key('claude.null-powers')));
    t.false(bindings.has(key('claude.null-powers')), 'alias removed');
    t.deepEqual(native.options.env, {
      ENDO_SANDBOX_RUNTIME_DIR: runtimeDir,
      ENDO_SANDBOX_OWNER_ID: `${factory.options.env.ENDO_SANDBOX_OWNER_ID}-native`,
      ENDO_SANDBOX_GENERATED_MAX_BYTES: '4096',
      ENDO_SANDBOX_GENERATED_MAX_ENTRIES: '16',
    });
    t.deepEqual(
      await readdir(runtimeDir),
      [],
      'setup creates nothing inside the runtime directory',
    );
    t.is(state.specifier, stateProviderSpecifier);
    t.is(state.options.powersName, '@none');
    t.deepEqual(state.options.env, {
      ENDO_CLAUDE_STATE_DIR: path.join(tmp, 'state'),
    });
    // eslint-disable-next-line no-bitwise
    t.is((await stat(path.join(tmp, 'state'))).mode & 0o777, 0o700);
    // A rerun retains everything; the current environment is not reapplied.
    await withEnv(t, {
      ENDO_SANDBOX_GENERATED_MAX_BYTES: 'changed-and-ignored',
    });
    await main(host);
    t.is(mints.length, 3);
  },
);

test.serial(
  'honors an explicit owner for both runtimes without resolving host identity',
  async t => {
    await withRuntime(t);
    await withEnv(t, { ENDO_CLAUDE_SANDBOX_OWNER_ID: 'custom-claude-owner' });
    const { host, mints } = makeFakeHost();
    await main(host);
    t.is(mints[0].options.env.ENDO_SANDBOX_OWNER_ID, 'custom-claude-owner');
    t.is(
      mints[1].options.env.ENDO_SANDBOX_OWNER_ID,
      'custom-claude-owner-native',
    );
  },
);

test.serial('hosts sharing a peer do not share cleanup ownership', async t => {
  await withRuntime(t);
  const owners = [];
  for (const id of ['host-a', 'host-b']) {
    const fake = makeFakeHost();
    const host = /** @type {EndoHost} */ (
      /** @type {unknown} */ (
        harden({
          .../** @type {any} */ (fake.host),
          async identify(...parts) {
            return parts[0] === '@agent'
              ? id
              : fake.bindings.get(key(...parts));
          },
        })
      )
    );
    // eslint-disable-next-line no-await-in-loop
    await main(host);
    owners.push(fake.mints[1].options.env.ENDO_SANDBOX_OWNER_ID);
  }
  t.not(owners[0], owners[1]);
});

test.serial(
  'refuses before any mint: state root, runtime placement, and native leftovers',
  async t => {
    const { runtimeDir } = await withRuntime(t);
    await withEnv(t, { ENDO_CLAUDE_STATE_DIR: 'relative/state' });
    const relative = makeFakeHost();
    await t.throwsAsync(main(relative.host), { message: /must be absolute/ });
    t.deepEqual(relative.mints, []);
    await withEnv(t, {
      ENDO_CLAUDE_STATE_DIR: path.join(runtimeDir, 'future-state'),
    });
    const inside = makeFakeHost();
    await t.throwsAsync(main(inside.host), { message: /must be disjoint/ });
    t.deepEqual(inside.mints, []);
    await withEnv(t, {
      ENDO_CLAUDE_STATE_DIR: path.join(path.dirname(runtimeDir), 'state'),
    });
    const expectedOwner = `claude-${(await import('node:crypto')).createHash('sha256').update('fake-host-id').digest('hex')}-native`;
    await symlink('stale', path.join(runtimeDir, `${expectedOwner}.owner`));
    const marked = makeFakeHost();
    await t.throwsAsync(main(marked.host), {
      message: /still holds .*\.owner"/,
    });
    t.deepEqual(marked.mints, []);
    t.deepEqual(marked.stored, []);
    await rm(path.join(runtimeDir, `${expectedOwner}.owner`));
    await chmod(runtimeDir, 0o755);
    const loose = makeFakeHost();
    await t.throwsAsync(main(loose.host), { message: /must be private/ });
    t.deepEqual(loose.mints, []);
  },
);

test.serial(
  'retained native runtime and state provider keep their persisted placement; unsupported entrypoints are refused',
  async t => {
    const { runtimeDir, tmp } = await withRuntime(t);
    const nativeDir = runtimeDir;
    const persistedState = path.join(tmp, 'persisted-state');
    const fake = makeFakeHost();
    fake.seedFormula(
      'native-sandbox',
      nativeSandboxSpecifier,
      runtimeEnv(nativeDir),
    );
    fake.seedFormula('state-provider', stateProviderSpecifier, {
      ENDO_CLAUDE_STATE_DIR: persistedState,
    });
    await withEnv(t, {
      ENDO_SANDBOX_RUNTIME_DIR: 'ignored-relative-path',
      ENDO_CLAUDE_STATE_DIR: 'ignored-state-path',
    });
    await main(fake.host);
    t.deepEqual(
      fake.mints.map(mint => mint.options.resultName[1]),
      ['sandbox-factory'],
      'only the legacy factory is minted',
    );
    t.deepEqual(fake.stored, []);
    // A retained native runtime whose directory would contain guest storage is
    // refused before any mint.
    const misplaced = makeFakeHost();
    misplaced.seedFormula(
      'native-sandbox',
      nativeSandboxSpecifier,
      runtimeEnv(nativeDir),
    );
    await withEnv(t, {
      ENDO_CLAUDE_STATE_DIR: path.join(nativeDir, 'future-state'),
    });
    await t.throwsAsync(main(misplaced.host), { message: /must be disjoint/ });
    t.deepEqual(misplaced.mints, []);
    await withEnv(t, { ENDO_CLAUDE_STATE_DIR: path.join(tmp, 'state') });
    const unsupported = makeFakeHost();
    unsupported.seedFormula(
      'native-sandbox',
      stateProviderSpecifier,
      runtimeEnv(nativeDir),
    );
    await t.throwsAsync(main(unsupported.host), {
      message: /unsupported entrypoint/,
    });
    t.deepEqual(unsupported.mints, []);
    const badState = makeFakeHost();
    badState.seedFormula('state-provider', stateProviderSpecifier, {});
    await t.throwsAsync(main(badState.host), {
      message: /persisted ENDO_CLAUDE_STATE_DIR/,
    });
    t.deepEqual(badState.mints, []);
  },
);
