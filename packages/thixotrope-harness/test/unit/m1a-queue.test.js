// @ts-check
// guest/session/queue.js (M1a W1a.5): the FIFO, idempotent enqueueOnce with
// receipts, holds, the atomic claim, previews cut to one frame, and the R4-10
// startTurn refusal.
import './_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';

/* eslint-disable import/no-relative-packages */
import { assertNoActiveTurn, makeQueue } from '../../guest/session/queue.js';
import { limits } from '../../guest/lib/limits.js';
import {
  interfaces,
  shapes,
  texts,
  textOf,
} from '../../guest/lib/interfaces.js';
import { messageBytes } from '../../guest/lib/bounded.js';
/* eslint-enable import/no-relative-packages */

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { Far, M, makeExo, matches } = /** @type {GuestGlobals} */ (globalThis);
/** @type {GuestGlobals['mustMatch']} */
const mustMatch = /** @type {GuestGlobals} */ (globalThis).mustMatch;

const NOW = 1_763_000_000_000;
const UUID = '0123abcd-4567-89ab-cdef-0123456789ab';
/**
 * @param {number} [issued]
 * @param {number} [n]
 */
const rid = (issued = NOW, n = 0) =>
  `${issued}-${UUID.slice(0, 24)}${String(n).padStart(12, '0')}`;
/** @param {string} text */
const sub = text => harden({ text });
const makeTurn = () => Far('Turn', { getStatus: () => undefined });

const counted = () => {
  let changes = 0;
  const queue = makeQueue({
    onChange: () => {
      changes += 1;
    },
  });
  return { queue, changes: () => changes };
};

test('request ids look like the A.4 format', t => {
  t.regex(rid(), /^\d{13}-[0-9a-f-]{36}$/);
  t.not(rid(NOW, 1), rid(NOW, 2));
});

test('FIFO: entries wait in order, first() is the oldest, keys are q<n>', t => {
  const { queue, changes } = counted();
  const a = queue.enqueueOnce(sub('a'), rid(NOW, 1), NOW);
  const b = queue.enqueueOnce(sub('b'), rid(NOW, 2), NOW + 1);
  t.true(a.added);
  t.true(b.added);
  t.is(changes(), 2);
  t.is(queue.size(), 2);
  const head = queue.first();
  t.truthy(head);
  t.is(head?.key, 'q1');
  t.is(head?.submission.text, 'a');
  t.is(head?.requestId, rid(NOW, 1));
  t.is(head?.at, NOW);
  t.is(head?.entry, a.receipt.entry);
  const view = queue.view();
  mustMatch(view, shapes.PendingView);
  t.deepEqual(
    view.entries.map(row => [row.key, row.preview, row.state, row.at]),
    [
      ['q1', 'a', 'queued', NOW],
      ['q2', 'b', 'queued', NOW + 1],
    ],
  );
  t.is(view.hold, undefined);
  for (const { receipt } of [a, b]) {
    mustMatch(receipt, shapes.Receipt);
    t.is(receipt.state, 'queued');
    t.false(receipt.duplicate);
  }
});

test('claim is atomic: entry removed, receipt started with the turn, entry gone', t => {
  const { queue, changes } = counted();
  const { receipt } = queue.enqueueOnce(sub('hi'), rid(), NOW);
  queue.enqueueOnce(sub('next'), rid(NOW, 9), NOW);
  const item = queue.first();
  if (!item) throw Error('no head');
  const turn = makeTurn();
  queue.claim(item, turn);
  t.is(changes(), 3);
  t.is(queue.size(), 1);
  t.is(queue.first()?.key, 'q2');
  const after = queue.receiptFor(rid());
  mustMatch(after, shapes.Receipt);
  t.is(after?.state, 'started');
  t.is(after?.turn, turn);
  t.is(after?.entry, undefined);
  t.throws(() => receipt.entry.describe(), { message: texts.entryGone });
  t.false(receipt.entry.cancel());
  // A second claim of the same item is refused (no double start).
  t.throws(() => queue.claim(item, makeTurn()));
  // A duplicate submission now reports the started turn, not a new entry.
  const again = queue.enqueueOnce(sub('hi'), rid(), NOW + 5);
  t.false(again.added);
  t.true(again.receipt.duplicate);
  t.is(again.receipt.state, 'started');
  t.is(again.receipt.turn, turn);
  t.is(queue.size(), 1);
});

