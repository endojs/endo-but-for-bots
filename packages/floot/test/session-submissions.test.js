// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import { Far } from '@endo/far';

import { makePendingQueue } from '../src/pending-queue.js';
import { makeSessionSubmissions } from '../src/session-submissions.js';

const makeHost = () => {
  /** @type {Map<string, any>} */
  const store = new Map();
  return Far('TestHost', {
    has: name => store.has(name),
    lookup: name => store.get(name),
    storeValue: (value, name) => {
      store.set(name, value);
    },
    remove: name => {
      store.delete(name);
    },
  });
};

/**
 * A session with one turn slot whose turns the test finishes by hand.
 *
 * @param {any} host
 */
const makeSession = host => {
  /** @type {Array<{ text: string, pendingId: string, begin: () => Promise<void>, finish: (error?: string) => void }>} */
  const started = [];
  /** @type {object | null} */
  let current = null;
  let refusal = '';
  let refuseStart = '';
  let changes = 0;
  const queue = makePendingQueue({
    host,
    id: 'abc',
    onChange: () => {
      changes += 1;
    },
  });
  /** @type {ReturnType<typeof makeSessionSubmissions>} */
  const submissions = makeSessionSubmissions({
    queue,
    getCurrentTurn: () => current,
    refusal: () => refusal,
    onChange: () => {
      changes += 1;
    },
    startTurn: (text, { pendingId, onBegun }) => {
      if (refuseStart) throw Error(refuseStart);
      /** @type {(value?: unknown) => void} */
      let resolve = () => {};
      const finished = new Promise(r => {
        resolve = r;
      });
      let error = '';
      const turn = Far('TestTurn', {
        whenFinished: () => finished,
        getStatus: () => harden({ error: error || null }),
      });
      current = turn;
      started.push({
        text,
        pendingId,
        begin: () => onBegun(),
        finish: reason => {
          error = reason || '';
          current = null;
          resolve(undefined);
          // The real slot tells the factory, which pumps.
          void submissions.pump();
        },
      });
      return turn;
    },
  });
  return {
    submissions,
    started,
    setRefusal: value => {
      refusal = value;
    },
    setRefuseStart: value => {
      refuseStart = value;
    },
    changes: () => changes,
  };
};

const settle = async () => {
  for (let i = 0; i < 50; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await null;
  }
  await new Promise(resolve => setTimeout(resolve, 5));
};

const texts = submissions =>
  submissions.read().entries.map(entry => `${entry.text}:${entry.state}`);

test('an idle session starts a message at once; the journal takes it over', async t => {
  const { submissions, started } = makeSession(makeHost());
  await submissions.submit('one');
  t.is(started.length, 1);
  t.is(started[0].text, 'one');
  t.deepEqual(texts(submissions), ['one:dispatching']);
  await started[0].begin();
  t.deepEqual(texts(submissions), [], 'journaled: the queue lets go');
  started[0].finish();
  await settle();
  t.is(started.length, 1);
});

test('messages sent mid-turn wait, then run one at a time in order', async t => {
  const { submissions, started } = makeSession(makeHost());
  await submissions.submit('one');
  await started[0].begin();
  await submissions.submit('two');
  await submissions.submit('three');
  t.is(started.length, 1);
  t.deepEqual(texts(submissions), ['two:queued', 'three:queued']);
  started[0].finish();
  await settle();
  t.is(started.length, 2);
  t.is(started[1].text, 'two');
  await started[1].begin();
  started[1].finish('the model fell over');
  await settle();
  // A turn that ran and failed is the journal's business; the queue moves on.
  t.is(started.length, 3);
  t.is(started[2].text, 'three');
});

test('an edit is what runs, and a cancelled message never does', async t => {
  const { submissions, started } = makeSession(makeHost());
  await submissions.submit('one');
  await started[0].begin();
  const two = await submissions.submit('two');
  const three = await submissions.submit('three');
  await submissions.edit(three.id, 'three, revised');
  t.true(await submissions.cancel(two.id));
  started[0].finish();
  await settle();
  t.deepEqual(
    started.map(turn => turn.text),
    ['one', 'three, revised'],
  );
});

test('a turn that never began sent nothing: its message waits, held', async t => {
  const { submissions, started } = makeSession(makeHost());
  await submissions.submit('one');
  // Refused before the journal had it (journal needs recovery, backend down).
  started[0].finish('Turn journal needs recovery');
  await settle();
  t.is(started.length, 1, 'no retry loop');
  t.deepEqual(texts(submissions), ['one:queued']);
  t.is(submissions.read().hold?.reason, 'refused');
  t.regex(`${submissions.read().hold?.message}`, /needs recovery/);
  // Pumping — a turn ending, a resume — does not release a hold.
  await submissions.pump();
  t.is(started.length, 1);
  // The user does.
  const [entry] = submissions.read().entries;
  t.deepEqual(await submissions.sendNow(entry.id), { cancelCurrent: false });
  t.is(started.length, 2);
  t.is(submissions.read().hold, null);
});

test('a start that throws is held the same way', async t => {
  const { submissions, started, setRefuseStart } = makeSession(makeHost());
  setRefuseStart('Session is stopped or stopping');
  await submissions.submit('one');
  t.is(started.length, 0);
  t.deepEqual(texts(submissions), ['one:queued']);
  t.is(submissions.read().hold?.reason, 'refused');
  setRefuseStart('');
  // A new message is the user saying go: the older one runs first.
  await submissions.submit('two');
  t.is(started.length, 1);
  t.is(started[0].text, 'one');
});

