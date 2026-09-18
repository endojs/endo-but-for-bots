// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import { Far } from '@endo/far';

import { makePendingQueue } from '../src/pending-queue.js';

const makeHost = () => {
  /** @type {Map<string, any>} */
  const store = new Map();
  let failWrites = false;
  let loseNextAck = false;
  let writes = 0;
  const host = Far('TestHost', {
    has: name => store.has(name),
    lookup: name => store.get(name),
    storeValue: (value, name) => {
      if (failWrites) throw Error('petstore write failed');
      writes += 1;
      store.set(name, value);
      if (loseNextAck) {
        loseNextAck = false;
        throw Error('acknowledgement lost');
      }
    },
    remove: name => {
      if (failWrites) throw Error('petstore write failed');
      writes += 1;
      store.delete(name);
    },
  });
  return {
    host,
    store,
    failWrites: value => {
      failWrites = value;
    },
    /** The next write lands, and then reports failure. */
    loseNextAck: () => {
      loseNextAck = true;
    },
    writes: () => writes,
  };
};

const NAME = 'floot-pending-3-abc';

test('what is queued survives the process that queued it', async t => {
  const { host, store } = makeHost();
  let clock = 100;
  const first = makePendingQueue({ host, id: 'abc', now: () => (clock += 1) });
  await first.ready();
  t.deepEqual(first.list(), []);
  t.false(store.has(NAME), 'a session that never queues has no record');
  const a = await first.enqueue('  one  ');
  const b = await first.enqueue('two');
  t.deepEqual(a, {
    id: `p${(101).toString(36)}-1`,
    text: 'one',
    createdAt: 101,
    state: 'queued',
  });
  t.not(b.id, a.id);

  const second = makePendingQueue({ host, id: 'abc' });
  await second.ready();
  t.deepEqual(
    second.list().map(entry => [entry.id, entry.text, entry.state]),
    [
      [a.id, 'one', 'queued'],
      [b.id, 'two', 'queued'],
    ],
  );
  await second.cancel(a.id);
  await second.cancel(b.id);
  t.false(store.has(NAME), 'an empty queue keeps no record');
});

test('an id is not reissued after the record has emptied and the daemon restarted', async t => {
  const { host, store } = makeHost();
  let clock = 1000;
  const first = makePendingQueue({ host, id: 'abc', now: () => (clock += 1) });
  const entry = await first.enqueue('one', { claim: true });
  await first.complete(entry.id);
  t.false(store.has(NAME), 'the sequence went with the record');
  const second = makePendingQueue({ host, id: 'abc', now: () => (clock += 1) });
  const again = await second.enqueue('two');
  t.not(again.id, entry.id, 'a stale id cannot address the new message');
  t.false(await second.cancel(entry.id));
  t.is(second.list().length, 1);
});

test('dispatch is at most once across a crash', async t => {
  const { host } = makeHost();
  const first = makePendingQueue({ host, id: 'abc' });
  const one = await first.enqueue('one');
  const two = await first.enqueue('two');
  const claimed = await first.claim();
  t.is(claimed?.id, one.id);
  t.is(claimed?.state, 'dispatching');
  t.is(await first.claim(), undefined, 'one dispatch at a time');
  // The daemon dies here: the turn may or may not have reached the backend.
  const second = makePendingQueue({ host, id: 'abc' });
  await second.ready();
  t.deepEqual(
    second.list().map(entry => entry.state),
    ['interrupted', 'queued'],
  );
  t.is(
    await second.claim(),
    undefined,
    'an interrupted head is never sent again on its own, and holds its place',
  );
  // The user decides: send it after all…
  await second.retry(one.id);
  t.is((await second.claim())?.id, one.id);
  await second.complete(one.id);
  // …and the one behind it follows.
  t.is((await second.claim())?.id, two.id);
});

test('a refused turn puts its message back; a journaled one lets go of it', async t => {
  const { host } = makeHost();
  const queue = makePendingQueue({ host, id: 'abc' });
  const { id } = await queue.enqueue('one');
  await queue.claim();
  await queue.release(id);
  t.deepEqual(
    queue.list().map(entry => entry.state),
    ['queued'],
  );
  await queue.claim();
  await queue.complete(id);
  t.deepEqual(queue.list(), []);
  // Completing or releasing something already gone is not an error.
  await queue.complete(id);
  await queue.release(id);
});

test('an idle enqueue claims in the same write, but never jumps the queue', async t => {
  const { host, writes } = makeHost();
  const queue = makePendingQueue({ host, id: 'abc' });
  await queue.ready();
  const before = writes();
  const first = await queue.enqueue('one', { claim: true });
  t.is(first.state, 'dispatching');
  t.is(writes() - before, 1);
  const second = await queue.enqueue('two', { claim: true });
  t.is(second.state, 'queued');
});