test('enqueueOnce is idempotent per request id; other text is refused', t => {
  const { queue, changes } = counted();
  const first = queue.enqueueOnce(sub('same'), rid(), NOW);
  const dup = queue.enqueueOnce(sub('same'), rid(), NOW + 10);
  t.false(dup.added);
  t.true(dup.receipt.duplicate);
  t.is(dup.receipt.state, 'queued');
  t.is(dup.receipt.entry, first.receipt.entry);
  t.is(queue.size(), 1);
  t.is(changes(), 1);
  t.throws(() => queue.enqueueOnce(sub('other'), rid(), NOW), {
    message: texts.requestIdReused,
  });
  t.is(queue.size(), 1);
  const looked = queue.receiptFor(rid());
  t.false(looked?.duplicate);
  t.is(looked?.entry, first.receipt.entry);
  t.is(queue.receiptFor(rid(NOW, 77)), undefined);
});

test('request id format and window (A.4, Fae pending-queue.js:301-334)', t => {
  const queue = makeQueue();
  for (const bad of [
    'x',
    `${NOW}-${UUID.toUpperCase()}`,
    `${NOW}${UUID}`,
    `${String(NOW).slice(1)}-${UUID}`,
    `${NOW}-${UUID}0`,
  ]) {
    t.throws(() => queue.enqueueOnce(sub('t'), bad, NOW), {
      message: texts.invalidRequestId,
    });
  }
  // issued must be > at - retryWindowMs and <= at + clockSkewMs.
  t.throws(
    () => queue.enqueueOnce(sub('t'), rid(NOW - limits.retryWindowMs), NOW),
    { message: texts.requestIdExpired },
  );
  t.true(
    queue.enqueueOnce(sub('t'), rid(NOW - limits.retryWindowMs + 1), NOW).added,
  );
  t.true(
    queue.enqueueOnce(sub('t'), rid(NOW + limits.clockSkewMs, 1), NOW).added,
  );
  t.throws(
    () =>
      queue.enqueueOnce(sub('t'), rid(NOW + limits.clockSkewMs + 1, 2), NOW),
    { message: texts.requestIdExpired },
  );
  t.is(queue.size(), 2);
});

test('a full queue refuses with the R4-53 text and keeps no receipt', t => {
  const queue = makeQueue();
  for (let i = 0; i < limits.maxWaiting; i += 1) {
    queue.enqueueOnce(sub(`m${i}`), rid(NOW, i), NOW);
  }
  t.throws(() => queue.enqueueOnce(sub('over'), rid(NOW, 1000), NOW), {
    message: textOf.queueFull(100),
  });
  t.is(queue.receiptFor(rid(NOW, 1000)), undefined);
  // After a cancel there is room again.
  const head = queue.first();
  t.true(head?.entry.cancel());
  t.true(queue.enqueueOnce(sub('over'), rid(NOW, 1000), NOW).added);
  t.is(queue.size(), limits.maxWaiting);
});