test('a session that admits no work holds nothing against the queue', async t => {
  const { submissions, started, setRefusal } = makeSession(makeHost());
  setRefusal('network policy change in progress');
  await submissions.submit('one');
  t.is(started.length, 0);
  t.is(submissions.read().hold, null, 'transient: not a hold');
  setRefusal('');
  await submissions.pump();
  t.is(started.length, 1);
});

test('what was queued before a restart waits for the user', async t => {
  const host = makeHost();
  const before = makeSession(host);
  await before.submissions.submit('one');
  await before.started[0].begin();
  await before.submissions.submit('two');
  await before.submissions.submit('three');
  // The daemon restarts mid-turn.
  const after = makeSession(host);
  await after.submissions.ready();
  t.deepEqual(texts(after.submissions), ['two:queued', 'three:queued']);
  t.is(after.submissions.read().hold?.reason, 'restart');
  await after.submissions.pump();
  t.is(after.started.length, 0, 'nothing is sent at boot with nobody watching');
  const [two] = after.submissions.read().entries;
  await after.submissions.sendNow(two.id);
  t.is(after.started[0].text, 'two');
  await after.started[0].begin();
  after.started[0].finish();
  await settle();
  t.is(after.started[1]?.text, 'three', 'and the rest follow, in order');
});

test('a dispatch interrupted by a restart is never repeated on its own', async t => {
  const host = makeHost();
  const before = makeSession(host);
  await before.submissions.submit('one');
  await before.submissions.submit('two');
  // Claimed, turn starting — and the daemon dies before the journal has it.
  const after = makeSession(host);
  await after.submissions.ready();
  t.deepEqual(texts(after.submissions), ['one:interrupted', 'two:queued']);
  // Sending something new releases the restart hold but not this one.
  await after.submissions.submit('three');
  t.is(after.started.length, 0);
  t.is(after.submissions.read().hold?.reason, 'interrupted');
  // Deleting it is one decision…
  const [one] = after.submissions.read().entries;
  await after.submissions.cancel(one.id);
  t.is(after.submissions.read().hold, null);
  t.is(after.started[0]?.text, 'two');
});

test('sending an interrupted message again is the other decision', async t => {
  const host = makeHost();
  const before = makeSession(host);
  await before.submissions.submit('one');
  const after = makeSession(host);
  await after.submissions.ready();
  const [one] = after.submissions.read().entries;
  t.is(one.state, 'interrupted');
  await after.submissions.sendNow(one.id);
  t.is(after.started[0]?.text, 'one');
});

test('only the head may cut the running turn short', async t => {
  const { submissions, started } = makeSession(makeHost());
  await submissions.submit('one');
  await started[0].begin();
  const two = await submissions.submit('two');
  const three = await submissions.submit('three');
  t.deepEqual(await submissions.sendNow(three.id), { cancelCurrent: false });
  t.deepEqual(await submissions.sendNow(two.id), { cancelCurrent: true });
  await t.throwsAsync(() => submissions.sendNow('nope'), {
    message: /No queued message/,
  });
});

test('an emergency stop holds the queue past the resume', async t => {
  const { submissions, started, setRefusal } = makeSession(makeHost());
  await submissions.submit('one');
  await started[0].begin();
  await submissions.submit('two');
  setRefusal('Session is stopped');
  await submissions.holdForStop();
  started[0].finish('stopped');
  await settle();
  setRefusal('');
  await submissions.pump();
  t.is(started.length, 1, 'resume never replays a prompt, queued or not');
  t.is(submissions.read().hold?.reason, 'stopped');
});

test('a slot that fills during the accepting write is not a refusal', async t => {
  const host = makeHost();
  const session = makeSession(host);
  const { submissions, started, setRefusal } = session;
  await submissions.ready();
  // A direct `startTurn` lands while the claiming write is in flight: by the
  // time the message is durable, the session admits nothing.
  const accepting = submissions.submit('one');
  setRefusal('Session already has an active turn');
  await accepting;
  t.is(started.length, 0);
  t.deepEqual(texts(submissions), ['one:queued']);
  t.is(submissions.read().hold, null, 'it waits; nobody has to press Send');
  setRefusal('');
  await submissions.pump();
  t.is(started[0]?.text, 'one');
});

test('cancelling the last held message leaves no hold over nothing', async t => {
  const host = makeHost();
  const before = makeSession(host);
  await before.submissions.submit('one');
  await before.started[0].begin();
  await before.submissions.submit('two');
  const after = makeSession(host);
  await after.submissions.ready();
  t.is(after.submissions.read().hold?.reason, 'restart');
  const [two] = after.submissions.read().entries;
  await after.submissions.cancel(two.id);
  t.deepEqual(after.submissions.read(), { entries: [], hold: null });
});

test('a queue that cannot be read is a hold, not a refusal to open the session', async t => {
  /** @type {Map<string, any>} */
  const store = new Map([['floot-pending-3-abc', harden({ version: 99 })]]);
  const host = Far('TestHost', {
    has: name => store.has(name),
    lookup: name => store.get(name),
    storeValue: (value, name) => {
      store.set(name, value);
    },
    remove: name => {
      store.delete(name);
    },
  });
  const { submissions } = makeSession(host);
  await t.notThrowsAsync(() => submissions.ready());
  t.is(submissions.read().hold?.reason, 'unavailable');
  t.regex(`${submissions.read().hold?.message}`, /corrupt/);
  await t.throwsAsync(() => submissions.submit('x'), { message: /corrupt/ });
  // It goes with the session all the same.
  await submissions.destroy();
  t.false(store.has('floot-pending-3-abc'));
});
