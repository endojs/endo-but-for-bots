// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import { E } from '@endo/eventual-send';
import { Far } from '@endo/far';

import {
  prepareSessionStorage,
  makeSessionQueueStorage,
} from '../src/session-storage-layout.js';
import { makePendingQueue } from '../src/pending-queue.js';
import { retirePrivateTurnStorage } from '../src/private-turn-storage.js';
import { directoryHost } from './_directory-host.js';
import { makePromiseKit } from './_promise-kit.js';

const root = 'floot-private-sessions/one';
const fixture = (hooks = {}) => {
  /** @type {Array<[string, unknown]>} */
  const entries = [
    [`${root}/schema`, harden({ version: 2, sessionId: 'one' })],
    ['session-one', Far('Handle', {})],
    ['session-agent-one', Far('Guest', {})],
    ['floot-environment-admin-one', Far('Admin', {})],
    ['floot-environment-shell-one', Far('Shell', {})],
    [
      'floot-pending-3-one',
      harden({
        version: 1,
        nextSequence: 2n,
        receipts: [],
        entries: [
          { id: 'p1', text: 'uncertain', createdAt: 1, state: 'dispatching' },
        ],
      }),
    ],
  ];
  const values = new Map(entries);
  const host = Far('LayoutHost', directoryHost(values, hooks));
  return { values, host };
};

test('migration preserves every capability and pending record identity before recovery', async t => {
  const { values, host } = fixture();
  const expected = new Map([
    ['handle', values.get('session-one')],
    ['guest', values.get('session-agent-one')],
    ['environment-admin', values.get('floot-environment-admin-one')],
    ['environment-shell', values.get('floot-environment-shell-one')],
    ['pending', values.get('floot-pending-3-one')],
  ]);
  await prepareSessionStorage(host, 'one');
  for (const [leaf, value] of expected)
    t.is(values.get(`${root}/${leaf}`), value);
  t.false(
    [...values.keys()].some(name =>
      /^(session-|floot-environment-|floot-pending-)/.test(name),
    ),
  );
  // A distinct host presence simulates the next incarnation's layout barrier.
  const reopened = Far('ReopenedHost', directoryHost(values));
  await prepareSessionStorage(reopened, 'one');
  const queue = makePendingQueue({
    host: makeSessionQueueStorage(reopened, 'one'),
    id: 'one',
  });
  await queue.ready();
  t.is(queue.list()[0].state, 'interrupted');
  t.is(await queue.claim(), undefined);
  await queue.destroy();
  t.false(values.has(`${root}/pending`));
  t.is(values.get(`${root}/guest`), expected.get('guest'));
});

for (const after of [false, true]) {
  test(`migration resumes after ${after ? 'lost removal acknowledgement' : 'interruption after copy'}`, async t => {
    let fail = true;
    const hook = name => {
      if (fail && name === 'session-agent-one') {
        fail = false;
        throw Error('migration interrupted');
      }
    };
    const { values, host } = fixture(
      after ? { afterRemove: hook } : { beforeRemove: hook },
    );
    const guest = values.get('session-agent-one');
    await t.throwsAsync(() => prepareSessionStorage(host, 'one'), {
      message: /interrupted/,
    });
    t.is(values.get(`${root}/guest`), guest);
    await prepareSessionStorage(host, 'one');
    t.false(values.has('session-agent-one'));
    t.is(values.get(`${root}/guest`), guest);
    t.true(values.has(`${root}/pending`));
  });
}

test('a conflicting destination prevents every legacy removal', async t => {
  const f = fixture();
  f.values.set(`${root}/pending`, harden({ different: true }));
  const before = [...f.values];
  await t.throwsAsync(() => prepareSessionStorage(f.host, 'one'), {
    message: /Conflicting/,
  });
  t.deepEqual([...f.values], before);
});

test('queue recovery waits for the same whole-session migration barrier', async t => {
  t.timeout(5000);
  const entered = makePromiseKit();
  const release = makePromiseKit();
  t.teardown(() => release.resolve(undefined));
  const f = fixture({
    beforeRemove: async name => {
      if (name === 'session-one') {
        entered.resolve(undefined);
        await release.promise;
      }
    },
  });
  const migration = prepareSessionStorage(f.host, 'one');
  await entered.promise;
  const storage = makeSessionQueueStorage(f.host, 'one');
  let complete = false;
  const read = E(storage)
    .has('floot-pending-3-one')
    .then(value => {
      complete = true;
      return value;
    });
  await new Promise(resolve => setImmediate(resolve));
  t.false(complete);
  t.true(f.values.has('floot-pending-3-one'));
  release.resolve(undefined);
  await migration;
  t.true(await read);
  t.false(f.values.has('floot-pending-3-one'));
});

test('missing ownership schema never consumes legacy resources', async t => {
  const f = fixture();
  f.values.delete(`${root}/schema`);
  await t.throwsAsync(() => prepareSessionStorage(f.host, 'one'), {
    message: /Unknown name|schema/,
  });
  t.true(f.values.has('session-one'));
  t.true(f.values.has('floot-pending-3-one'));
});

test('a retained queue facade cannot recreate storage after terminal retirement', async t => {
  const f = fixture();
  const queue = makePendingQueue({
    host: makeSessionQueueStorage(f.host, 'one'),
    id: 'one',
  });
  await queue.ready();
  await queue.destroy();
  await retirePrivateTurnStorage(f.host, 'one');
  await t.throwsAsync(() => queue.enqueue('late'), { message: /retired/ });
  t.false([...f.values.keys()].some(name => name.startsWith(`${root}/`)));
  t.false(f.values.has('floot-pending-3-one'));
});
