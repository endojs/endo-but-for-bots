// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';

import { Far } from '@endo/far';

import {
  make as makeCredential,
  readCredentialSecretPath,
} from '../src/managed-renewable-credentials-module.js';
import {
  provideManagedRenewableCredentials,
  readManagedRenewableCredentials,
  renewableCredentialsSpecifier,
} from '../src/managed-renewable-credentials.js';

const key = (...parts) => JSON.stringify(parts.flat());

const secretPath = ['secrets', 'codex-subscription-auth'];
const secretGrant = 'a'.repeat(64);
const pairFormula = () => ({
  type: 'marshal',
  properties: {
    slots: {
      kind: 'reference-list',
      entries: { 0: 'host-id', 1: 'secret-id' },
    },
  },
});

const makeFixture = ({
  bound = false,
  boundPath = secretPath,
  faults = {},
} = {}) => {
  const bindings = new Map();
  const formulas = new Map();
  const environments = new Map();
  const values = new Map();
  /** @type {any[]} */
  const calls = [];
  let reads = 0;
  let writes = 0;
  let lookups = 0;
  let generation = 4n;
  const secret = Far('SecretBlob', {
    readBase64: async () => {
      reads += 1;
      return btoa('token');
    },
    readBase64WithGeneration: async () => {
      reads += 1;
      return harden({ base64: btoa('token'), generation });
    },
  });
  const admin = Far('SecretAdmin', {
    replaceBase64: async (_base64, options = {}) => {
      if (
        options.ifGeneration !== undefined &&
        options.ifGeneration !== generation
      ) {
        throw Error('wrong generation');
      }
      writes += 1;
      generation += 1n;
      return generation;
    },
    getSummary: async () => harden({ generation, state: 'active' }),
    revoke: async () => {
      throw Error('revoke must not be reachable');
    },
    delete: async () => {
      throw Error('delete must not be reachable');
    },
    setDescription: async () => {
      throw Error('setDescription must not be reachable');
    },
  });
  const catalog = Far('Catalog', {
    list: async () => harden([{ petNamePaths: [secretPath], admin }]),
    adminFor: async facet => {
      if (facet !== secret) throw Error('unknown secret facet');
      return admin;
    },
  });
  if (bound) {
    bindings.set(key(['codex-sandbox', 'credential']), 'existing-id');
    formulas.set('existing-id', {
      type: 'make-unconfined',
      properties: {
        specifier: { kind: 'literal', value: renewableCredentialsSpecifier },
        powers: { kind: 'reference', identifier: 'powers-id' },
      },
    });
    environments.set('existing-id', {
      CREDENTIAL_BINDING_VERSION: '2',
      CREDENTIAL_SECRET_PATH: JSON.stringify(boundPath),
      CREDENTIAL_LABEL: 'Codex',
    });
  }
  let selectedSecret = secret;
  const host = Far('Host', {
    has: async (...parts) => bindings.has(key(...parts)),
    identify: async (...parts) =>
      key(...parts) === key('@agent') ? 'host-id' : bindings.get(key(...parts)),
    diagnostics: async () =>
      Far('Diagnostics', { getFormula: async id => formulas.get(id) }),
    getFormulaEnvironment: async id => environments.get(id),
    lookup: async path => {
      const parts = Array.isArray(path) ? path : [path];
      if (parts[0] === '@secrets') return catalog;
      if (key(parts) === key(secretPath)) return selectedSecret;
      throw Error(`unexpected lookup ${key(parts)}`);
    },
    lookupById: async id => {
      lookups += 1;
      if ('lookup' in faults) throw faults.lookup;
      return values.get(id);
    },
    storeValue: async (value, name) => {
      bindings.set(key(name), 'powers-id');
      values.set('powers-id', value);
      formulas.set('powers-id', pairFormula());
      if ('storedFormula' in faults) {
        formulas.set(faults.storedFormula.id, faults.storedFormula.formula);
      }
      if ('store' in faults) throw faults.store;
    },
    remove: async name => {
      if ('cleanup' in faults) throw faults.cleanup;
      bindings.delete(key(name));
    },
    makeUnconfined: async (worker, specifier, options) => {
      calls.push(['mint', worker, specifier, options]);
      if ('mint' in faults) throw faults.mint;
      bindings.set(key(options.resultName), 'minted');
      formulas.set('minted', {
        type: 'make-unconfined',
        properties: {
          specifier: { kind: 'literal', value: specifier },
          powers: {
            kind: 'reference',
            identifier: bindings.get(key(options.powersName)),
          },
        },
      });
      environments.set('minted', options.env);
    },
  });
  values.set('powers-id', harden({ host, secret }));
  formulas.set('powers-id', pairFormula());
  formulas.set('host-id', { type: 'host' });
  formulas.set('secret-id', {
    type: 'lookup',
    properties: {
      hub: { kind: 'reference', identifier: 'host-id' },
      path: { kind: 'literal', value: ['@secrets', 'use', secretGrant] },
    },
  });
  return {
    host,
    calls,
    secret,
    admin,
    bindings,
    environments,
    formulas,
    pair: harden({ host, secret }),
    lookupCount: () => lookups,
    rebind: () => {
      selectedSecret = Far('ReplacementSecret', {});
    },
    state: () => ({ reads, writes, generation }),
  };
};

