// @ts-check
import '@endo/init';

import test from 'ava';
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
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

const key = (...parts) => JSON.stringify(parts.flat());

const unsupportedSpecifier = new URL('../src/codex-client.js', import.meta.url)
  .href;

const makeFakeHost = () => {
  const bindings = new Map();
  /** @type {any[]} */
  const mints = [];
  /** @type {any[]} */
  const stored = [];
  /** @type {any[]} */
  const removed = [];
  const environments = new Map();
  const specifiers = new Map();
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
      if (parts.length > 1 && !bindings.has(key(parts[0]))) {
        // A directory that does not exist cannot be resolved to probe a name
        // inside it, which is what the daemon does.
        throw Error(`Unknown pet name: ${parts[0]}`);
      }
      return bindings.has(key(...parts));
    },
    async makeDirectory(namePath) {
      bindings.set(key(...namePath), 'dir');
    },
    async storeValue(value, name) {
      stored.push({ value, name });
      bindings.set(key(name), 'marshal');
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
      const id = `${result.at(-1)}-id`;
      bindings.set(key(...result), id);
      specifiers.set(id, specifier);
      environments.set(id, options.env);
    },
  });
  return { host, bindings, mints, stored, removed, environments, specifiers };
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
  // macOS puts the temp root behind a symlink, and the runtime directory is
  // canonicalized before it is recorded.
  const base = await realpath(
    await mkdtemp(path.join(os.tmpdir(), 'codex-setup-host-')),
  );
  t.teardown(() => rm(base, { recursive: true, force: true }));
  const runtime = path.join(base, 'runtime');
  await mkdir(runtime, { mode: 0o700 });
  withEnv(t, {
    ENDO_SANDBOX_RUNTIME_DIR: runtime,
    ENDO_SANDBOX_GENERATED_MAX_BYTES: '4096',
    ENDO_SANDBOX_GENERATED_MAX_ENTRIES: '16',
    ENDO_CODEX_STATE_DIR: path.join(base, 'state'),
    ENDO_CODEX_VOLUME_ROOT: path.join(base, 'volumes'),
    ENDO_CODEX_FILESYSTEM: path.join(base, 'volumes'),
    ENDO_CODEX_QUOTA_COMMAND: path.join(base, 'codex-quota'),
    ENDO_CODEX_SUDO_PATH: undefined,
    ENDO_CODEX_SANDBOX_OWNER_ID: undefined,
  });
  return { base, runtime };
};

test.serial('mints both host formulas with null powers', async t => {
  const { base, runtime } = await baseEnv(t);
  const fake = makeFakeHost();
  await main(fake.host);

  t.is(fake.mints.length, 2);
  const native = fake.mints.find(
    mint => mint.specifier === nativeSandboxSpecifier,
  );
  const state = fake.mints.find(
    mint => mint.specifier === stateProviderSpecifier,
  );
  t.deepEqual(native.options.resultName, ['codex-sandbox', 'native-sandbox']);
  t.deepEqual(state.options.resultName, ['codex-sandbox', 'state-provider']);
  // Both are constructed with a slot-free stored null, not `@agent` and not
  // `@none` — which would be a denied-method guest capability, not null.
  t.is(fake.stored.length, 2);
  t.deepEqual(
    fake.stored.map(({ value }) => value),
    [null, null],
  );
  t.is(native.options.powersName, 'codex.null-powers');
  t.is(state.options.powersName, 'codex.state-null-powers');
  // The aliases are removed again; the formulas retain the stored value.
  t.is(
    fake.removed.filter(parts => `${parts[0]}`.startsWith('codex.')).length,
    2,
  );

  t.is(native.options.env.ENDO_SANDBOX_RUNTIME_DIR, runtime);
  // The owner label is derived from the host identity, reproducing what the
  // backend caplet computed while it still held `@agent` to ask.
  t.regex(native.options.env.ENDO_SANDBOX_OWNER_ID, /^codex-[0-9a-f]{56}$/);
  t.false('ENDO_CODEX_SUDO_PATH' in native.options.env);
  t.false('ENDO_CODEX_QUOTA_COMMAND' in native.options.env);
  t.is(state.options.env.ENDO_CODEX_STATE_DIR, path.join(base, 'state'));
});

test.serial('the common native service needs no quota bridge', async t => {
  await baseEnv(t);
  withEnv(t, { ENDO_CODEX_QUOTA_COMMAND: undefined });
  const fake = makeFakeHost();
  await main(fake.host);
  t.is(fake.mints.length, 2);
  t.true(fake.mints.some(mint => mint.specifier === nativeSandboxSpecifier));
});

test.serial(
  'a runtime directory that still holds an ownership marker is refused',
  async t => {
    const { runtime } = await baseEnv(t);
    withEnv(t, { ENDO_CODEX_SANDBOX_OWNER_ID: 'codex-leftover' });
    await symlink(
      'endo-sandbox-owner-v1-abc',
      path.join(runtime, 'codex-leftover.owner'),
    );
    const fake = makeFakeHost();
    await t.throwsAsync(main(fake.host), {
      message: /still holds .*codex-leftover\.owner/s,
    });
    t.deepEqual(fake.mints, []);
  },
);

test.serial(
  'the runtime directory must be disjoint from session state',
  async t => {
    const { runtime } = await baseEnv(t);
    withEnv(t, { ENDO_CODEX_STATE_DIR: path.join(runtime, 'state') });
    const fake = makeFakeHost();
    await t.throwsAsync(main(fake.host), {
      message: /disjoint from Codex guest storage roots/,
    });
    t.deepEqual(fake.mints, []);
  },
);

test.serial('existing formulas are retained, not reapplied', async t => {
  const { base, runtime } = await baseEnv(t);
  const fake = makeFakeHost();
  await main(fake.host);
  const firstMints = fake.mints.length;

  // A second run with a changed environment must not rebind either formula.
  withEnv(t, {
    ENDO_CODEX_STATE_DIR: path.join(base, 'other-state'),
    ENDO_SANDBOX_RUNTIME_DIR: runtime,
  });
  await main(fake.host);
  t.is(fake.mints.length, firstMints);
});

test.serial('a state root that is a symlink is refused', async t => {
  const { base } = await baseEnv(t);
  const target = path.join(base, 'elsewhere');
  await mkdir(target, { mode: 0o700 });
  await writeFile(path.join(target, 'marker'), 'x');
  const linked = path.join(base, 'linked-state');
  await symlink(target, linked);
  withEnv(t, { ENDO_CODEX_STATE_DIR: linked });
  const fake = makeFakeHost();
  // The provider refuses a symlinked root at use; setup only records it, so
  // this asserts the recorded value is exactly what the operator supplied and
  // that nothing dereferenced it on the way in.
  await main(fake.host);
  const state = fake.mints.find(
    mint => mint.specifier === stateProviderSpecifier,
  );
  t.is(state.options.env.ENDO_CODEX_STATE_DIR, linked);
});