test('receipts are pruned by age and bounded at maxReceipts', t => {
  const queue = makeQueue();
  // Fill the receipt table with claimed submissions (the queue stays small).
  const turn = makeTurn();
  for (let i = 0; i < limits.maxReceipts; i += 1) {
    queue.enqueueOnce(sub('r'), rid(NOW + i, i), NOW + i);
    const item = queue.first();
    if (!item) throw Error('no head');
    queue.claim(item, turn);
  }
  t.throws(() => queue.enqueueOnce(sub('r'), rid(NOW + 5000, 99_999), NOW), {
    message: texts.receiptLimit,
  });
  // A day later the oldest receipts expire and make room.
  const later = NOW + limits.retryWindowMs + 10;
  t.true(queue.enqueueOnce(sub('r'), rid(later, 99_999), later).added);
  t.is(queue.receiptFor(rid(NOW, 0)), undefined);
  t.is(queue.receiptFor(rid(NOW + 10, 10)), undefined);
  t.is(queue.receiptFor(rid(NOW + 11, 11))?.state, 'started');
});

test('an expired receipt behind a live one is pruned when the table is full', t => {
  const queue = makeQueue();
  const turn = makeTurn();
  /**
   * @param {string} id
   * @param {number} at
   */
  const take = (id, at) => {
    queue.enqueueOnce(sub('r'), id, at);
    const item = queue.first();
    if (!item) throw Error('no head');
    queue.claim(item, turn);
  };
  // Inserted first but issued late (a fast device clock): stays live.
  take(rid(NOW + 200_000, 1), NOW);
  // Inserted second but issued early: expires first.
  const early = rid(NOW - limits.retryWindowMs + 5, 2);
  take(early, NOW);
  const later = NOW + 10;
  take(rid(later, 3), later);
  // Not pruned yet (the oldest inserted receipt is live) ...
  t.is(queue.receiptFor(early)?.state, 'started');
  // ... but its id is refused as expired before any lookup.
  t.throws(() => queue.enqueueOnce(sub('r'), early, later), {
    message: texts.requestIdExpired,
  });
  // Fill the table: the full scan drops the expired receipt to make room.
  for (let i = 4; queue.receiptFor(early) !== undefined; i += 1) {
    take(rid(later, i), later);
    if (i > limits.maxReceipts + 2) throw Error('never pruned');
  }
  t.is(queue.receiptFor(rid(NOW + 200_000, 1))?.state, 'started');
});

test('holds: first() is undefined while held; a new message releases all but interrupted', t => {
  const { queue, changes } = counted();
  queue.enqueueOnce(sub('a'), rid(NOW, 1), NOW);
  queue.hold('restart', texts.holdRestart);
  t.is(changes(), 2);
  t.is(queue.holdReason(), 'restart');
  t.is(queue.first(), undefined);
  const view = queue.view();
  mustMatch(view, shapes.PendingView);
  t.deepEqual(view.hold, { reason: 'restart', message: texts.holdRestart });
  // The same hold again is no change.
  queue.hold('restart', texts.holdRestart);
  t.is(changes(), 2);
  // A duplicate is a retry, not a new message: the hold stays.
  queue.enqueueOnce(sub('a'), rid(NOW, 1), NOW);
  t.is(queue.holdReason(), 'restart');
  // A new message releases it; the oldest entry is first.
  queue.enqueueOnce(sub('b'), rid(NOW, 2), NOW);
  t.is(queue.holdReason(), undefined);
  t.is(queue.first()?.submission.text, 'a');
  // interrupted is released only by a decision about that message.
  queue.hold('interrupted', texts.holdInterrupted);
  queue.enqueueOnce(sub('c'), rid(NOW, 3), NOW);
  t.is(queue.holdReason(), 'interrupted');
  queue.release();
  t.is(queue.holdReason(), 'interrupted');
  // No other reason replaces interrupted.
  queue.hold('restart', texts.holdRestart);
  t.is(queue.holdReason(), 'interrupted');
});

test('release() lifts restart, stopped and refused holds', t => {
  const queue = makeQueue();
  queue.enqueueOnce(sub('a'), rid(), NOW);
  for (const [reason, message] of /** @type {const} */ ([
    ['restart', texts.holdRestart],
    ['stopped', texts.holdStopped],
    ['refused', textOf.holdRefused('no')],
  ])) {
    queue.hold(reason, message);
    t.is(queue.first(), undefined);
    queue.release();
    t.is(queue.holdReason(), undefined);
    t.is(queue.first()?.submission.text, 'a');
  }
});

