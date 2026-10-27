// @ts-check
import '@endo/init/debug.js';
import test from 'ava';
import { Far } from '@endo/far';
import { makePromiseKit } from '@endo/promise-kit';
import { encodeChatDraft } from '../../floot-mentions.js';
import {
  makeSessionDrafts,
  makeSubmissionClient as makeClient,
} from '../../floot-submission-client.js';
import { makeTestLocks } from '../helpers/web-locks.js';

const locks = makeTestLocks();
const makeSubmissionClient = (storage, makeId) =>
  makeClient(storage, makeId, locks);

const store = () => {
  const values = new Map();
  return {
    getItem: key => values.get(key) || null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key),
  };
};

test('reconnect after lost acknowledgement reuses the durable submission ID', async t => {
  t.timeout(5000);
  const storage = store();
  const accepted = new Map();
  let calls = 0;
  const session = Far('Session', {
    enqueueOnce: (text, id) => {
      calls += 1;
      if (!accepted.has(id)) accepted.set(id, { id: 'pending-1' });
      if (calls === 1) throw Error('connection lost after acceptance');
      return accepted.get(id);
    },
  });
  const first = makeSubmissionClient(storage, () => 'request-1');
  await t.throwsAsync(() => first.submit(session, 's', 'hello'), {
    message: /connection lost/,
  });
  const second = makeSubmissionClient(
    storage,
    () => 'must-not-create-another-id',
  );
  t.is(second.draft('s'), 'hello');
  const [a, b] = await Promise.all([
    second.submit(session, 's', 'hello'),
    second.submit(session, 's', 'hello'),
  ]);
  t.deepEqual(a, b);
  t.is(calls, 2);
  t.is(accepted.size, 1);
  t.is(storage.getItem('s'), null);
});

test('a different draft cannot reuse an uncertain request, and storage failure sends nothing', async t => {
  t.timeout(5000);
  const storage = store();
  storage.setItem('s', JSON.stringify({ id: 'request-1', text: 'first' }));
  let calls = 0;
  const session = Far('Session', {
    enqueueOnce: () => {
      calls += 1;
      return {};
    },
  });
  const client = makeSubmissionClient(storage, () => 'new');
  await t.throwsAsync(() => client.submit(session, 's', 'second'), {
    message: /unconfirmed/,
  });
  const broken = makeSubmissionClient(
    {
      ...storage,
      setItem: () => {
        throw Error('storage full');
      },
    },
    () => 'new',
  );
  await t.throwsAsync(() => broken.submit(session, 'other', 'hello'), {
    message: /storage full/,
  });
  t.is(calls, 0);
});

test('older hosts remain usable but an ambiguous legacy enqueue is never retried', async t => {
  t.timeout(5000);
  const storage = store();
  let calls = 0;
  const session = Far('OldSession', {
    enqueue: () => {
      calls += 1;
      throw Error('lost');
    },
  });
  await t.throwsAsync(
    () =>
      makeSubmissionClient(storage, () => 'new').submit(session, 's', 'hello'),
    { message: /lost/ },
  );
  await t.throwsAsync(
    () =>
      makeSubmissionClient(storage, () => 'new').submit(session, 's', 'hello'),
    { message: /cannot safely retry/ },
  );
  t.is(calls, 1);
});

test('a delayed acknowledgement from another view cannot erase the next retry ID', async t => {
  t.timeout(5000);
  const storage = store();
  const pending = [];
  const session = Far('Session', {
    enqueueOnce: (text, id) =>
      new Promise((resolve, reject) => {
        pending.push({ text, id, resolve, reject });
      }),
  });
  // E sends take a turn before entering the remote object.
  const delivered = () => new Promise(resolve => setTimeout(resolve, 0));
  let sequence = 0;
  const makeId = () => {
    sequence += 1;
    return `request-${sequence}`;
  };
  const firstView = makeSubmissionClient(storage, makeId);
  const secondView = makeSubmissionClient(storage, makeId);
  const first = firstView.submit(session, 's', 'first');
  await delivered();
  const replay = secondView.submit(session, 's', 'first');
  await delivered();
  t.is(pending[0].id, pending[1].id);
  pending[0].resolve({ id: 'pending-first' });
  await first;
  const next = firstView.submit(session, 's', 'second');
  await delivered();
  const nextId = pending[2].id;
  pending[1].resolve({ id: 'pending-first' });
  await replay;
  t.is(JSON.parse(storage.getItem('s')).id, nextId);
  const failure = t.throwsAsync(next, { message: /lost acknowledgement/ });
  pending[2].reject(Error('lost acknowledgement'));
  await failure;
  const retried = makeSubmissionClient(storage, makeId).submit(
    session,
    's',
    'second',
  );
  await delivered();
  t.is(pending[3].id, nextId);
  pending[3].resolve({ id: 'pending-second' });
  await retried;
});

