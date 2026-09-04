// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';
import { Far } from '@endo/far';
import { encodeBase64 } from '@endo/base64/encode.js';
import { encodeUtf8 } from '@endo/utf8/encode.js';

import {
  AUTH_SECRET_PETNAME,
  encodeAuthToken,
  provideAuthSecret,
  readAuthToken,
  resolveAuthToken,
} from '../src/credentials.js';

const TOKEN = 'sk-ant-not-a-real-key';

/** @param {string} base64 */
const makeBlob = base64 =>
  Far('SecretBlob', {
    readBase64: async () => base64,
    getDescription: async () => 'test token',
    help: () => 'test blob',
  });

test('a provider token round-trips through the base64 wire envelope', async t => {
  const blob = makeBlob(encodeAuthToken(TOKEN));
  t.is(await readAuthToken(blob), TOKEN);
});

test('encoding rejects an empty or oversized token', t => {
  t.throws(() => encodeAuthToken(''), { message: /non-empty string/ });
  t.throws(() => encodeAuthToken(/** @type {any} */ (undefined)), {
    message: /non-empty string/,
  });
  t.throws(() => encodeAuthToken('x'.repeat(8193)), { message: /at most/ });
});

test('reading rejects a payload that is not a plausible token', async t => {
  await t.throwsAsync(readAuthToken(makeBlob('not base64 !!!')), {
    message: /not valid base64/,
  });
  await t.throwsAsync(readAuthToken(makeBlob('')), {
    message: /holds no bytes/,
  });
  await t.throwsAsync(
    readAuthToken(makeBlob(encodeBase64(encodeUtf8('x'.repeat(8193))))),
    { message: /not a provider token/ },
  );
  await t.throwsAsync(
    readAuthToken(Far('SecretBlob', { readBase64: async () => 42 })),
    { message: /non-string payload/ },
  );
});

test('a revoked secret makes the next read fail rather than the next setup', async t => {
  const revoked = Far('SecretBlob', {
    readBase64: async () => {
      throw Error('SECRET_REVOKED');
    },
  });
  await t.throwsAsync(readAuthToken(revoked), { message: /SECRET_REVOKED/ });
});

test('the secret capability wins over an inline token', async t => {
  const powers = Far('Powers', {
    has: async name => name === AUTH_SECRET_PETNAME,
    lookup: async () => makeBlob(encodeAuthToken(TOKEN)),
  });
  t.is(
    await resolveAuthToken({
      powers,
      config: { authToken: 'stale-plaintext' },
    }),
    TOKEN,
  );
});

test('an inline token is still honoured when no secret is endowed', async t => {
  const powers = Far('Powers', {
    has: async () => false,
    lookup: async () => {
      throw Error('should not be reached');
    },
  });
  t.is(
    await resolveAuthToken({ powers, config: { authToken: 'legacy' } }),
    'legacy',
  );
  t.is(await resolveAuthToken({ powers, config: {} }), '');
});

test('provideAuthSecret creates a record the first time', async t => {
  /** @type {any[]} */
  const created = [];
  const hostAgent = Far('HostAgent', {
    has: async () => false,
    lookup: async path => {
      t.deepEqual(path, ['@secrets', 'create']);
      return Far('SecretImporter', {
        createBase64: async (name, description, payload) => {
          created.push({ name, description, payload });
          return harden({ secretId: 'id', description });
        },
      });
    },
    locate: async () => 'endo://node/formula?type=lookup',
  });
  const result = await provideAuthSecret({
    hostAgent,
    name: 'floot-auth',
    description: 'Floot anthropic provider auth token',
    token: TOKEN,
  });
  t.true(result.created);
  t.is(result.secretName, 'floot-auth');
  t.is(created.length, 1);
  t.is(created[0].payload, encodeAuthToken(TOKEN));
  // The description is metadata, never the credential.
  t.false(created[0].description.includes(TOKEN));
});

test('provideAuthSecret replaces in place rather than orphaning a record', async t => {
  /** @type {any[]} */
  const replaced = [];
  const admin = Far('SecretAdmin', {
    replaceBase64: async payload => {
      replaced.push(payload);
    },
    setDescription: async () => {},
  });
  const hostAgent = Far('HostAgent', {
    has: async (...path) => path.join('/') === 'secrets/floot-auth',
    lookup: async path => {
      t.deepEqual(path, ['@secrets', 'catalog']);
      return Far('SecretCatalog', {
        list: async () =>
          harden([
            {
              secretId: 'other',
              petNamePaths: harden([harden(['secrets', 'something-else'])]),
              admin: Far('OtherAdmin', {}),
            },
            {
              secretId: 'ours',
              petNamePaths: harden([harden(['secrets', 'floot-auth'])]),
              admin,
            },
          ]),
      });
    },
    locate: async () => 'endo://node/formula?type=lookup',
  });
  const result = await provideAuthSecret({
    hostAgent,
    name: 'floot-auth',
    description: 'Floot anthropic provider auth token',
    token: 'rotated-token',
  });
  t.false(result.created);
  t.deepEqual(replaced, [encodeAuthToken('rotated-token')]);
});

test('provideAuthSecret refuses a name the catalog does not administer', async t => {
  const hostAgent = Far('HostAgent', {
    has: async () => true,
    lookup: async () => Far('SecretCatalog', { list: async () => harden([]) }),
    locate: async () => 'endo://node/formula?type=lookup',
  });
  await t.throwsAsync(
    provideAuthSecret({
      hostAgent,
      name: 'floot-auth',
      description: 'x',
      token: TOKEN,
    }),
    { message: /does not administer/ },
  );
});
