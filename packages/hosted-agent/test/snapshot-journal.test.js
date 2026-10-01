// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';
import { Far } from '@endo/far';

import { makeSnapshotJournal } from '../src/snapshot-journal.js';

/**
 * @param {string} prefix
 * @param {bigint} sequence
 */
const nameAt = (prefix, sequence) =>
  `${prefix}${`${sequence}`.padStart(20, '0')}`;

const makeGate = () => {
  /** @type {() => void} */
  let open = () => {};
  const promise = new Promise(resolve => {
    open = () => resolve(undefined);
  });
  return { promise, open };
};

const makeNamespace = ({
  initial = {},
  beforeStore = async () => {},
  beforeRemove = async () => {},
} = {}) => {
  const names = new Map(Object.entries(initial));
  /** @type {string[][]} */
  const events = [];
  const powers = Far('snapshot namespace', {
    list: async () => [...names.keys()],
    lookup: async name => names.get(name),
    storeValue: async (value, name) => {
      events.push(['store-start', name]);
      await beforeStore();
      names.set(name, value);
      events.push(['store', name]);
    },
    remove: async name => {
      events.push(['remove', name]);
      await beforeRemove();
      names.delete(name);
    },
  });
  return { names, events, powers };
};

// These are the five existing caller-owned prefixes, not a new storage format.
for (const prefix of [
  'account-snapshot-v1-',
  'pool-state-v2-',
  'reset-intent-v1-',
  'share-state-v1-',
  'runner-state-v1-',
]) {
  test(`${prefix} reads and continues the existing sequence after re-creation`, async t => {
    const previous = harden({ retained: 'previous' });
    const latest = harden({ retained: 'latest' });
    // Sequence arithmetic remains exact beyond JavaScript's number range.
    const sequence = 9_007_199_254_740_993n;
    const namespace = makeNamespace({
      initial: {
        [nameAt(prefix, sequence)]: latest,
        [nameAt(prefix, sequence - 1n)]: previous,
        [`${prefix}999`]: 'wrong width',
        [nameAt('other-state-', 999n)]: 'another owner',
      },
    });
    const journal = makeSnapshotJournal({ powers: namespace.powers, prefix });
    t.is(await journal.read(), latest);
    const next = harden({ retained: 'next' });
    await journal.write(next);
    t.is(namespace.names.get(nameAt(prefix, sequence + 1n)), next);
    const revived = makeSnapshotJournal({ powers: namespace.powers, prefix });
    t.is(await revived.read(), next);
    t.is(namespace.names.get(`${prefix}999`), 'wrong width');
    t.is(namespace.names.get(nameAt('other-state-', 999n)), 'another owner');
  });
}

test('an empty journal publishes sequence zero', async t => {
  const namespace = makeNamespace();
  const journal = makeSnapshotJournal({
    powers: namespace.powers,
    prefix: 'empty-',
  });
  t.is(await journal.read(), undefined);
  const snapshot = harden({ value: 'first' });
  await journal.write(snapshot);
  t.is(namespace.names.get(nameAt('empty-', 0n)), snapshot);
  t.is(await journal.read(), snapshot);
});

test('publication is acknowledged before pruning, retaining four older snapshots', async t => {
  t.timeout(5000);
  const entered = makeGate();
  const release = makeGate();
  t.teardown(release.open);
  const prefix = 'state-';
  const namespace = makeNamespace({
    initial: Object.fromEntries(
      Array.from({ length: 6 }, (_, index) => [
        nameAt(prefix, BigInt(index)),
        harden({ index }),
      ]),
    ),
    beforeStore: async () => {
      entered.open();
      await release.promise;
    },
  });
  const journal = makeSnapshotJournal({ powers: namespace.powers, prefix });
  let acknowledged = false;
  const writing = journal.write(harden({ index: 6 })).then(() => {
    acknowledged = true;
  });
  await entered.promise;
  t.false(acknowledged);
  t.is(namespace.names.size, 6);
  t.deepEqual(await journal.read(), { index: 5 });
  t.deepEqual(namespace.events, [['store-start', nameAt(prefix, 6n)]]);
  release.open();
  await writing;
  t.true(acknowledged);
  t.deepEqual(namespace.events, [
    ['store-start', nameAt(prefix, 6n)],
    ['store', nameAt(prefix, 6n)],
    ['remove', nameAt(prefix, 0n)],
    ['remove', nameAt(prefix, 1n)],
  ]);
  t.deepEqual(
    [...namespace.names.keys()],
    [2n, 3n, 4n, 5n, 6n].map(sequence => nameAt(prefix, sequence)),
  );
});

test('a failed publication preserves the old record and does not poison queued writes', async t => {
  t.timeout(5000);
  const entered = makeGate();
  const release = makeGate();
  t.teardown(release.open);
  const prefix = 'state-';
  let attempts = 0;
  const namespace = makeNamespace({
    initial: { [nameAt(prefix, 0n)]: harden({ value: 'old' }) },
    beforeStore: async () => {
      attempts += 1;
      if (attempts === 1) {
        entered.open();
        await release.promise;
        throw Error('publication failed');
      }
    },
  });
  const journal = makeSnapshotJournal({ powers: namespace.powers, prefix });
  const failed = t.throwsAsync(journal.write(harden({ value: 'failed' })), {
    message: 'publication failed',
  });
  const next = journal.write(harden({ value: 'next' }));
  await entered.promise;
  t.deepEqual(await journal.read(), { value: 'old' });
  t.is(attempts, 1, 'the second write still waits for the failed publication');
  release.open();
  await failed;
  await next;
  t.deepEqual(await journal.read(), { value: 'next' });
  t.deepEqual(namespace.events, [
    ['store-start', nameAt(prefix, 1n)],
    ['store-start', nameAt(prefix, 1n)],
    ['store', nameAt(prefix, 1n)],
  ]);
});

test('pruning failure never loses the acknowledged newest snapshot or another prefix', async t => {
  const namespace = makeNamespace({
    initial: {
      [nameAt('state-', 0n)]: harden({ value: 'old' }),
      [nameAt('other-', 0n)]: harden({ value: 'other' }),
    },
    beforeRemove: async () => {
      throw Error('pruning unavailable');
    },
  });
  const journal = makeSnapshotJournal({
    powers: namespace.powers,
    prefix: 'state-',
    keep: 0,
  });
  await journal.write(harden({ value: 'new' }));
  t.deepEqual(await journal.read(), { value: 'new' });
  t.true(namespace.names.has(nameAt('state-', 0n)));
  t.deepEqual(
    await makeSnapshotJournal({
      powers: namespace.powers,
      prefix: 'other-',
    }).read(),
    { value: 'other' },
  );
});