test('the caplet gives back one record’s read and conditional replace, and nothing else', async t => {
  const f = makeFixture();
  const credential = await makeCredential(f.pair, undefined, {
    env: {
      CREDENTIAL_BINDING_VERSION: '2',
      CREDENTIAL_SECRET_PATH: JSON.stringify(secretPath),
      CREDENTIAL_LABEL: 'Codex',
    },
  });
  // eslint-disable-next-line no-underscore-dangle
  const methods = await /** @type {any} */ (credential).__getMethodNames__();
  t.deepEqual([...methods].sort(), [
    '__getInterfaceGuard__',
    '__getMethodNames__',
    'describe',
    'help',
    'readBase64',
    'readBase64WithGeneration',
    'replaceBase64',
  ]);
  // The three SecretAdmin methods that would let a renewing backend destroy or
  // rewrite the operator's credential are simply not on the facet.
  t.false(methods.includes('revoke'));
  t.false(methods.includes('delete'));
  t.false(methods.includes('setDescription'));
});

for (const stage of ['store', 'mint']) {
  for (const cleanupFails of [false, true]) {
    test(`${stage} failure preserves its reason when temporary cleanup ${cleanupFails ? 'fails' : 'succeeds'}`, async t => {
      const primary = Error('original provisioning failure');
      const cleanup = Error('temporary cleanup failure');
      const f = makeFixture({
        faults: { [stage]: primary, ...(cleanupFails ? { cleanup } : {}) },
      });
      const error = await t.throwsAsync(() =>
        provideManagedRenewableCredentials(f.host, {
          namePath: ['codex-sandbox', 'credential'],
          secretPath,
        }),
      );
      if (cleanupFails) {
        if (!(error instanceof AggregateError))
          throw Error('Expected both failures');
        t.deepEqual(error.errors, [primary, cleanup]);
        t.is(error.errors[0], primary);
        t.is(error.errors[1], cleanup);
      } else {
        t.is(error, primary);
      }
      t.is(f.bindings.size, cleanupFails ? 1 : 0);
      t.is(f.calls.length, stage === 'mint' ? 1 : 0);
      t.deepEqual(f.state(), { reads: 0, writes: 0, generation: 4n });
    });
  }
}

test('reads carry the generation a write-back pins to', async t => {
  const f = makeFixture();
  const credential = await makeCredential(f.pair, undefined, {
    env: { CREDENTIAL_BINDING_VERSION: '2' },
  });
  const read = await credential.readBase64WithGeneration();
  t.is(read.generation, 4n);
  t.is(await credential.replaceBase64(btoa('next'), { ifGeneration: 4n }), 5n);
  t.is(f.state().writes, 1);
  await t.throwsAsync(
    credential.replaceBase64(btoa('again'), { ifGeneration: 4n }),
    { message: /wrong generation/ },
  );
});