test('cancelling the last waiting entry clears the hold (nothing left to hold)', t => {
  const queue = makeQueue();
  const a = queue.enqueueOnce(sub('a'), rid(NOW, 1), NOW);
  const b = queue.enqueueOnce(sub('b'), rid(NOW, 2), NOW);
  queue.hold('restart', texts.holdRestart);
  t.true(a.receipt.entry.cancel());
  t.is(queue.holdReason(), 'restart');
  t.false(a.receipt.entry.cancel());
  t.true(b.receipt.entry.cancel());
  t.is(queue.holdReason(), undefined);
  t.is(queue.size(), 0);
  // A cancelled entry's receipt stays: a retry does not resurrect it.
  const retry = queue.enqueueOnce(sub('a'), rid(NOW, 1), NOW);
  t.false(retry.added);
  t.is(queue.size(), 0);
});

test('QueueEntry is guarded and describes itself', t => {
  const queue = makeQueue();
  const { receipt } = queue.enqueueOnce(sub('x'.repeat(2000)), rid(), NOW);
  const { entry } = receipt;
  const info = entry.describe();
  mustMatch(info, shapes.EntryInfo);
  t.is(info.preview.length, limits.messagePreviewUnits);
  t.is(info.key, 'q1');
  t.throws(() => entry.describe('extra'));
  t.true(matches(entry, M.remotable('QueueEntry')));
  // The same guard as the contract's.
  const probe = makeExo('QueueEntry', interfaces.QueueEntry, {
    describe: () => info,
    cancel: () => false,
  });
  t.deepEqual(Object.keys(probe).sort(), Object.keys(entry).sort());
});

test('previews are cut so 100 long multi-byte entries plus a hold fit one frame', t => {
  const queue = makeQueue();
  // 3 bytes per unit; the longest inline text the session admits since
  // J-9369 (inlineBytes of UTF-8; longer text arrives staged, its preview
  // already cut to messagePreviewUnits).
  const euro = '€'.repeat(Math.floor(limits.inlineBytes / 3));
  for (let i = 0; i < limits.maxWaiting; i += 1) {
    queue.enqueueOnce(sub(euro), rid(NOW, i), NOW);
  }
  queue.hold('refused', textOf.holdRefused('€'.repeat(1300)));
  const view = queue.view();
  mustMatch(view, shapes.PendingView);
  const bytes = messageBytes(view);
  t.true(bytes <= limits.frameBytes, `${bytes} bytes`);
  t.true(view.entries[0].preview.length > 0);
  // Few entries keep the full preview.
  const small = makeQueue();
  small.enqueueOnce(sub(euro), rid(), NOW);
  t.is(small.view().entries[0].preview.length, limits.messagePreviewUnits);
  // Surrogate pairs are never split by the cut.
  const pairs = makeQueue();
  for (let i = 0; i < limits.maxWaiting; i += 1) {
    pairs.enqueueOnce(
      sub('\u{1F600}'.repeat(limits.inlineBytes / 4)),
      rid(NOW, i),
      NOW,
    );
  }
  const pairView = pairs.view();
  t.true(messageBytes(pairView) <= limits.frameBytes);
  for (const row of pairView.entries) {
    t.is(row.preview.length % 2, 0);
  }
});

test('an onChange that throws does not undo or refuse the change', t => {
  const queue = makeQueue({
    onChange: () => {
      throw Error('publish failed');
    },
  });
  const { added } = queue.enqueueOnce(sub('a'), rid(), NOW);
  t.true(added);
  t.is(queue.size(), 1);
});

test('startTurn refusal text (R4-10)', t => {
  t.notThrows(() => assertNoActiveTurn(undefined));
  t.throws(() => assertNoActiveTurn({ turnId: 't1' }), {
    message: 'Session already has an active turn; observe or cancel it first',
  });
});
