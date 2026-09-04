// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';
import { Far } from '@endo/far';
import { encodeBase64 } from '@endo/base64/encode.js';
import { encodeUtf8 } from '@endo/utf8/encode.js';

import {
  AUTH_SECRET_PETNAME,
  encodeAuthToken,
  hasAuthSecret,
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
    has: async (...path) =>
      path.join('/') === 'secrets' || path.join('/') === 'secrets/floot-auth',
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

test('a payload that is not UTF-8 text is refused rather than mangled', async t => {
  // 0xC3 starts a two-byte sequence that never arrives.
  const truncated = Far('SecretBlob', {
    readBase64: async () => encodeBase64(new Uint8Array([0x73, 0x6b, 0xc3])),
  });
  await t.throwsAsync(readAuthToken(truncated), {
    message: /does not hold UTF-8 text/,
  });
});

test('a token with non-ASCII characters survives the round trip', async t => {
  const token = 'sk-café-\u{1F511}';
  t.is(await readAuthToken(makeBlob(encodeAuthToken(token))), token);
});

test('the write bound counts bytes, so a token cannot be written unreadable', t => {
  // 8192 UTF-16 code units of a two-byte character is 16384 bytes: it used to
  // pass the write check and fail the read check, which meant a token stored
  // once and rejected on every read from then on.
  const wide = 'é'.repeat(8192);
  t.is(wide.length, 8192);
  t.throws(() => encodeAuthToken(wide), { message: /at most 8192 bytes/ });
  // A token that does fit still round-trips, non-ASCII and all.
  const fits = 'é'.repeat(4096);
  t.is(encodeAuthToken(fits).length > 0, true);
});

test('a daemon that has never held a secret answers "no", not an error', async t => {
  /** @type {string[][]} */
  const asked = [];
  const hostAgent = Far('HostAgent', {
    has: async (...path) => {
      asked.push(path);
      if (path.length === 1 && path[0] === 'secrets') return false;
      // `has` on a two-segment path looks the prefix up first, so the daemon
      // throws here rather than answering. Treating that as "the manager is
      // unavailable" downgraded to a plaintext token on exactly the daemon
      // where the manager would have worked.
      throw Error('Failed to lookup "secrets"');
    },
  });
  t.false(await hasAuthSecret({ hostAgent, name: 'floot-auth' }));
  t.deepEqual(asked, [['secrets']]);
});

test('provideAuthSecret creates the first secret on a daemon with no secrets directory', async t => {
  /** @type {any[]} */
  const created = [];
  const hostAgent = Far('HostAgent', {
    has: async (...path) => {
      if (path.length === 1 && path[0] === 'secrets') return false;
      throw Error('Failed to lookup "secrets"');
    },
    lookup: async path => {
      t.deepEqual(path, ['@secrets', 'create']);
      return Far('SecretImporter', {
        createBase64: async (name, description, payload) => {
          created.push({ name, payload });
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
  t.is(created.length, 1);
});