test('recovered drafts and subsequent edits stay with their selected sessions', t => {
  const saved = new Map([
    ['a', 'possibly sent in A'],
    ['b', 'possibly sent in B'],
  ]);
  const storage = store();
  const readSaved = key => saved.get(key) || '';
  const drafts = makeSessionDrafts(readSaved, storage);
  let text = drafts.select('a', '');
  t.is(text, 'possibly sent in A');
  text = drafts.select('b', text);
  t.is(text, 'possibly sent in B');
  text = drafts.select('empty', text);
  t.is(text, '');
  text = drafts.select('a', 'new draft for empty session');
  t.is(text, 'possibly sent in A');
  // Reconnect is not selection: preserve the person's ongoing edit.
  t.is(drafts.select('a', 'edited A'), 'edited A');
  t.is(drafts.select('empty', 'edited A'), 'new draft for empty session');
  drafts.save('');
  t.is(drafts.select('a', ''), 'possibly sent in A');
  t.is(drafts.select(null, 'edited A'), '');
  const reloaded = makeSessionDrafts(readSaved, storage);
  t.is(reloaded.select('empty', ''), '');
  reloaded.save('unsent across theme recreation');
  t.is(
    makeSessionDrafts(readSaved, storage).select('empty', ''),
    'unsent across theme recreation',
  );
  t.is(
    makeSessionDrafts(readSaved, storage).select('a', ''),
    'possibly sent in A',
  );
});

test('claim precedes slow discovery and legacy reservations have one dispatcher', async t => {
  t.timeout(5000);
  const storage = store();
  const { promise: discovery, resolve: resolveMethods } = makePromiseKit();
  const accepted = [];
  const slow = Far('Slow discovery', {
    __getMethodNames__: () => discovery,
    enqueueOnce: (text, id) => {
      accepted.push(id);
      return { id };
    },
  });
  const fast = Far('Fast discovery', {
    enqueueOnce: (text, id) => {
      accepted.push(id);
      return { id };
    },
  });
  const a = makeSubmissionClient(storage, () => 'A').submit(slow, 's', 'same');
  await new Promise(resolve => setTimeout(resolve, 0));
  t.is(JSON.parse(storage.getItem('s')).id, 'A');
  await makeSubmissionClient(storage, () => 'B').submit(fast, 's', 'same');
  const stale = t.throwsAsync(a, { message: /resolved or changed/ });
  resolveMethods(['enqueueOnce']);
  await stale;
  t.deepEqual(accepted, ['A']);

  let legacyCalls = 0;
  const { promise: pendingLegacy, resolve: finishLegacy } = makePromiseKit();
  const legacy = Far('Legacy', {
    enqueue: () => {
      legacyCalls += 1;
      return pendingLegacy;
    },
  });
  const first = makeSubmissionClient(storage, () => 'L').submit(
    legacy,
    'legacy',
    'same',
  );
  const second = makeSubmissionClient(storage, () => 'M').submit(
    legacy,
    'legacy',
    'same',
  );
  await t.throwsAsync(second, { message: /cannot safely retry/ });
  t.is(legacyCalls, 1);
  finishLegacy({ id: 'legacy' });
  await first;
});

test('late uncertain receipts override empty caches and restoration failures retain draft ownership', t => {
  const storage = store();
  const client = makeSubmissionClient(storage, () => 'unused');
  const drafts = makeSessionDrafts(client.draft, storage);
  drafts.select('A', '');
  drafts.save('');
  drafts.select('B', '');
  storage.setItem('A', JSON.stringify({ id: 'retryA', text: 'uncertain A' }));
  t.is(drafts.select('A', ''), 'uncertain A');
  drafts.save('A draft');
  storage.setItem('B', 'malformed JSON');
  t.throws(() => drafts.select('B', 'A draft'));
  const oldB = drafts.save('B draft');
  t.is(JSON.parse(storage.getItem('floot-draft:A')).text, 'A draft');
  t.is(JSON.parse(storage.getItem('floot-draft:B')).text, 'B draft');
  t.is(drafts.restore('A', 'uncertain A', ''), '');
  drafts.save('B draft');
  drafts.acknowledge(oldB);
  t.is(JSON.parse(storage.getItem('floot-draft:B')).text, 'B draft');
});

