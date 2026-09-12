// @ts-check
import '@endo/init';
import test from 'ava';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { main } from '../setup-hosted.js';
import {
  sandboxSpecifier,
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
  return {
    bindings,
    mints,
    copies,
    removed,
    environments,
    reads,
    host: /** @type {EndoHost} */ (
      /** @type {unknown} */ ({
        async identify(...parts) {
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
                    value:
                      id === 'state-provider-id'
                        ? stateProviderSpecifier
                        : factorySpecifier,
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
  for (const name of ['sandbox-factory', 'state-provider', 'fs-mounter']) {
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
    ENDO_OPENCODE_CONFIG_DIR: path.join(base, 'configs'),
    ENDO_OPENCODE_MCP_DIR: path.join(base, 'mcp'),
    ENDO_OPENCODE_CREDS_NAME: 'test-auth',
    ENDO_OPENROUTER_API_KEY: 'seed-token',
    ENDO_FLOOT_DIR: 'floot',
  });
  return base;
};

test.serial('requires setup-host.js artifacts', async t => {
  await withEnv(t, { ENDO_OPENCODE_CREDS_NAME: 'test-auth' });
  const noFactory = makeFakeHost();
  await t.throwsAsync(main(noFactory.host), { message: /sandbox-factory/ });

  const noProvider = makeFakeHost();
  noProvider.bindings.set(key('opencode-sandbox', 'sandbox-factory'), 'cap');
  await t.throwsAsync(main(noProvider.host), { message: /state-provider/ });

  const noMounter = makeFakeHost();
  noMounter.bindings.set(key('opencode-sandbox', 'sandbox-factory'), 'cap');
  noMounter.bindings.set(key('opencode-sandbox', 'state-provider'), 'cap');
  await t.throwsAsync(main(noMounter.host), { message: /fs-mounter/ });
  t.is(noMounter.mints.length, 0, 'no mint precedes the preflight failures');
});

test.serial(
  'standalone hosted setup refuses a generic factory before any mutation',
  async t => {
    await baseEnv(t);
    const fake = makeFakeHost({
      factorySpecifier: new URL('../../sandbox/src/agent.js', import.meta.url)
        .href,
    });
    for (const name of ['sandbox-factory', 'state-provider', 'fs-mounter']) {
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
      ENDO_OPENCODE_CONFIG_DIR: path.join(base, 'runtime', 'configs'),
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
    t.is(fake.mints.length, 2);
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

    t.is(mints.length, 2, 'credential + backend');
    t.regex(mints[0].specifier, /managed-credentials-module\.js$/);
    t.regex(mints[1].specifier, /opencode-backend-module\.js$/);
    t.deepEqual(mints[1].options.resultName, [
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
    for (const name of ['sandbox-factory', 'state-provider', 'fs-mounter']) {
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
