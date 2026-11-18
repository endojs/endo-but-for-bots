// @ts-check
// M2 W2.4: Fae `test/session/session-submissions.test.js` (at `1315bef86`)
// ported to the session's queue (guest/session/{queue,submissions,holds}.js
// through the real session with in-memory fakes, `_m2-queue-session.js`),
// plus send-now and the release rule of R4-56 (m2-interfaces.md 5).
//
// Fae cases that do not apply, and why (JOURNAL J-0451):
// - "incarnation close drains an admitted queue write ...": no incarnation
//   of the submissions object to close; every queue operation is one crank.
// - "a start that throws is held the same way", "a session that admits no
//   work holds nothing against the queue", "a slot that fills during the
//   accepting write is not a refusal": M2 has no refusal in the claim crank
//   (a failing backend fails the turn after its claim, R4-79) and no write
//   between the check and the claim (crank A is atomic); the observable rule
//   each tests (a `refused` hold, released by a new message, which runs the
//   older one first; nothing held while a turn simply runs) is ported below.
// - "a dispatch interrupted by a restart is never repeated on its own",
//   "sending an interrupted message again is the other decision": no entry
//   can be found half-claimed (architecture 4.3), so there is no
//   `interrupted` entry and no decision about one; the `interrupted` hold
//   exists for the shape only, and that a new message does not release it
//   is checked below.
// - "a queue that cannot be read is a hold, not a refusal": the queue is
//   the vat's heap; `unavailable` cannot happen (its text is checked in
//   m2-queue-pending.test.js).
// - "only the head may cut the running turn short": send-now moves the
//   entry to the head first, so it is always the head that cuts the running
//   turn short (R6-44, 5.1; tested below).
import './_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';

/* eslint-disable import/no-relative-packages */
import { texts } from '../../guest/lib/interfaces.js';
import { holdTexts } from '../../guest/session/holds.js';
import { makeQueue } from '../../guest/session/queue.js';
/* eslint-enable import/no-relative-packages */
import { drain, makeQueueSession, requestId } from './_m2-queue-session.js';

/**
 * A session whose queue the test can hold directly (as M6's stop would).
 */
const withQueueHandle = async () => {
  /** @type {any} */
  let queue;
  const s = await makeQueueSession({
    makeQueue: (/** @type {any} */ options) => {
      queue = makeQueue(options);
      return queue;
    },
  });
  return { ...s, queue };
};

test('an idle session starts a message at once; the entry leaves in that crank', async t => {
  const s = await makeQueueSession();
  const receipt = await s.submit('one');
  t.is(receipt.state, 'started');
  t.deepEqual(s.sent(), ['one']);
  t.deepEqual(s.pending(), [], 'the transcript has it; the queue let go');
  await s.finish();
  t.deepEqual(s.sent(), ['one'], 'nothing else starts');
});

test('messages sent mid-turn wait, then run one at a time in order', async t => {
  const s = await makeQueueSession();
  await s.submit('one');
  await s.submit('two');
  await s.submit('three');
  t.deepEqual(s.sent(), ['one']);
  t.deepEqual(s.pending(), ['two', 'three']);
  await s.finish();
  t.deepEqual(s.sent(), ['one', 'two']);
  // A turn that ran and failed is the transcript's business; the queue moves on.
  const req = s.rounds[s.rounds.length - 1];
  req.sink.dispatching(0);
  req.sink.roundFailed(
    harden({ round: 0, reason: 'the model fell over', at: 1_700_000_000_002 }),
  );
  await drain();
  t.deepEqual(s.sent(), ['one', 'two', 'three']);
});

test('an edit is what runs, and a cancelled message never does', async t => {
  const s = await makeQueueSession();
  await s.submit('one');
  const two = await s.submit('two');
  const three = await s.submit('three');
  three.entry.edit(harden({ text: 'three, revised' }));
  t.true(two.entry.cancel());
  await s.finish();
  t.deepEqual(s.sent(), ['one', 'three, revised']);
});

