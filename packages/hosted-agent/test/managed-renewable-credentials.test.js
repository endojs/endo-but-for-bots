// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';

import { Far } from '@endo/far';

import {
  make as makeCredential,
  readCredentialSecretPath,
} from '../src/managed-renewable-credentials-module.js';
import {
  provideManagedRenewableCredentials,
  renewableCredentialsSpecifier,
} from '../src/managed-renewable-credentials.js';

const key = (...parts) => JSON.stringify(parts.flat());

const secretPath = ['secrets', 'codex-subscription-auth'];

const makeFixture = ({ bound = false, boundPath = secretPath } = {}) => {
  const bindings = new Map();
  const formulas = new Map();
  const environments = new Map();
  /** @type {any[]} */
  const calls = [];
  let reads = 0;
  let writes = 0;
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
  });
  if (bound) {
    bindings.set(key(['codex-sandbox', 'credential']), 'existing-id');
    formulas.set('existing-id', {
      type: 'make-unconfined',
      properties: {
        specifier: { kind: 'literal', value: renewableCredentialsSpecifier },
      },
    });
    environments.set('existing-id', {
      CREDENTIAL_SECRET_PATH: JSON.stringify(boundPath),
      CREDENTIAL_LABEL: 'Codex',
    });
  }
  const host = Far('Host', {
    has: async (...parts) => bindings.has(key(...parts)),
    identify: async (...parts) => bindings.get(key(...parts)),
    diagnostics: async () =>
      Far('Diagnostics', { getFormula: async id => formulas.get(id) }),
    getFormulaEnvironment: async id => environments.get(id),
    lookup: async path => {
      const parts = Array.isArray(path) ? path : [path];
      if (parts[0] === '@secrets') return catalog;
      if (key(parts) === key(secretPath)) return secret;
      throw Error(`unexpected lookup ${key(parts)}`);
    },
    makeUnconfined: async (worker, specifier, options) => {
      calls.push(['mint', worker, specifier, options]);
      bindings.set(key(options.resultName), 'minted');
    },
  });
  return {
    host,
    calls,
    secret,
    admin,
    state: () => ({ reads, writes, generation }),
  };
};

test('the caplet gives back one record’s read and conditional replace, and nothing else', async t => {
  const f = makeFixture();
  const credential = await makeCredential(f.host, undefined, {
    env: {
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

test('reads carry the generation a write-back pins to', async t => {
  const f = makeFixture();
  const credential = await makeCredential(f.host, undefined, {
    env: { CREDENTIAL_SECRET_PATH: JSON.stringify(secretPath) },
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
  const credential = await makeCredential(f.host, undefined, {
    env: { CREDENTIAL_SECRET_PATH: JSON.stringify(secretPath) },
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
    makeCredential(f.host, undefined, {
      env: { CREDENTIAL_SECRET_PATH: JSON.stringify(['secrets', 'other']) },
    }),
    { message: /not in the secrets catalog/ },
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
  t.is(options.powersName, '@agent');
  t.deepEqual(options.env, {
    CREDENTIAL_SECRET_PATH: JSON.stringify(secretPath),
    CREDENTIAL_LABEL: 'Codex',
  });
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
