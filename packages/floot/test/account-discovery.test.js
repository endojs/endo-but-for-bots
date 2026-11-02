// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import { Far } from '@endo/far';
import { makeLatestTopic } from '@endo/hosted-agent/latest-topic.js';
import { iterateReader as iterateRemoteReader } from '@endo/exo-stream/iterate-reader.js';
import { discoverAccounts, accountResetKey } from '../src/account-discovery.js';
import { makeAccountsWatch } from '../src/account-watch.js';

const oracle = Far('Oracle', {
  watch: () => {
    throw Error('No stream in discovery test');
  },
  refresh: () => {},
});
const entry = (overrides = {}) => ({
  accountId: 'logical-account',
  providerId: 'vendor',
  title: 'Shared title',
  oracle,
  uses: [{ backendId: 'arbitrary-runtime', subscriptionId: 'member' }],
  ...overrides,
});
const profile = sources =>
  Far('Profile', {
    has: name => name === 'account-bindings',
    lookup: name => {
      if (name !== 'account-bindings')
        throw Error('Backend names must not be inferred');
      return Far('BindingDirectory', {
        list: () => [...sources.keys()],
        lookup: source => {
          const value = sources.get(source);
          if (value instanceof Error) throw value;
          return harden(value);
        },
      });
    },
  });
const record = accounts => ({ version: 1, accounts });

test('explicit sources merge uses and select a deterministic observer independent of backend names', async t => {
  const other = Far('OtherOracle', {});
  const admin = Far('Admin', {});
  const sources = new Map([
    [
      'z',
      record([
        entry({
          oracle: other,
          admin,
          adminId: 'admin-id',
          uses: [{ backendId: 'unrelated-runtime' }],
        }),
      ]),
    ],
    ['a', record([entry()])],
  ]);
  const result = await discoverAccounts(profile(sources));
  t.is(result.entries.length, 1);
  t.is(result.entries[0].oracle, oracle);
  t.is(result.entries[0].admin, admin);
  t.deepEqual(result.entries[0].sources, ['a', 'z']);
  t.deepEqual(result.entries[0].uses, [
    { backendId: 'arbitrary-runtime', subscriptionId: 'member' },
    { backendId: 'unrelated-runtime' },
  ]);
  t.deepEqual(result.unknown, []);
});

test('matching labels and member names do not merge distinct declared accounts', async t => {
  const result = await discoverAccounts(
    profile(
      new Map([
        ['one', record([entry()])],
        [
          'two',
          record([
            entry({ accountId: 'other-account', oracle: Far('Other', {}) }),
          ]),
        ],
      ]),
    ),
  );
  t.is(result.entries.length, 2);
});

test('one logical account shared by runtimes gets one follower and one refresh', async t => {
  t.timeout(5000);
  const topic = makeLatestTopic();
  topic.publish(harden({}));
  let watched = 0;
  let refreshed = 0;
  const shared = Far('SharedOracle', {
    watch: () => {
      watched += 1;
      return topic.watch();
    },
    refresh: () => {
      refreshed += 1;
    },
  });
  const watch = makeAccountsWatch({
    listOracles: () =>
      discoverAccounts(
        profile(
          new Map([
            ['first', record([entry({ oracle: shared })])],
            [
              'second',
              record([
                entry({
                  oracle: shared,
                  uses: [{ backendId: 'other-runtime' }],
                }),
              ]),
            ],
          ]),
        ),
      ),
  });
  t.teardown(async () => {
    topic.close();
    await watch.close();
  });
  const reader = iterateReader(watch.watch());
  let event;
  do {
    // eslint-disable-next-line no-await-in-loop
    event = (await reader.next()).value;
  } while (!event.accounts.length);
  t.is(event.accounts.length, 1);
  t.is(event.accounts[0].uses.length, 2);
  await watch.refresh();
  t.is(watched, 1);
  t.is(refreshed, 1);
});

test('conflicting reset authority refuses discovery instead of selecting a source', async t => {
  await t.throwsAsync(
    () =>
      discoverAccounts(
        profile(
          new Map([
            ['one', record([entry({ admin: Far('A', {}), adminId: 'a' })])],
            ['two', record([entry({ admin: Far('B', {}), adminId: 'b' })])],
          ]),
        ),
      ),
    { message: /Conflicting/ },
  );
});

test('unreadable source is explicit and removal is distinct from outage', async t => {
  const sources = new Map([['source', Error('unavailable')]]);
  t.deepEqual(await discoverAccounts(profile(sources)), {
    entries: [],
    unknown: ['source'],
  });
  sources.clear();
  t.deepEqual(await discoverAccounts(profile(sources)), {
    entries: [],
    unknown: [],
  });
});

test('setup withdrawal marker preserves only unknown-source provenance', async t => {
  t.deepEqual(
    await discoverAccounts(
      profile(
        new Map([['source', { version: 1, accounts: [], unavailable: true }]]),
      ),
    ),
    { entries: [], unknown: ['source'] },
  );
});

test('reset action revalidates pair identity and never spends stale or unknown authority', async t => {
  t.timeout(5000);
  const calls = [];
  const admin = id =>
    Far('Admin', {
      getResetState: () => ({}),
      consumeResetCredit: () => {
        calls.push(id);
        return id;
      },
      abandonResetIntent: () => {
        calls.push(`abandon-${id}`);
      },
    });
  /** @type {Map<string, any>} */
  const sources = new Map([
    ['source', record([entry({ admin: admin('old'), adminId: 'old' })])],
  ]);
  const watch = makeAccountsWatch({
    listOracles: () => discoverAccounts(profile(sources)),
    log: () => {},
  });
  t.teardown(() => watch.close());
  const oldKey = accountResetKey('logical-account', 'old');
  t.is(await watch.redeemReset(oldKey), 'old');
  sources.set(
    'source',
    record([entry({ admin: admin('new'), adminId: 'new' })]),
  );
  await t.throwsAsync(() => watch.redeemReset(oldKey), {
    message: /No banked reset/,
  });
  await t.throwsAsync(() => watch.abandonReset(oldKey), {
    message: /No banked reset/,
  });
  const newKey = accountResetKey('logical-account', 'new');
  t.is(await watch.redeemReset(newKey), 'new');
  sources.set('source', Error('outage'));
  await t.throwsAsync(() => watch.redeemReset(newKey), {
    message: /No banked reset/,
  });
  sources.clear();
  await t.throwsAsync(() => watch.redeemReset(newKey), {
    message: /No banked reset/,
  });
  t.deepEqual(calls, ['old', 'new']);
});

test('whole discovery failure clears reset authority rather than admitting cached action', async t => {
  t.timeout(5000);
  let failing = false;
  let spent = 0;
  const admin = Far('Admin', {
    getResetState: () => ({}),
    consumeResetCredit: () => {
      spent += 1;
    },
  });
  const watch = makeAccountsWatch({
    listOracles: async () => {
      if (failing) throw Error('directory unavailable');
      return {
        entries: [
          { ...entry({ admin, adminId: 'admin' }), sources: ['source'] },
        ],
        unknown: [],
      };
    },
    log: () => {},
  });
  t.teardown(() => watch.close());
  const key = accountResetKey('logical-account', 'admin');
  await watch.redeemReset(key);
  failing = true;
  await t.throwsAsync(() => watch.redeemReset(key), {
    message: /No banked reset/,
  });
  t.is(spent, 1);
});
/** Test streams carry the AccountView records asserted below.
 * @param {any} reader
 * @returns {AsyncGenerator<any, any, any>}
 */
const iterateReader = reader =>
  /** @type {any} */ (iterateRemoteReader(reader));
