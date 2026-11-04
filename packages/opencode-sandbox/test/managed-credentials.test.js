// @ts-check
import '@endo/init';
import test from 'ava';
import { makeExo } from '@endo/exo';
import { make } from '@endo/hosted-agent/managed-credentials-module.js';
import { M } from '@endo/patterns';

import { provideManagedCredentials } from '../src/managed-credentials.js';

test('managed grants read the current secret once and fail closed on revocation', async t => {
  let value = 'first';
  let revoked = false;
  let reads = 0;
  const secret = makeExo(
    'TestSecret',
    M.interface('TestSecret', {
      readBase64: M.call().returns(M.promise()),
    }),
    {
      async readBase64() {
        reads += 1;
        if (revoked) throw Error('REVOKED');
        return btoa(value);
      },
    },
  );
  const credentials = make(secret, null, {
    env: { CREDENTIALS_KIND: 'apiKey', CREDENTIALS_LABEL: 'OpenRouter' },
  });
  t.is(credentials.storage(), 'secrets-manager');
  t.is(credentials.kind(), 'apiKey');
  const grant = await credentials.issue('one');
  value = 'rotated';
  t.is(await grant.materialise(), 'rotated');
  await t.throwsAsync(() => grant.materialise(), { message: /single-shot/ });
  t.is(reads, 1);
  const denied = await credentials.issue('two');
  revoked = true;
  await t.throwsAsync(() => denied.materialise(), { message: /REVOKED/ });
  const sessionRevoked = await credentials.issue('three');
  await credentials.revoke('three');
  await t.throwsAsync(() => sessionRevoked.materialise(), {
    message: /revoked/,
  });
  t.is(reads, 2);
});

test('honors the configured kind and rejects unknown kinds', async t => {
  const secret = makeExo(
    'TestSecret',
    M.interface('TestSecret', {
      readBase64: M.call().returns(M.promise()),
    }),
    {
      async readBase64() {
        return btoa('token');
      },
    },
  );
  t.is(
    make(secret, null, { env: { CREDENTIALS_KIND: 'oauthToken' } }).kind(),
    'oauthToken',
  );
  t.throws(() => make(secret, null, { env: { CREDENTIALS_KIND: 'other' } }), {
    message: /Invalid credential kind/,
  });
});

test('bounds outstanding grants', async t => {
  const secret = makeExo(
    'TestSecret',
    M.interface('TestSecret', {
      readBase64: M.call().returns(M.promise()),
    }),
    {
      async readBase64() {
        return btoa('token');
      },
    },
  );
  const credentials = make(secret, null, {
    env: { CREDENTIALS_KIND: 'apiKey', CREDENTIALS_LABEL: 'OpenRouter' },
  });
  await Promise.all(
    Array.from({ length: 128 }, (_unused, index) =>
      credentials.issue(`tag-${index}`),
    ),
  );
  await t.throwsAsync(() => credentials.issue('overflow'), {
    message: /Too many outstanding/,
  });
});