test('a message can be edited or cancelled until it starts', async t => {
  const { host } = makeHost();
  const queue = makePendingQueue({ host, id: 'abc' });
  const p1 = (await queue.enqueue('one')).id;
  const p2 = (await queue.enqueue('two')).id;
  t.is((await queue.edit(p2, ' two, revised ')).text, 'two, revised');
  await t.throwsAsync(() => queue.edit(p2, '   '), { message: /non-empty/ });
  t.is(queue.list()[1].text, 'two, revised', 'an empty edit changes nothing');
  await queue.claim();
  await t.throwsAsync(() => queue.edit(p1, 'late'), {
    message: /already being sent/,
  });
  await t.throwsAsync(() => queue.cancel(p1), {
    message: /already being sent/,
  });
  t.true(await queue.cancel(p2));
  t.false(await queue.cancel(p2), 'cancelling twice is not an error');
  await t.throwsAsync(() => queue.edit('nope', 'x'), {
    message: /No queued message/,
  });
  await t.throwsAsync(() => queue.enqueue(/** @type {any} */ (42)), {
    message: /non-empty/,
  });
});

test('a failed write changes nothing, and the queue goes by what was written', async t => {
  const { host, failWrites } = makeHost();
  let notified = 0;
  const queue = makePendingQueue({
    host,
    id: 'abc',
    onChange: () => {
      notified += 1;
    },
  });
  await queue.enqueue('one');
  t.is(notified, 1);
  failWrites(true);
  await t.throwsAsync(() => queue.enqueue('two'), {
    message: /petstore write failed/,
  });
  t.deepEqual(
    queue.list().map(entry => entry.text),
    ['one'],
    'memory never runs ahead of the record',
  );
  t.is(notified, 1);
  // One hiccup does not end the queue's life: the next operation reads the
  // record again and carries on from what is really there.
  failWrites(false);
  t.is((await queue.enqueue('three')).text, 'three');
  t.deepEqual(
    queue.list().map(entry => entry.text),
    ['one', 'three'],
  );
});

test('a claim whose write failed is not dispatched, and reads back as interrupted', async t => {
  const { host, loseNextAck } = makeHost();
  const queue = makePendingQueue({ host, id: 'abc' });
  await queue.enqueue('one');
  // The write lands but its acknowledgement is lost.
  loseNextAck();
  await t.throwsAsync(() => queue.claim(), { message: /acknowledgement lost/ });
  // The caller never got an entry, so it started nothing. What the record
  // says is `dispatching`; this incarnation cannot vouch for that any more.
  await queue.ready();
  t.deepEqual(
    queue.list().map(entry => entry.state),
    ['interrupted'],
  );
});

test('only so many messages wait at once, however many a session sends in its life', async t => {
  const { host } = makeHost();
  const queue = makePendingQueue({ host, id: 'abc' });
  const ids = [];
  for (let i = 0; i < 100; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    ids.push((await queue.enqueue(`message ${i}`)).id);
  }
  await t.throwsAsync(() => queue.enqueue('one too many'), {
    message: /already has 100 messages waiting/,
  });
  // Not a lifetime count: make room and it is accepted.
  await queue.cancel(ids[0]);
  t.is((await queue.enqueue('now there is room')).text, 'now there is room');
});

test('two enqueues at once both land, in order', async t => {
  const { host } = makeHost();
  const queue = makePendingQueue({ host, id: 'abc' });
  const [a, b] = await Promise.all([queue.enqueue('a'), queue.enqueue('b')]);
  t.not(a.id, b.id);
  t.deepEqual(
    queue.list().map(entry => entry.text),
    ['a', 'b'],
  );
  // A cancel racing a claim: whichever the chain runs first wins cleanly.
  const [cancelled, claimed] = await Promise.allSettled([
    queue.cancel(a.id),
    queue.claim(),
  ]);
  t.is(cancelled.status, 'fulfilled');
  t.is(claimed.status, 'fulfilled');
  t.is(
    /** @type {any} */ (claimed).value?.id,
    b.id,
    'a was gone; b is the head',
  );
});

test('a corrupt record is refused, not adopted', async t => {
  const { host, store } = makeHost();
  store.set(NAME, harden({ version: 2 }));
  const queue = makePendingQueue({ host, id: 'abc' });
  await t.throwsAsync(() => queue.ready(), { message: /corrupt/ });
  store.set(
    NAME,
    harden({ version: 1, nextSequence: 2n, entries: [{ id: 'p-1' }] }),
  );
  const again = makePendingQueue({ host, id: 'abc' });
  await t.throwsAsync(() => again.ready(), { message: /malformed/ });
});

test('the record goes with the session', async t => {
  const { host, store } = makeHost();
  const queue = makePendingQueue({ host, id: 'abc' });
  await queue.enqueue('one');
  t.true(store.has(NAME));
  await queue.destroy();
  t.false(store.has(NAME));
  t.deepEqual(queue.list(), []);
});

test('a record that cannot be read does not make its session undeletable', async t => {
  const { host, store } = makeHost();
  store.set(NAME, harden({ version: 99, from: 'a later release' }));
  const queue = makePendingQueue({ host, id: 'abc' });
  await t.throwsAsync(() => queue.ready(), { message: /corrupt/ });
  await queue.destroy();
  t.false(store.has(NAME));
});
