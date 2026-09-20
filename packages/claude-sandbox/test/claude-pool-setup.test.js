// @ts-check
import '@endo/init';
import test from 'ava';

import { prepareClaudePool, readClaudePool } from '../src/claude-pool-setup.js';

const declaration = harden([
  { id: 'first', credsName: 'claude-creds' },
  { id: 'second', label: 'Second account', credsName: 'claude-subscription-2' },
]);
/** @param {any} [members] @param {Record<string, string>} [extra] */
const read = (members = declaration, extra = {}) => {
  const pool = readClaudePool({
    ENDO_CLAUDE_SUBSCRIPTIONS: JSON.stringify(members),
    ...extra,
  });
  if (pool === undefined) throw Error('Expected pool');
  return pool;
};

const prepare = (host, pool) =>
  prepareClaudePool(host, pool, {
    provideCredential: async () => ({ minted: true }),
  });

const fixture = () => {
  const entries = new Map();
  const writes = [];
  const secrets = new Map(
    declaration.map(member => [member.credsName, `secret:${member.id}`]),
  );
  const namespace = harden({
    has: async name => entries.has(name),
    identify: async name => entries.get(name)?.replace(/^host-route:/, ''),
    locate: async name =>
      `guest-route:${entries.get(name)?.replace(/^host-route:/, '')}`,
    storeIdentifier: async (name, identifier) => {
      writes.push(name);
      entries.set(name, `host-route:${identifier}`);
    },
    storeLocator: async (name, locator) => {
      writes.push(name);
      entries.set(name, locator);
    },
    storeValue: async (value, name) => {
      writes.push(name);
      entries.set(name, value);
    },
  });
  let present = false;
  const host = harden({
    has: async (...parts) =>
      parts[0] === 'secrets'
        ? secrets.has(parts[1])
        : parts[1] === 'broker-powers' && present,
    lookup: async () => namespace,
    identify: async (dir, name) =>
      dir === 'secrets' ? secrets.get(name) : `holder:${name}`,
    locate: async (dir, name) =>
      dir === 'secrets' ? `host-route:${secrets.get(name)}` : `holder:${name}`,
    provideGuest: async () => {
      writes.push('guest');
      present = true;
    },
    move: async () => {},
  });
  return { host, namespace, entries, writes, secrets };
};

test('pool declarations contain only secret references and validate the whole set', t => {
  t.is(readClaudePool({}), undefined);
  t.is(read().set.cacheLifetimeSeconds, 300);
  t.deepEqual(read().secrets, ['claude-creds', 'claude-subscription-2']);
  for (const members of [
    [],
    [null],
    [{ id: 'auto', credsName: 'a' }],
    [{ id: 'a', credsName: 'a', token: 'not-accepted' }],
    [{ id: 'a', credsName: '../a' }],
    [declaration[0], declaration[0]],
    [
      { id: 'a', credsName: 'a' },
      { id: 'b', credsName: 'a' },
    ],
  ]) {
    t.throws(() => read(members));
  }
  t.throws(() =>
    read(declaration, { ENDO_CLAUDE_CACHE_LIFETIME_SECONDS: '-1' }),
  );
  const error = t.throws(() =>
    readClaudePool({ ENDO_CLAUDE_SUBSCRIPTIONS: 'sensitive-invalid-json' }),
  );
  t.false(error.message.includes('sensitive-invalid-json'));
});

test('pool publication retains namespace, secrets and pool journal across setup', async t => {
  const { host, entries, writes } = fixture();
  const prepared = await prepare(host, read());
  t.deepEqual(writes, []);
  await prepared.publish();
  t.is(entries.get('secret-second'), 'host-route:secret:second');
  t.deepEqual(entries.get('subscriptions'), read().set);
  entries.set('pool-state-v1-test', 'kept');
  t.is(entries.get('credential-second'), 'holder:credential-second');
  await (await prepare(host, read())).publish();
  t.is(writes.filter(name => name === 'guest').length, 1);
  t.is(entries.get('pool-state-v1-test'), 'kept');
});

test('restart compares formula identities, not host and guest locator routes', async t => {
  const { host, namespace, writes } = fixture();
  await (await prepare(host, read())).publish();
  t.not(
    await host.locate('secrets', 'claude-subscription-2'),
    await namespace.locate('secret-second'),
  );
  t.is(
    await host.identify('secrets', 'claude-subscription-2'),
    await namespace.identify('secret-second'),
  );
  await (await prepare(host, read())).publish();
  t.is(writes.filter(name => name === 'guest').length, 1);
});

test('missing, aliased and rebound secrets fail before any write', async t => {
  const { host, secrets, writes } = fixture();
  secrets.delete('claude-subscription-2');
  await t.throwsAsync(() => prepare(host, read()), {
    message: /missing from Secrets/,
  });
  t.deepEqual(writes, []);
  secrets.set('claude-subscription-2', 'secret:first');
  await t.throwsAsync(() => prepare(host, read()), {
    message: /distinct SecretBlobs/,
  });
  t.deepEqual(writes, []);
  secrets.set('claude-subscription-2', 'secret:second');
  await (await prepare(host, read())).publish();
  writes.length = 0;
  secrets.set('claude-subscription-2', 'secret:replacement');
  await t.throwsAsync(() => prepare(host, read()), {
    message: /another secret/,
  });
  t.deepEqual(writes, []);
});

test('retained renewal holder cannot silently move to another Secrets record', async t => {
  const { host, writes } = fixture();
  const withHolder = harden({
    ...host,
    has: async (...parts) =>
      parts[0] === 'claude-sandbox' && parts[1] === 'credential-second'
        ? true
        : host.has(...parts),
  });
  await t.throwsAsync(
    () =>
      prepareClaudePool(withHolder, read(), {
        readCredential: async () => ({
          identifier: 'retained',
          secretPath: ['secrets', 'another-secret'],
        }),
      }),
    { message: /pinned to another secret/ },
  );
  t.deepEqual(writes, []);
});

test('missing formula identity fails before writes', async t => {
  const { host, writes } = fixture();
  await t.throwsAsync(
    () => prepare(harden({ ...host, identify: async () => undefined }), read()),
    {
      message: /no formula identity/,
    },
  );
  t.deepEqual(writes, []);
});

test('publication retains the raw formula identity captured during preflight', async t => {
  const { host, secrets, namespace } = fixture();
  const prepared = await prepare(host, read());
  secrets.set('claude-subscription-2', 'secret:replacement');
  await prepared.publish();
  t.is(await namespace.identify('secret-second'), 'secret:second');
});