const wrapperPath = '@pins/installations/credentials/openrouter-auth';
const setupFixture = ({ legacy = false, hasSecret = false } = {}) => {
  const secret = {};
  const wrapper = make(secret, null, {
    env: { CREDENTIALS_KIND: 'apiKey', CREDENTIALS_LABEL: 'OpenRouter' },
  });
  const bindings = new Map();
  if (legacy) bindings.set('openrouter-auth', wrapper);
  const entries = hasSecret
    ? [{ petNamePaths: [['secrets', 'openrouter-auth']] }]
    : [];
  /** @type {{imports: unknown[][], mints: Array<{powersName: string[], resultName: string[], env: Record<string, string>}>}} */
  const calls = { imports: [], mints: [] };
  const key = (...names) => names.flat().join('/');
  const host = {
    has: (...names) => bindings.has(key(...names)),
    identify: (...names) => bindings.get(key(...names)),
    /** @param {string[]} names */
    provideDirectory: names => {
      for (let n = 1; n <= names.length; n += 1) {
        const prefix = key(names.slice(0, n));
        if (!bindings.has(prefix)) bindings.set(prefix, {});
      }
    },
    lookup: names => {
      if (key(names) === '@secrets/catalog')
        return harden({ list: async () => entries });
      if (key(names) === '@secrets/create')
        return harden({
          createBase64: async (...args) => {
            calls.imports.push(args);
            entries.push({ petNamePaths: [['secrets', 'openrouter-auth']] });
          },
        });
      return bindings.get(key(names));
    },
    copy: (from, to) => bindings.set(key(to), bindings.get(key(from))),
    remove: (...names) => bindings.delete(key(...names)),
    makeUnconfined: (_worker, _module, options) => {
      calls.mints.push(options);
      bindings.set(key(options.resultName), wrapper);
    },
  };
  return { host, calls, entries, bindings, wrapper };
};
const spec = harden({
  name: 'openrouter-auth',
  apiKey: 'bootstrap',
  kind: 'apiKey',
});
test('fresh setup delegates only SecretBlob and leaves no root helper names', async t => {
  const w = setupFixture();
  await provideManagedCredentials(w.host, spec);
  t.is(w.calls.imports.length, 1);
  t.deepEqual(w.calls.mints[0].powersName, ['secrets', 'openrouter-auth']);
  t.deepEqual(w.calls.mints[0].env, {
    CREDENTIALS_KIND: 'apiKey',
    CREDENTIALS_LABEL: 'OpenRouter',
  });
  t.is(w.bindings.get(wrapperPath), w.wrapper);
  t.false(
    [...w.bindings.keys()].some(
      name => name !== '@pins' && !name.startsWith('@pins/'),
    ),
  );
  const size = w.bindings.size;
  w.entries.length = 0;
  await provideManagedCredentials(w.host, spec);
  t.is(w.bindings.size, size);
  t.is(w.calls.imports.length, 1);
  t.is(w.calls.mints.length, 1);
});
test('legacy wrapper migration preserves identity without importing or minting', async t => {
  const w = setupFixture({ legacy: true });
  await provideManagedCredentials(w.host, spec);
  t.is(w.bindings.get(wrapperPath), w.wrapper);
  t.false(w.bindings.has('openrouter-auth'));
  t.deepEqual(w.calls, { imports: [], mints: [] });
});
test('existing secret is never overwritten from bootstrap environment', async t => {
  const w = setupFixture({ hasSecret: true });
  await provideManagedCredentials(w.host, spec);
  t.is(w.calls.imports.length, 0);
  t.is(w.calls.mints.length, 1);
});
test('conflicting or invalid legacy objects are not removed', async t => {
  const w = setupFixture({ legacy: true });
  w.bindings.set(wrapperPath, {});
  await t.throwsAsync(provideManagedCredentials(w.host, spec), {
    message: /Conflicting/,
  });
  t.is(w.bindings.get('openrouter-auth'), w.wrapper);
  w.bindings.delete(wrapperPath);
  const bad = makeExo(
    'Impostor',
    M.interface('Impostor', { storage: M.call().returns(M.string()) }),
    { storage: () => 'secrets-manager' },
  );
  w.bindings.set('openrouter-auth', bad);
  await t.throwsAsync(provideManagedCredentials(w.host, spec), {
    message: /not a managed credential/,
  });
  t.is(w.bindings.get('openrouter-auth'), bad);
});

test('rejects reserved credential names', async t => {
  const host = {};
  await t.throwsAsync(
    provideManagedCredentials(host, { name: 'secrets', kind: 'apiKey' }),
    { message: /Reserved credential name/ },
  );
  await t.throwsAsync(
    provideManagedCredentials(host, {
      name: 'other-secret-read',
      kind: 'apiKey',
    }),
    { message: /Reserved credential name/ },
  );
});