test('draft cleanup failure retains retry identity and a newer identical draft survives the ACK', async t => {
  t.timeout(5000);
  const backing = store();
  let failCleanup = true;
  const storage = {
    ...backing,
    removeItem: key => {
      if (failCleanup && key.startsWith('floot-draft:'))
        throw Error('draft storage unavailable');
      backing.removeItem(key);
    },
  };
  const requests = [];
  const session = Far('Session', {
    enqueueOnce: (text, id) => {
      requests.push(id);
      return { id: 'accepted' };
    },
  });
  const client = makeSubmissionClient(storage, () => 'original');
  const drafts = makeSessionDrafts(client.draft, storage);
  drafts.select('s', '');
  const sent = drafts.save('ok');
  await t.throwsAsync(
    client.submit(session, 's', 'ok', () => drafts.acknowledge(sent)),
    { message: /draft storage unavailable/ },
  );
  t.is(JSON.parse(storage.getItem('s')).id, 'original');
  failCleanup = false;
  drafts.save('ok'); // The person types another identical message while waiting.
  const retry = makeSubmissionClient(storage, () => 'must-not-be-used');
  await retry.submit(session, 's', 'ok', () => drafts.acknowledge(sent));
  t.deepEqual(requests, ['original', 'original']);
  t.is(makeSessionDrafts(retry.draft, storage).select('s', ''), 'ok');
});

test('missing Web Locks refuses dispatch, and concurrent views share one claim', async t => {
  t.timeout(5000);
  const storage = store();
  let calls = 0;
  const requests = [];
  const session = Far('Session', {
    enqueueOnce: (text, id) => {
      calls += 1;
      requests.push(id);
      throw Error('lost acknowledgement');
    },
  });
  await t.throwsAsync(
    () =>
      makeClient(storage, () => 'unsafe', null).submit(
        session,
        's',
        'text',
      ),
    { message: /Web Locks/ },
  );
  t.is(calls, 0);
  const a = makeSubmissionClient(storage, () => 'request-a');
  const b = makeSubmissionClient(storage, () => 'request-b');
  await Promise.all([
    t.throwsAsync(a.submit(session, 's', 'text'), {
      message: /lost acknowledgement/,
    }),
    t.throwsAsync(b.submit(session, 's', 'text'), {
      message: /lost acknowledgement/,
    }),
  ]);
  t.deepEqual(requests, ['request-a', 'request-a']);
});

test('forgetting an inspected retry cannot erase a newer submission', async t => {
  t.timeout(5000);
  const storage = store();
  storage.setItem('s', 'old inspected request');
  let release = () => {};
  const waiting = new Promise(resolve => {
    release = () => resolve(undefined);
  });
  const client = makeClient(storage, () => 'unused', {
    request: (key, work) => waiting.then(work),
  });
  const forgotten = client.forget('s');
  storage.setItem('s', 'new uninspected request');
  const failed = t.throwsAsync(forgotten, {
    message: /changed in another view/,
  });
  release();
  await failed;
  t.is(storage.getItem('s'), 'new uninspected request');
});

test('coalesced sends clear each submitted draft revision without dispatching twice', async t => {
  t.timeout(5000);
  const storage = store();
  const acknowledged = makePromiseKit();
  let calls = 0;
  const session = Far('Session', {
    enqueueOnce: () => {
      calls += 1;
      return acknowledged.promise;
    },
  });
  const client = makeSubmissionClient(storage, () => 'same-request');
  const drafts = makeSessionDrafts(client.draft, storage);
  drafts.select('s', '');
  const firstDraft = drafts.save('ok');
  const first = client.submit(session, 's', 'ok', () =>
    drafts.acknowledge(firstDraft),
  );
  const secondDraft = drafts.save('ok');
  const second = client.submit(session, 's', 'ok', () =>
    drafts.acknowledge(secondDraft),
  );
  acknowledged.resolve({ id: 'accepted' });
  await Promise.all([first, second]);
  t.is(calls, 1);
  t.is(makeSessionDrafts(client.draft, storage).select('s', ''), '');
});

