// @ts-check
import '@endo/init';
import test from 'ava';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';

import { make } from '../src/managed-credentials-module.js';
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
    env: { CREDENTIALS_KIND: 'apiKey' },
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
    env: { CREDENTIALS_KIND: 'apiKey' },
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

test('setup imports into the catalog and delegates only SecretBlob, never the token or admin', async t => {
  const bindings = new Map();
  const calls = [];
  const host = {
    has: async name => bindings.has(name),
    lookup: async path => {
      if (path[1] === 'catalog') return harden({ list: async () => [] });
      return harden({
        createBase64: async (...args) => {
          calls.push(args);
        },
      });
    },
    copy: async (from, to) => {
      t.deepEqual(from, ['secrets', 'openrouter-auth']);
      bindings.set(to[0], true);
    },
    remove: async name => {
      bindings.delete(name);
    },
    makeUnconfined: async (_worker, url, options) => {
      t.true(url.endsWith('/managed-credentials-module.js'));
      t.deepEqual(options, {
        powersName: 'openrouter-auth-secret-read',
        resultName: 'openrouter-auth',
        env: { CREDENTIALS_KIND: 'apiKey' },
      });
      bindings.set(options.resultName, true);
    },
  };
  await provideManagedCredentials(host, {
    name: 'openrouter-auth',
    apiKey: 'test-token',
    kind: 'apiKey',
  });
  t.deepEqual(calls, [
    ['openrouter-auth', 'OpenRouter apiKey', btoa('test-token')],
  ]);
  t.false(bindings.has('openrouter-auth-secret-read'));
  t.true(bindings.has('openrouter-auth'));
});

test('startup never reimports a managed credential, even if its catalog entry was deleted', async t => {
  let lookups = 0;
  const host = {
    has: async () => true,
    lookup: async name => {
      lookups += 1;
      t.is(name, 'openrouter-auth');
      return make({}, null, { env: { CREDENTIALS_KIND: 'apiKey' } });
    },
  };
  await provideManagedCredentials(host, {
    name: 'openrouter-auth',
    apiKey: 'stale-env-token',
    kind: 'apiKey',
  });
  t.is(lookups, 1);
});

test('setup skips createBase64 when the catalog already administers the secret', async t => {
  const bindings = new Map([['openrouter-auth-secret-read', true]]);
  let creates = 0;
  const host = {
    has: async name => bindings.has(name),
    lookup: async path => {
      if (path[1] === 'catalog') {
        return harden({
          list: async () => [
            {
              petNamePaths: [['other'], ['secrets', 'openrouter-auth']],
            },
          ],
        });
      }
      return harden({
        createBase64: async () => {
          creates += 1;
        },
      });
    },
    copy: async (from, to) => {
      t.deepEqual(from, ['secrets', 'openrouter-auth']);
      bindings.set(to[0], true);
    },
    remove: async name => {
      bindings.delete(name);
    },
    makeUnconfined: async (_worker, _url, options) => {
      bindings.set(options.resultName, true);
    },
  };
  await provideManagedCredentials(host, {
    name: 'openrouter-auth',
    apiKey: 'stale-env-token',
    kind: 'apiKey',
  });
  t.is(creates, 0);
  t.true(bindings.has('openrouter-auth'));
  t.false(bindings.has('openrouter-auth-secret-read'));
});

test('refuses a credential name bound to a non-managed object', async t => {
  const impostor = makeExo(
    'Impostor',
    M.interface('Impostor', {
      storage: M.call().returns(M.string()),
      kind: M.call().returns(M.string()),
    }),
    {
      storage: () => 'secrets-manager',
      kind: () => 'apiKey',
    },
  );
  const removed = [];
  const host = {
    has: async () => true,
    lookup: async () => impostor,
    remove: async name => removed.push(name),
  };
  await t.throwsAsync(
    provideManagedCredentials(host, {
      name: 'openrouter-auth',
      kind: 'apiKey',
    }),
    { message: /not a managed credential/ },
  );
  t.deepEqual(removed, []);
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
