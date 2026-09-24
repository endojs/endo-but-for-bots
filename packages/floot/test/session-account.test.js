// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import { Far } from '@endo/far';
import { readSessionAccounts } from '../src/session-account.js';
import { makeAccountStatusTool } from '../src/account-tool.js';

const fixture = () => {
  const reads = [];
  const account = (accountId, uses) => ({
    accountId,
    providerId: 'vendor',
    title: 'Same label',
    uses,
    adminId: `admin-${accountId}`,
    admin: Far('Admin', {}),
    oracle: Far('Oracle', {
      refresh: () => {
        reads.push(`refresh:${accountId}`);
      },
      getPlan: () => {
        reads.push(accountId);
        return harden({
          providerId: 'vendor',
          title: accountId,
          source: 'observed',
          observedAt: '',
          state: 'active',
        });
      },
      getRateLimits: () =>
        harden({ windows: [], source: 'observed', observedAt: '' }),
      getRateCard: () =>
        harden({ rates: [], source: 'unavailable', observedAt: '' }),
      estimateCost: () => {
        throw Error('Must never attribute aggregate usage');
      },
    }),
  });
  let records = new Map([
    [
      'arbitrary-source',
      harden({
        version: 1,
        accounts: [
          account('a', [
            { backendId: 'strange-runtime', subscriptionId: 'one' },
            { backendId: 'other', subscriptionId: 'two' },
          ]),
          account('b', [
            { backendId: 'strange-runtime', subscriptionId: 'two' },
          ]),
          account('direct', [{ backendId: 'provider' }]),
        ],
      }),
    ],
  ]);
  const directory = Far('Bindings', {
    list: () => harden([...records.keys()]),
    lookup: name => records.get(name),
  });
  const profile = Far('Profile', {
    has: name => name === 'account-bindings',
    lookup: name => {
      if (name !== 'account-bindings') throw Error('No legacy oracle lookup');
      return directory;
    },
  });
  return {
    profile,
    reads,
    setRecords: value => {
      records = value;
    },
  };
};

test('configured auto pool accounts deduplicate uses without claiming payer or carrying authority', async t => {
  const { profile, reads } = fixture();
  const result = await readSessionAccounts(
    profile,
    { backendId: 'strange-runtime', subscription: 'auto' },
    true,
  );
  t.deepEqual(
    result.accounts.map(a => a.accountId),
    ['a', 'b'],
  );
  t.is(result.selection, 'configured-accounts');
  t.is(result.attribution, 'not-recorded');
  t.true(result.complete);
  t.deepEqual(
    reads.filter(s => s.startsWith('refresh:')),
    ['refresh:a', 'refresh:b'],
  );
  for (const row of result.accounts) {
    t.false('oracle' in row);
    t.false('admin' in row);
    t.false('adminId' in row);
    t.false('cost' in row);
  }
});

test('pin matches backend and subscription on the same use; direct selects only direct binding', async t => {
  const { profile } = fixture();
  const pinned = await readSessionAccounts(profile, {
    backendId: 'strange-runtime',
    subscription: 'two',
  });
  t.deepEqual(
    pinned.accounts.map(a => a.accountId),
    ['b'],
  );
  t.is(pinned.selection, 'subscription-pin');
  const direct = await readSessionAccounts(profile, { backendId: 'provider' });
  t.deepEqual(
    direct.accounts.map(a => a.accountId),
    ['direct'],
  );
});

test('each read sees republishing, unavailable sources and removal without direct oracle fallback', async t => {
  const world = fixture();
  await readSessionAccounts(world.profile, { backendId: 'strange-runtime' });
  world.setRecords(
    new Map([
      [
        'arbitrary-source',
        harden({ version: 1, accounts: [], unavailable: true }),
      ],
    ]),
  );
  const unavailable = await readSessionAccounts(world.profile, {
    backendId: 'strange-runtime',
  });
  t.false(unavailable.complete);
  t.false(unavailable.available);
  t.deepEqual(unavailable.unknownSources, ['arbitrary-source']);
  world.setRecords(new Map());
  const removed = await readSessionAccounts(world.profile, {
    backendId: 'strange-runtime',
  });
  t.true(removed.complete);
  t.false(removed.available);
});

test('accountStatus reports pool candidates and incomplete discovery without pricing totals', async t => {
  const { profile } = fixture();
  const tool = makeAccountStatusTool({
    readAccounts: async refresh =>
      harden({
        ...(await readSessionAccounts(
          profile,
          { backendId: 'strange-runtime' },
          refresh,
        )),
        complete: false,
        usage: { inputTokens: 1200, outputTokens: 3 },
      }),
  });
  const text = await tool.execute({ refresh: true });
  t.regex(text, /discovery is incomplete/);
  t.regex(text, /1200 input and 3 output/);
  t.regex(text, /not proof of runtime eligibility/);
  t.regex(text, /Account: Same label \(a\)/);
  t.regex(text, /Account: Same label \(b\)/);
});

test('an observer cannot smuggle a nested capability into the account report', async t => {
  const world = fixture();
  world.setRecords(
    new Map([
      [
        'source',
        harden({
          version: 1,
          accounts: [
            {
              accountId: 'bad',
              providerId: 'vendor',
              title: 'Bad',
              uses: [{ backendId: 'test' }],
              oracle: Far('BadObserver', {
                getPlan: () => harden({ nested: Far('UnexpectedAdmin', {}) }),
                getRateLimits: () => harden({}),
                getRateCard: () => harden({}),
              }),
            },
          ],
        }),
      ],
    ]),
  );
  await t.throwsAsync(
    readSessionAccounts(world.profile, { backendId: 'test' }),
    { message: /copy data/ },
  );
});