test('inventory submissions reconnect with the same receipt and never fall back to plain text', async t => {
  t.timeout(5000);
  const storage = store();
  const object = Far('Object', {});
  const references = harden([
    { path: ['docs'], identity: 'doc-id', value: object },
  ]);
  const ids = [];
  const session = Far('SessionWithMentions', {
    getSubmissionReceipt: () => null,
    enqueueOnce: () => {
      throw Error('must use attachment endpoint');
    },
    enqueueMessageOnce: (text, id, mentions) => {
      t.deepEqual(text, { strings: ['Read ', ''], names: ['docs'] });
      t.is(mentions[0].value, object);
      ids.push(id);
      if (ids.length === 1) throw Error('lost acknowledgement');
      return harden({ id: 'accepted' });
    },
  });
  await t.throwsAsync(
    () =>
      makeSubmissionClient(storage, () => 'original').submit(
        session,
        's',
        encodeChatDraft({
          strings: ['Read ', ''],
          petNames: ['docs'],
          edgeNames: ['docs'],
        }),
        () => {},
        async () => references,
      ),
    { message: /lost/ },
  );
  await makeSubmissionClient(storage, () => 'wrong').submit(
    session,
    's',
    encodeChatDraft({
      strings: ['Read ', ''],
      petNames: ['docs'],
      edgeNames: ['docs'],
    }),
    () => {},
    async () => references,
  );
  t.deepEqual(ids, ['original', 'original']);
  t.is(storage.getItem('s'), null);
  let sent = false;
  const old = Far('OlderSession', {
    enqueueOnce: () => {
      sent = true;
    },
  });
  await t.throwsAsync(
    () =>
      makeSubmissionClient(storage, () => 'new').submit(
        old,
        's',
        encodeChatDraft({
          strings: ['Read ', ''],
          petNames: ['docs'],
          edgeNames: ['docs'],
        }),
        () => {},
        async () => references,
      ),
    { message: /Update the Floot host/ },
  );
  t.false(sent);
  t.is(storage.getItem('s'), null, 'known-unsent reservation is released');
});

test('an undelivered mention retry cannot follow a rebound name, but accepted receipts survive deletion', async t => {
  t.timeout(5000);
  const storage = store();
  let accepted = false;
  let deliveries = 0;
  const session = Far('MentionSession', {
    enqueueOnce: () => {},
    getSubmissionReceipt: (text, id, manifest) => {
      t.is(id, 'original');
      t.deepEqual(manifest, [{ path: ['docs'], identity: 'A' }]);
      return accepted ? harden({ id: 'receipt' }) : null;
    },
    enqueueMessageOnce: () => {
      deliveries += 1;
      throw Error('transport lost');
    },
  });
  const original = harden([
    { path: ['docs'], identity: 'A', value: Far('A', {}) },
  ]);
  const replacement = harden([
    { path: ['docs'], identity: 'B', value: Far('B', {}) },
  ]);
  await t.throwsAsync(
    () =>
      makeSubmissionClient(storage, () => 'original').submit(
        session,
        's',
        encodeChatDraft({
          strings: ['', ''],
          petNames: ['docs'],
          edgeNames: ['docs'],
        }),
        () => {},
        async () => original,
      ),
    { message: /transport/ },
  );
  t.deepEqual(JSON.parse(storage.getItem('s')).manifest, [
    { path: ['docs'], identity: 'A' },
  ]);
  await t.throwsAsync(
    () =>
      makeSubmissionClient(storage, () => 'wrong').submit(
        session,
        's',
        encodeChatDraft({
          strings: ['', ''],
          petNames: ['docs'],
          edgeNames: ['docs'],
        }),
        () => {},
        async () => replacement,
      ),
    { message: /objects changed/ },
  );
  t.is(deliveries, 1);
  accepted = true;
  const result = await makeSubmissionClient(storage, () => 'wrong').submit(
    session,
    's',
    encodeChatDraft({
      strings: ['', ''],
      petNames: ['docs'],
      edgeNames: ['docs'],
    }),
    () => {},
    async () => {
      throw Error('source deleted');
    },
  );
  t.deepEqual(result, { id: 'receipt' });
  t.is(deliveries, 1);
  t.is(storage.getItem('s'), null);
});

test('failed mention lookup before dispatch permits correcting the draft', async t => {
  t.timeout(5000);
  const storage = store();
  let deliveries = 0;
  const session = Far('MentionSession', {
    enqueueOnce: () => {
      deliveries += 1;
      return harden({ id: 'text' });
    },
    getSubmissionReceipt: () => null,
    enqueueMessageOnce: () => {
      throw Error('must not dispatch');
    },
  });
  const client = makeSubmissionClient(storage, () => 'request');
  await t.throwsAsync(
    () =>
      client.submit(
        session,
        's',
        encodeChatDraft({
          strings: ['', ''],
          petNames: ['missing'],
          edgeNames: ['missing'],
        }),
        () => {},
        async () => {
          throw Error('missing object');
        },
      ),
    { message: /missing object/ },
  );
  t.is(storage.getItem('s'), null);
  await client.submit(session, 's', 'corrected');
  t.is(deliveries, 1);
});