test('a refused hold waits for the user: a settle does not release it, send-now does', async t => {
  const s = await withQueueHandle();
  await s.submit('one');
  await s.submit('two');
  s.queue.hold('refused', holdTexts.refused('Turn journal needs recovery'));
  await s.finish();
  t.deepEqual(s.sent(), ['one'], 'no retry loop');
  t.deepEqual(s.pending(), ['two']);
  t.is(s.hold()?.reason, 'refused');
  t.is(s.hold()?.message, 'Not sent: Turn journal needs recovery');
  const [row] = s.session.listPending().entries;
  row.entry.sendNow();
  await drain();
  t.deepEqual(s.sent(), ['one', 'two']);
  t.is(s.hold(), undefined);
});

test('a new message releases a refused hold, and the older message runs first', async t => {
  const s = await withQueueHandle();
  await s.submit('one');
  await s.submit('two');
  s.queue.hold('refused', holdTexts.refused());
  t.is(s.hold()?.message, texts.holdRefusedDefault);
  await s.finish();
  t.deepEqual(s.sent(), ['one']);
  await s.submit('three');
  t.deepEqual(s.sent(), ['one', 'two'], 'FIFO: the held one goes first');
  t.deepEqual(s.pending(), ['three']);
});

test('what was queued before a restart waits for the user (R4-56, acceptance 5)', async t => {
  const s = await makeQueueSession();
  await s.submit('one');
  await s.submit('two');
  await s.submit('three');
  await s.restartAdapter();
  t.deepEqual(s.pending(), ['two', 'three']);
  t.deepEqual(s.hold(), { reason: 'restart', message: texts.holdRestart });
  t.deepEqual(s.sent(), ['one'], 'nothing is sent with nobody watching');
  const [two] = s.session.listPending().entries;
  two.entry.sendNow();
  await drain();
  t.deepEqual(s.sent(), ['one', 'two']);
  t.is(s.hold(), undefined);
  await s.finish();
  t.deepEqual(s.sent(), ['one', 'two', 'three'], 'the rest follow, in order');
});

test('after a restart a new message releases the hold and the old ones go first (acceptance 5)', async t => {
  const s = await makeQueueSession();
  await s.submit('one');
  await s.submit('two');
  await s.restartAdapter();
  t.is(s.hold()?.reason, 'restart');
  await s.submit('three');
  t.deepEqual(s.sent(), ['one', 'two']);
  t.deepEqual(s.pending(), ['three']);
  await s.finish();
  t.deepEqual(s.sent(), ['one', 'two', 'three']);
});

test('send-now on a later entry moves it to the head; the running turn is cancelled, it runs next, the others keep their order', async t => {
  const s = await makeQueueSession();
  await s.submit('one');
  await s.submit('two');
  const three = await s.submit('three');
  await s.submit('four');
  three.entry.sendNow();
  await drain();
  t.deepEqual(s.sent(), ['one', 'three'], 'R6-44: the running turn is cut');
  t.deepEqual(s.pending(), ['two', 'four']);
  await s.finish();
  t.deepEqual(s.sent(), ['one', 'three', 'two']);
  // send-now on an entry no longer waiting
  t.throws(() => three.entry.sendNow(), { message: texts.entryGone });
});

test('send-now while restart-held moves the entry first and releases the hold', async t => {
  const s = await makeQueueSession();
  await s.submit('one');
  await s.submit('two');
  await s.submit('three');
  await s.restartAdapter();
  const rows = s.session.listPending().entries;
  rows[1].entry.sendNow();
  await drain();
  t.deepEqual(s.sent(), ['one', 'three']);
  t.deepEqual(s.pending(), ['two']);
});

test('an emergency stop holds the queue past the turn that ends', async t => {
  const s = await withQueueHandle();
  await s.submit('one');
  await s.submit('two');
  s.queue.hold('stopped', holdTexts.stopped());
  await s.finish('stopped');
  t.deepEqual(s.sent(), ['one'], 'a settle never claims a held queue');
  t.deepEqual(s.hold(), { reason: 'stopped', message: texts.holdStopped });
});

test('an interrupted hold is released by no new message (it needs a decision)', async t => {
  const s = await withQueueHandle();
  await s.submit('one');
  await s.submit('two');
  s.queue.hold('interrupted', holdTexts.interrupted());
  await s.finish();
  await s.submit('three');
  t.deepEqual(s.sent(), ['one']);
  t.is(s.hold()?.reason, 'interrupted');
  // No other hold replaces it.
  s.queue.hold('restart', holdTexts.restart());
  t.is(s.hold()?.reason, 'interrupted');
  const [first] = s.session.listPending().entries;
  first.entry.sendNow();
  await drain();
  t.deepEqual(s.sent(), ['one'], 'send-now does not release it either');
});

