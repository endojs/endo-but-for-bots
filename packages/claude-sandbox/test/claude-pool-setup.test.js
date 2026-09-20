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

const fixture = () => {
  const entries = new Map();
  const writes = [];
  const secrets = new Map(
    declaration.map(member => [member.credsName, `secret:${member.id}`]),
  );
  const namespace = harden({
    has: async name => entries.has(name),
    locate: async name => entries.get(name),
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
    locate: async (_dir, name) => secrets.get(name),
    provideGuest: async () => {
      writes.push('guest');
      present = true;
    },
    move: async () => {},
  });
  return { host, entries, writes, secrets };
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
  const prepared = await prepareClaudePool(host, read());
  t.deepEqual(writes, []);
  await prepared.publish();
  t.is(entries.get('secret-second'), 'secret:second');
  t.deepEqual(entries.get('subscriptions'), read().set);
  entries.set('pool-state-v1-test', 'kept');
  await (await prepareClaudePool(host, read())).publish();
  t.is(writes.filter(name => name === 'guest').length, 1);
  t.is(entries.get('pool-state-v1-test'), 'kept');
});

test('missing, aliased and rebound secrets fail before any write', async t => {
  const { host, secrets, writes } = fixture();
  secrets.delete('claude-subscription-2');
  await t.throwsAsync(() => prepareClaudePool(host, read()), {
    message: /missing from Secrets/,
  });
  t.deepEqual(writes, []);
  secrets.set('claude-subscription-2', 'secret:first');
  await t.throwsAsync(() => prepareClaudePool(host, read()), {
    message: /distinct SecretBlobs/,
  });
  t.deepEqual(writes, []);
  secrets.set('claude-subscription-2', 'secret:second');
  await (await prepareClaudePool(host, read())).publish();
  writes.length = 0;
  secrets.set('claude-subscription-2', 'secret:replacement');
  await t.throwsAsync(() => prepareClaudePool(host, read()), {
    message: /another secret/,
  });
  t.deepEqual(writes, []);
});