test('a misspelled precondition is refused, not silently promoted to a blind write', async t => {
  const f = makeFixture();
  const credential = await makeCredential(f.pair, undefined, {
    env: { CREDENTIAL_BINDING_VERSION: '2' },
  });
  // The exo guard refuses synchronously, before the call reaches the admin.
  t.throws(
    // @ts-expect-error deliberately misspelled
    () => credential.replaceBase64(btoa('next'), { ifGeneraton: 4n }),
    { message: /replaceBase64/ },
  );
  t.is(f.state().writes, 0);
});

test('a secret outside the catalog is refused at construction', async t => {
  const f = makeFixture();
  await t.throwsAsync(
    makeCredential(
      harden({ host: f.host, secret: Far('ForeignSecret', {}) }),
      undefined,
      {
        env: { CREDENTIAL_BINDING_VERSION: '2' },
      },
    ),
    { message: /unknown secret facet/ },
  );
});

test('the pinned path must be a pet name path', t => {
  t.deepEqual(readCredentialSecretPath(JSON.stringify(secretPath)), secretPath);
  t.deepEqual(readCredentialSecretPath(secretPath), secretPath);
  for (const bad of [
    '',
    '[]',
    JSON.stringify(['secrets', '../escape']),
    '{}',
  ]) {
    t.throws(() => readCredentialSecretPath(bad), {
      message: /CREDENTIAL_SECRET_PATH/,
    });
  }
});

test('provisioning mints once and then adopts', async t => {
  const f = makeFixture();
  t.deepEqual(
    await provideManagedRenewableCredentials(f.host, {
      namePath: ['codex-sandbox', 'credential'],
      secretPath,
      label: 'Codex',
    }),
    { minted: true },
  );
  const [[, worker, specifier, options]] = f.calls;
  t.is(worker, '@main');
  t.is(specifier, renewableCredentialsSpecifier);
  t.regex(options.powersName, /^renewable-credential-powers\./);
  t.false(f.bindings.has(key(options.powersName)));
  t.deepEqual(options.env, {
    CREDENTIAL_BINDING_VERSION: '2',
    CREDENTIAL_SECRET_PATH: JSON.stringify(secretPath),
    CREDENTIAL_LABEL: 'Codex',
  });
  t.deepEqual(
    await provideManagedRenewableCredentials(f.host, {
      namePath: ['codex-sandbox', 'credential'],
      secretPath,
      label: 'Codex',
    }),
    { minted: false },
  );
  t.is(f.calls.length, 1);
});

test('adoption refuses a dynamic powers recipe before evaluating it', async t => {
  const f = makeFixture({
    bound: true,
    faults: { lookup: Error('must not evaluate') },
  });
  f.formulas.set('powers-id', { type: 'make-unconfined' });
  await t.throwsAsync(
    () =>
      readManagedRenewableCredentials(f.host, {
        namePath: ['codex-sandbox', 'credential'],
      }),
    { message: /must be a marshalled dependency pair/ },
  );
  t.is(f.calls.length, 0);
  t.deepEqual(f.state(), { reads: 0, writes: 0, generation: 4n });
});

const invalidRecipes = [
  ['dynamic secret', 'secret-id', { type: 'make-unconfined', properties: {} }],
  ['missing slots', 'powers-id', { type: 'marshal', properties: {} }],
  [
    'extra slot',
    'powers-id',
    {
      type: 'marshal',
      properties: {
        slots: {
          kind: 'reference-list',
          entries: { 0: 'host-id', 1: 'secret-id', 2: 'extra-id' },
        },
      },
    },
  ],
  [
    'duplicate slot',
    'powers-id',
    {
      type: 'marshal',
      properties: {
        slots: {
          kind: 'reference-list',
          entries: { 0: 'host-id', 1: 'host-id' },
        },
      },
    },
  ],
  [
    'foreign host slot',
    'powers-id',
    {
      type: 'marshal',
      properties: {
        slots: {
          kind: 'reference-list',
          entries: { 0: 'foreign-host', 1: 'secret-id' },
        },
      },
    },
  ],
  ['dynamic host', 'host-id', { type: 'make-unconfined', properties: {} }],
  ...[
    ['mutable alias', 'host-id', ['secrets', 'subscription']],
    ['other host', 'other-host', ['@secrets', 'use', secretGrant]],
    ['catalog authority', 'host-id', ['@secrets', 'catalog', secretGrant]],
    ['empty grant', 'host-id', ['@secrets', 'use', '']],
  ].map(([name, hub, path]) => [
    name,
    'secret-id',
    {
      type: 'lookup',
      properties: {
        hub: { kind: 'reference', identifier: hub },
        path: { kind: 'literal', value: path },
      },
    },
  ]),
];

