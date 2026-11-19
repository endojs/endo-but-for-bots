// @ts-check
// The turn runner's outbox (guest/session/outbox.js): one publish per
// flush with the crank's events in order, a owed `pending` event last with
// the queue's view at flush time, the row patch merged and sent before the
// events, nothing published for a crank without events, inside a turn
// through the ports and outside without, and `schedule` flushing once at
// the end of the crank.
import './_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';

/* eslint-disable import/no-relative-packages */
import { makeOutbox } from '../../guest/session/outbox.js';
/* eslint-enable import/no-relative-packages */

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { Far } = /** @type {GuestGlobals} */ (globalThis);

const drain = () => new Promise(resolve => setImmediate(resolve));

const setup = () => {
  /** @type {any[]} */
  const log = [];
  let view = harden(['a']);
  const live = /** @type {any} */ ({
    inTurn: (/** @type {any} */ ports, /** @type {any[]} */ events) =>
      log.push({ inTurn: ports.name, events }),
    outside: async (/** @type {any[]} */ events) => {
      log.push({ outside: events });
    },
  });
  const rowReporter = Far('RowReporter', {
    changed: (/** @type {any} */ patch) => log.push({ row: patch }),
  });
  const outbox = makeOutbox({ live, rowReporter, pendingView: () => view });
  return {
    log,
    outbox,
    /** @param {any} next */
    setView: next => {
      view = next;
    },
  };
};

test('events in order, the owed pending last with the view at flush, one publish', async t => {
  const { log, outbox, setView } = setup();
  outbox.emit({ type: 'phase', phase: 'thinking' });
  outbox.owePending();
  outbox.emit({ type: 'final', text: 'x' });
  setView(harden(['b']));
  outbox.flushTo(harden({ name: 'p1' }));
  t.deepEqual(log, [
    {
      inTurn: 'p1',
      events: [
        { type: 'phase', phase: 'thinking' },
        { type: 'final', text: 'x' },
        { type: 'pending', pending: ['b'] },
      ],
    },
  ]);
  t.true(Object.isFrozen(log[0].events[0]));
  outbox.flushTo(harden({ name: 'p1' }));
  t.is(log.length, 1, 'nothing left: nothing published');
});

test('the row patch merges, is sent first and once; outside a turn the publish is answered', async t => {
  const { log, outbox } = setup();
  outbox.report({ activity: 'working' });
  outbox.report({ queuedCount: 2, activity: 'passive' });
  outbox.emit({ type: 'end' });
  outbox.flushTo(undefined);
  await drain();
  t.deepEqual(log, [
    { outside: [{ type: 'end' }] },
    { row: { activity: 'passive', queuedCount: 2 } },
  ]);
  log.length = 0;
  outbox.flushRow();
  await drain();
  t.deepEqual(log, [], 'the patch went out once');
});

test('schedule runs the flush once, after the crank', async t => {
  const { outbox } = setup();
  let flushes = 0;
  const flush = () => {
    flushes += 1;
  };
  outbox.schedule(flush);
  outbox.schedule(flush);
  t.is(flushes, 0);
  await drain();
  t.is(flushes, 1);
  outbox.schedule(flush);
  await drain();
  t.is(flushes, 2);
});