test('cancelling the last held message leaves no hold over nothing', async t => {
  const s = await makeQueueSession();
  await s.submit('one');
  await s.submit('two');
  await s.restartAdapter();
  t.is(s.hold()?.reason, 'restart');
  const [two] = s.session.listPending().entries;
  t.true(two.entry.cancel());
  t.deepEqual(s.session.listPending(), { entries: [] });
});

test('a duplicate submission neither starts twice nor releases a restart hold', async t => {
  const s = await makeQueueSession();
  const id = requestId();
  const a = await s.submit('only once', id);
  const b = await s.submit('only once', id);
  t.true(b.duplicate);
  t.is(b.requestId, a.requestId);
  t.is(b.turn, a.turn);
  t.deepEqual(s.sent(), ['only once']);
  const waiting = requestId();
  await s.submit('waits', waiting);
  await s.restartAdapter();
  const hold = s.hold();
  t.is(hold?.reason, 'restart');
  const again = await s.submit('waits', waiting);
  t.true(again.duplicate);
  t.is(again.state, 'queued');
  t.deepEqual(s.hold(), hold, 'a duplicate releases nothing');
  t.deepEqual(s.sent(), ['only once']);
});

test('send-now when idle claims in the same crank (crank A)', async t => {
  const s = await withQueueHandle();
  await s.submit('one');
  await s.submit('two');
  s.queue.hold('stopped', holdTexts.stopped());
  await s.finish();
  t.deepEqual(s.sent(), ['one']);
  const [two] = s.session.listPending().entries;
  const before = s.rounds.length;
  two.entry.sendNow();
  // The claim is in this crank: the turn is current before any drain.
  t.is(s.session.getCurrentTurn()?.input, 'two');
  await drain();
  t.is(s.rounds.length, before + 1);
  t.deepEqual(s.sent(), ['one', 'two']);
  t.is(s.hold(), undefined);
});

test('an edit publishes pending once and keeps key, place and time', async t => {
  const s = await makeQueueSession();
  await s.submit('one');
  await s.submit('two');
  await s.submit('three');
  const before = s.session.listPending().entries;
  const published = s.published.length;
  before[0].entry.edit(harden({ text: 'two, edited' }));
  await drain();
  const after = s.session.listPending().entries;
  t.deepEqual(
    after.map((/** @type {any} */ r) => [r.key, r.preview, r.at]),
    [
      [before[0].key, 'two, edited', before[0].at],
      [before[1].key, 'three', before[1].at],
    ],
  );
  t.is(s.published.length, published + 1);
  const events = s.published[published].events.map(
    (/** @type {any} */ e) => e.type,
  );
  t.deepEqual(events, ['pending']);
});

test('started receipts keep the turn id; turn is handed out while the session keeps it', async t => {
  const s = await makeQueueSession();
  const id = requestId();
  const r = await s.submit('one', id);
  t.is(r.state, 'started');
  t.is(r.turnId, 't1');
  t.is(r.turn, s.session.getCurrentTurn().turn);
  await s.finish();
  const looked = s.session.getSubmissionReceipt(id);
  t.is(looked?.turnId, 't1');
  t.truthy(looked?.turn);
  t.is(looked?.entry, undefined);
  t.is(looked?.duplicate, false);
});

test('R6-44: send-now while a turn runs cancels it, and the entry goes next', async t => {
  const s = await withQueueHandle();
  await s.submit('one');
  await s.submit('two');
  await s.submit('three');
  const running = s.session.getCurrentTurn();
  t.is(running?.input, 'one');
  const [, three] = s.session.listPending().entries;
  three.entry.sendNow();
  await drain();
  t.is(s.session.getCurrentTurn()?.input, 'three', 'three runs next');
  t.deepEqual(s.pending(), ['two']);
  t.deepEqual(s.sent(), ['one', 'three']);
  // Held by `interrupted`: send-now neither claims nor cancels.
  s.queue.hold('interrupted', holdTexts.interrupted());
  const [two] = s.session.listPending().entries;
  two.entry.sendNow();
  await drain();
  t.is(s.session.getCurrentTurn()?.input, 'three', 'not cancelled');
});