for (const [name, id, formula] of invalidRecipes) {
  for (const phase of ['adopt', 'mint']) {
    test(`${phase} refuses ${name} before evaluation or mint`, async t => {
      const f = makeFixture({
        bound: phase === 'adopt',
        faults: phase === 'mint' ? { storedFormula: { id, formula } } : {},
      });
      if (phase === 'adopt') f.formulas.set(id, formula);
      await t.throwsAsync(
        () =>
          provideManagedRenewableCredentials(f.host, {
            namePath: ['codex-sandbox', 'credential'],
            secretPath,
          }),
        { message: /static Secret grant recipes|host recipe is invalid/ },
      );
      t.is(f.lookupCount(), 0);
      t.is(f.calls.length, 0);
      t.is(f.bindings.size, phase === 'adopt' ? 1 : 0);
      t.deepEqual(f.state(), { reads: 0, writes: 0, generation: 4n });
    });
  }
}

test('reconstruction uses the retained pair and setup refuses an alias replacement', async t => {
  const f = makeFixture({ bound: true });
  f.rebind();
  const credential = await makeCredential(Promise.resolve(f.pair), undefined, {
    env: { CREDENTIAL_BINDING_VERSION: '2' },
  });
  t.is(await credential.readBase64(), btoa('token'));
  t.is(await credential.replaceBase64(btoa('next'), { ifGeneration: 4n }), 5n);
  await t.throwsAsync(
    provideManagedRenewableCredentials(f.host, {
      namePath: ['codex-sandbox', 'credential'],
      secretPath,
    }),
    { message: /secret identity changed/ },
  );
  t.is(f.calls.length, 0);
});

test('legacy path-only construction and adoption refuse before credential access', async t => {
  const f = makeFixture({ bound: true });
  f.environments.get('existing-id').CREDENTIAL_BINDING_VERSION = '1';
  await t.throwsAsync(
    makeCredential(f.host, undefined, {
      env: { CREDENTIAL_SECRET_PATH: JSON.stringify(secretPath) },
    }),
    { message: /Legacy renewable credential binding/ },
  );
  await t.throwsAsync(
    provideManagedRenewableCredentials(f.host, {
      namePath: ['codex-sandbox', 'credential'],
      secretPath,
    }),
    { message: /legacy path-only binding/ },
  );
  t.deepEqual(f.state(), { reads: 0, writes: 0, generation: 4n });
  t.is(f.calls.length, 0);
});

test('an existing credential is adopted when its pinned record is unchanged', async t => {
  const f = makeFixture({ bound: true });
  t.deepEqual(
    await provideManagedRenewableCredentials(f.host, {
      namePath: ['codex-sandbox', 'credential'],
      secretPath,
      label: 'Codex',
    }),
    { minted: false },
  );
  t.is(f.calls.length, 0);
});

test('re-pointing a live credential at another record fails closed', async t => {
  // The guard HOSTED-SUBSCRIPTION.md calls "setup refuses an existing backend
  // before reading or changing its credential", kept when the one-shot refusal
  // around it goes away so setup can run on every daemon start.
  const f = makeFixture({ bound: true, boundPath: ['secrets', 'other-auth'] });
  await t.throwsAsync(
    provideManagedRenewableCredentials(f.host, {
      namePath: ['codex-sandbox', 'credential'],
      secretPath,
      label: 'Codex',
    }),
    { message: /is pinned to .*other-auth.*not/s },
  );
  t.is(f.calls.length, 0);
});
