// @ts-check
// M2 W2.4: Fae `test/session/pending-queue.test.js` (at `1315bef86`) ported
// to guest/lib/pending-queue.js and guest/session/queue.js (heap Maps, no
// pet names; m2-interfaces.md 5), plus edit, send-now's move to the head,
// duplicates by staged digest, receipts without handles (5.3), and the hold
// texts and release rule (holds.js, holds-table.js).
//
// Fae cases that do not apply, and why (JOURNAL J-0451):
// - "what is queued survives the process that queued it" (the persistence
//   part), "a failed write changes nothing, and the queue goes by what was
//   written", "a claim whose write failed is not dispatched", "a corrupt
//   record is refused, not adopted", "idle receipt pruning recovers from
//   failed persistence": there is no record to write or read: the vat's
//   heap is the record (orthogonal persistence); restarts are covered by
//   the integration files. The observable parts (order kept; a refused
//   enqueue changes nothing and reports nothing; expired ids refused) are
//   ported below.
// - "dispatch is at most once across a crash", "a refused turn puts its
//   message back; a journaled one lets go of it", "a lost enqueue
//   acknowledgement and reconnect retain one durable submission" (its
//   `interrupted` part): the claim is atomic (architecture 4.3): no
//   `dispatching` or `interrupted` entry, no `release` or `retry`. The
//   one-claim-at-a-time and duplicate-after-claim parts are ported.
// - "the record goes with the session", "a record that cannot be read does
//   not make its session undeletable": session delete is W2.7.
// - "inventory references survive restart privately ...", "queued
//   attachments must be explicitly cancelled and recomposed to edit":
//   mentions and attachments are M5.
// Differences kept on purpose: the text is not trimmed (M1a stores what was
// submitted); cancelling an entry that already started answers false
// (contract 8) instead of throwing "already being sent".
import './_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';

/* eslint-disable import/no-relative-packages */
import { limits } from '../../guest/lib/limits.js';
import {
  interfaces,
  shapes,
  textOf,
  texts,
} from '../../guest/lib/interfaces.js';
import {
  fingerprintOf,
  makePendingQueue,
  sameFingerprint,
} from '../../guest/lib/pending-queue.js';
import { makeQueue } from '../../guest/session/queue.js';
import { holdsTable } from '../../guest/session/holds-table.js';
import { holdText, holdTexts, releaseRule } from '../../guest/session/holds.js';
/* eslint-enable import/no-relative-packages */

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { Far, M, makeExo, matches } = /** @type {GuestGlobals} */ (globalThis);

const NOW = 1_800_000_000_000;
let serial = 0;
/** @param {number} [issued] */
const rid = (issued = NOW) => {
  serial += 1;
  return `${issued}-11111111-1111-4111-8111-${`${serial}`.padStart(12, '0')}`;
};
/** @param {string} text */
const sub = text => harden({ text });
/**
 * @param {string} preview
 * @param {string} [digest]
 * @param {number} [bytes]
 */
const staged = (preview, digest, bytes = 9000) =>
  harden({
    blob: Far('Blob', {}),
    preview,
    bytes,
    ...(digest === undefined ? {} : { digest }),
  });

const counted = () => {
  let changes = 0;
  const queue = makeQueue({
    onChange: () => {
      changes += 1;
    },
  });
  return { queue, changes: () => changes };
};

/** @param {any} queue */
const previews = queue =>
  queue.view().entries.map((/** @type {any} */ row) => row.preview);

/**
 * @param {any} queue
 * @param {any} turnId
 */
const claimHead = (queue, turnId) => {
  const item = queue.first();
  if (item === undefined) throw Error('nothing to claim');
  queue.claim(item, turnId);
  return item;
};

test('what is queued waits in order; keys are distinct; cancelling all leaves nothing', t => {
  const { queue } = counted();
  const a = queue.enqueueOnce(sub('one'), rid(), NOW);
  const b = queue.enqueueOnce(sub('two'), rid(), NOW + 1);
  t.deepEqual(a.receipt.entry.describe(), {
    key: 'q1',
    preview: 'one',
    state: 'queued',
    at: NOW,
  });
  t.not(b.receipt.entry.describe().key, 'q1');
  t.deepEqual(previews(queue), ['one', 'two']);
  t.true(a.receipt.entry.cancel());
  t.true(b.receipt.entry.cancel());
  t.deepEqual(queue.view(), { entries: [] });
});

test('a key is never reissued, and a stale entry cannot address a new message', t => {
  const { queue } = counted();
  const one = queue.enqueueOnce(sub('one'), rid(), NOW);
  claimHead(queue, 't1');
  t.is(queue.size(), 0);
  const two = queue.enqueueOnce(sub('two'), rid(), NOW);
  t.not(two.receipt.entry.describe().key, 'q1');
  t.false(one.receipt.entry.cancel(), 'the old handle reaches nothing');
  t.is(queue.size(), 1);
});

test('one claim at a time: a claimed entry is gone and cannot be claimed again', t => {
  const { queue } = counted();
  queue.enqueueOnce(sub('one'), rid(), NOW);
  queue.enqueueOnce(sub('two'), rid(), NOW);
  const item = claimHead(queue, 't1');
  t.throws(() => queue.claim(item, 't2'));
  t.is(queue.first()?.submission.text, 'two');
});

test('an idle enqueue never jumps the queue: the head is the oldest', t => {
  const { queue } = counted();
  queue.enqueueOnce(sub('one'), rid(), NOW);
  queue.enqueueOnce(sub('two'), rid(), NOW);
  t.is(queue.first()?.submission.text, 'one');
});

test('a message can be edited or cancelled until it starts', t => {
  const { queue, changes } = counted();
  const p1 = queue.enqueueOnce(sub('one'), rid(), NOW).receipt.entry;
  const p2 = queue.enqueueOnce(sub('two'), rid(), NOW).receipt.entry;
  const before = changes();
  p2.edit(sub(' two, revised '));
  t.is(changes(), before + 1, 'one change: one pending publish');
  t.is(previews(queue)[1], ' two, revised ');
  t.throws(() => p2.edit(sub('   ')), { message: texts.blankSubmission });
  t.is(previews(queue)[1], ' two, revised ', 'an empty edit changes nothing');
  t.is(changes(), before + 1);
  claimHead(queue, 't1');
  t.throws(() => p1.edit(sub('late')), { message: texts.entryGone });
  t.false(p1.cancel(), 'an entry that started cannot be cancelled');
  t.true(p2.cancel());
  t.false(p2.cancel(), 'cancelling twice is not an error');
  t.throws(() => p2.edit(sub('x')), { message: texts.entryGone });
  t.throws(() => queue.enqueueOnce(sub('  '), rid(), NOW), {
    message: texts.blankSubmission,
  });
});

test('edit keeps key, place, time and request id; the receipt keeps what was submitted', t => {
  const { queue } = counted();
  const id = rid();
  const { receipt } = queue.enqueueOnce(sub('original'), id, NOW);
  queue.enqueueOnce(sub('next'), rid(), NOW + 5);
  receipt.entry.edit(sub('edited'));
  t.deepEqual(receipt.entry.describe(), {
    key: 'q1',
    preview: 'edited',
    state: 'queued',
    at: NOW,
  });
  const head = queue.first();
  t.is(head?.requestId, id);
  t.is(head?.submission.text, 'edited');
  // A retry of the original submission is still a duplicate (Fae keeps the
  // receipt's digest of the accepted text).
  const retry = queue.enqueueOnce(sub('original'), id, NOW + 10);
  t.false(retry.added);
  t.true(retry.receipt.duplicate);
  t.throws(() => queue.enqueueOnce(sub('edited'), id, NOW + 10), {
    message: texts.requestIdReused,
  });
});

test('edit takes a staged text and refuses inline text over inlineBytes', t => {
  const { queue } = counted();
  const { receipt } = queue.enqueueOnce(sub('short'), rid(), NOW);
  const big = staged('a long preview');
  receipt.entry.edit(big);
  t.is(queue.first()?.submission, big);
  t.is(previews(queue)[0], 'a long preview');
  const over = 'é'.repeat(limits.inlineBytes / 2 + 1);
  t.throws(() => receipt.entry.edit(sub(over)), {
    message: textOf.inlineTooLarge(limits.inlineBytes + 2, limits.inlineBytes),
  });
  t.is(queue.first()?.submission, big);
});

test('QueueEntry is on the M2 guard: edit and sendNow exist; an oversize edit is refused by the guard', t => {
  const { queue } = counted();
  const { receipt } = queue.enqueueOnce(sub('x'), rid(), NOW);
  t.true(matches(receipt.entry, M.remotable('QueueEntry')));
  t.is(typeof receipt.entry.edit, 'function');
  t.is(typeof receipt.entry.sendNow, 'function');
  t.throws(() => receipt.entry.edit(sub('y'.repeat(limits.inlineBytes * 2))));
  t.throws(() => receipt.entry.edit(harden({ text: 'z', extra: 1 })));
  // The guard is the M2 one.
  t.notThrows(() =>
    makeExo('QueueEntry', /** @type {any} */ (interfaces.QueueEntry), {
      describe: () => undefined,
      cancel: () => false,
      edit: () => undefined,
      sendNow: () => undefined,
    }),
  );
});

test('only so many messages wait at once, however many a session sends in its life', t => {
  const { queue, changes } = counted();
  for (let i = 0; i < limits.maxWaiting; i += 1) {
    queue.enqueueOnce(sub(`message ${i}`), rid(), NOW);
  }
  const before = changes();
  const id = rid();
  t.throws(() => queue.enqueueOnce(sub('one too many'), id, NOW), {
    message: textOf.queueFull(limits.maxWaiting),
  });
  t.is(
    textOf.queueFull(limits.maxWaiting),
    'This session already has 100 messages waiting; send or delete some first',
  );
  t.is(changes(), before, 'a refusal changes nothing and reports nothing');
  t.is(queue.receiptFor(id), undefined, 'and keeps no receipt');
  // Not a lifetime count: make room and it is accepted.
  queue.view().entries[0].entry.cancel();
  t.true(queue.enqueueOnce(sub('now there is room'), id, NOW).added);
});

test('enqueues land in order; a cancel then a claim takes the next head', t => {
  const { queue } = counted();
  const a = queue.enqueueOnce(sub('a'), rid(), NOW);
  queue.enqueueOnce(sub('b'), rid(), NOW);
  t.deepEqual(previews(queue), ['a', 'b']);
  t.true(a.receipt.entry.cancel());
  t.is(claimHead(queue, 't1').submission.text, 'b');
});

test('a retried submission after its claim is a duplicate: one entry, the started turn', t => {
  const { queue } = counted();
  const id = rid();
  queue.enqueueOnce(sub('one'), id, NOW);
  claimHead(queue, 't7');
  const again = queue.enqueueOnce(sub('one'), id, NOW + 1);
  t.false(again.added);
  t.true(again.receipt.duplicate);
  t.is(again.receipt.state, 'started');
  t.is(again.receipt.turnId, 't7');
  t.is(queue.size(), 0, 'a completed submission cannot be queued twice');
  t.throws(() => queue.enqueueOnce(sub('different'), id, NOW + 2), {
    message: texts.requestIdReused,
  });
});

test('duplicate sends share a receipt; an expired id is refused after the window', t => {
  const { queue } = counted();
  const id = rid();
  const a = queue.enqueueOnce(sub('one'), id, NOW);
  const b = queue.enqueueOnce(sub('one'), id, NOW);
  t.is(a.receipt.requestId, b.receipt.requestId);
  t.is(a.receipt.entry, b.receipt.entry);
  t.is(queue.size(), 1);
  claimHead(queue, 't1');
  t.throws(
    () => queue.enqueueOnce(sub('one'), id, NOW + limits.retryWindowMs),
    { message: texts.requestIdExpired },
  );
  t.is(queue.size(), 0);
});

test('the request id window is the Composer stamp: 24 h back, 5 min ahead', t => {
  const { queue } = counted();
  t.throws(() => queue.enqueueOnce(sub('x'), 'not-an-id', NOW), {
    message: texts.invalidRequestId,
  });
  t.throws(
    () => queue.enqueueOnce(sub('x'), rid(NOW + limits.clockSkewMs + 1), NOW),
    { message: texts.requestIdExpired },
  );
  t.true(queue.enqueueOnce(sub('x'), rid(NOW + limits.clockSkewMs), NOW).added);
  t.throws(
    () => queue.enqueueOnce(sub('x'), rid(NOW - limits.retryWindowMs), NOW),
    { message: texts.requestIdExpired },
  );
  t.true(
    queue.enqueueOnce(sub('x'), rid(NOW - limits.retryWindowMs + 1), NOW).added,
  );
});

test('pruning by age keeps waiting entries and live duplicate receipts', t => {
  const { queue } = counted();
  const oldId = rid(NOW);
  queue.enqueueOnce(sub('old'), oldId, NOW);
  const validId = rid(NOW + 12 * 3_600_000);
  queue.enqueueOnce(sub('valid'), validId, NOW + 12 * 3_600_000);
  const later = NOW + 24 * 3_600_000;
  queue.enqueueOnce(sub('later'), rid(later), later);
  t.is(queue.receiptFor(oldId), undefined, 'the old receipt was pruned');
  t.deepEqual(previews(queue), ['old', 'valid', 'later'], 'entries stay');
  t.true(queue.enqueueOnce(sub('valid'), validId, later).receipt.duplicate);
});

test('duplicates by staged digest: same digest and bytes match; others are reused ids', t => {
  const { queue } = counted();
  const id = rid();
  const first = staged('p', 'a'.repeat(64));
  queue.enqueueOnce(first, id, NOW);
  // The retry staged the same text again: another Blob, the same digest.
  const retry = queue.enqueueOnce(staged('p', 'a'.repeat(64)), id, NOW);
  t.true(retry.receipt.duplicate);
  t.throws(() => queue.enqueueOnce(staged('p', 'b'.repeat(64)), id, NOW), {
    message: texts.requestIdReused,
  });
  t.throws(
    () => queue.enqueueOnce(staged('p', 'a'.repeat(64), 9001), id, NOW),
    { message: texts.requestIdReused },
  );
  t.throws(() => queue.enqueueOnce(staged('p'), id, NOW), {
    message: texts.requestIdReused,
  });
  t.throws(() => queue.enqueueOnce(sub('p'), id, NOW), {
    message: texts.requestIdReused,
  });
  // Without digests (staged before J-9363): bytes and preview.
  const old = rid();
  queue.enqueueOnce(staged('q'), old, NOW);
  t.true(queue.enqueueOnce(staged('q'), old, NOW).receipt.duplicate);
  t.throws(() => queue.enqueueOnce(staged('r'), old, NOW), {
    message: texts.requestIdReused,
  });
});

test('fingerprints keep no Blob handle (m2-interfaces.md 5.3)', t => {
  const s = staged('p', 'c'.repeat(64));
  const fp = fingerprintOf(s);
  t.deepEqual(fp, { bytes: 9000, digest: 'c'.repeat(64) });
  t.true(sameFingerprint(fp, s));
  t.deepEqual(fingerprintOf(staged('p')), { bytes: 9000, preview: 'p' });
  t.is(fingerprintOf(sub('inline')), 'inline');
  t.false(sameFingerprint('inline', s));
});

test('pending-queue alone: toHead keeps the others in order; take records the turn id', t => {
  /** @type {any[]} */
  const made = [];
  const pending = makePendingQueue({
    makeEntry: internal => {
      const entry = Far('QueueEntry', {});
      made.push({ entry, internal });
      return entry;
    },
  });
  for (const text of ['a', 'b', 'c', 'd'])
    pending.enqueue(sub(text), rid(), NOW);
  const order = () => [...pending.entries()].map(i => i.item.submission.text);
  const c = made[2].internal;
  pending.toHead(c);
  t.deepEqual(order(), ['c', 'a', 'b', 'd']);
  pending.toHead(c);
  t.deepEqual(order(), ['c', 'a', 'b', 'd'], 'already the head: no change');
  const requestIdOfC = c.item.requestId;
  pending.take(c, 't9');
  t.is(pending.receipt(requestIdOfC)?.turnId, 't9');
  t.is(pending.receipt(requestIdOfC)?.entry, undefined);
  t.throws(() => pending.toHead(c), { message: texts.entryGone });
  t.is(pending.receiptCount(), 4);
});

test('a receipt table full of live ids evicts its oldest; a retry of an evicted id is refused, never run twice (J-9492)', t => {
  const { queue } = counted();
  const first = rid(NOW);
  queue.enqueueOnce(sub('m0'), first, NOW);
  claimHead(queue, 't1');
  for (let i = 1; i < limits.maxReceipts; i += 1) {
    queue.enqueueOnce(sub(`m${i}`), rid(NOW + i), NOW + i);
    claimHead(queue, `t${i + 1}`);
  }
  const more = queue.enqueueOnce(
    sub('one more'),
    rid(NOW + limits.maxReceipts),
    NOW + limits.maxReceipts,
  );
  t.true(more.added, 'R4-98 bounds what is kept, not what is sent');
  t.is(queue.receiptFor(first), undefined);
  t.throws(
    () => queue.enqueueOnce(sub('m0'), first, NOW + limits.maxReceipts),
    { message: texts.requestIdExpired },
  );
  claimHead(queue, 't-more');
  // 24 h after the first: its receipt has expired and the next is accepted.
  const later = NOW + limits.retryWindowMs;
  t.true(queue.enqueueOnce(sub('next day'), rid(later), later).added);
});

test('holds table: the five A.4 holds, their texts, and the release rule (R4-56)', t => {
  t.deepEqual(
    holdsTable.map(entry => [entry.reason, entry.releasedBy]),
    [
      ['restart', 'enqueue'],
      ['stopped', 'enqueue'],
      ['refused', 'enqueue'],
      ['interrupted', 'decision'],
      ['unavailable', 'enqueue'],
    ],
  );
  for (const { reason } of holdsTable) {
    t.true(matches(reason, shapes.HoldReason));
  }
  t.is(
    holdTexts.restart(),
    'These messages were queued before the service restarted. Nothing is sent until you send one.',
  );
  t.is(
    holdTexts.stopped(),
    'The session was stopped with messages queued. Nothing is sent until you send one.',
  );
  t.is(
    holdTexts.interrupted(),
    'The service restarted while this message was being sent, so it may or may not have reached the agent. Check the conversation, then send it again or delete it.',
  );
  t.is(holdTexts.refused('boom'), 'Not sent: boom');
  t.is(holdTexts.refused(), 'Not sent: the turn ended before it started');
  t.is(
    holdTexts.unavailable('corrupt'),
    'Queued messages cannot be read: corrupt',
  );
  t.is(holdText('restart'), texts.holdRestart);
  t.throws(() => holdText('nope'));
  t.true(releaseRule('restart'));
  t.true(releaseRule('stopped'));
  t.true(releaseRule('refused'));
  t.true(releaseRule('unavailable'));
  t.false(releaseRule('interrupted'));
  t.false(releaseRule('appended-by-someone'));
  t.false(releaseRule(undefined));
});

test('every Receipt and PendingView matches its shape (queued, started, with and without the Turn)', t => {
  const turn = Far('Turn', {});
  const queue = makeQueue({
    turnOf: turnId => (turnId === 't1' ? turn : undefined),
  });
  const a = queue.enqueueOnce(sub('a'), rid(), NOW);
  const b = queue.enqueueOnce(sub('b'), rid(), NOW);
  t.true(matches(a.receipt, shapes.Receipt));
  claimHead(queue, 't1');
  claimHead(queue, 't2');
  const ra = queue.receiptFor(a.receipt.requestId);
  const rb = queue.receiptFor(b.receipt.requestId);
  t.deepEqual(ra, {
    requestId: a.receipt.requestId,
    duplicate: false,
    state: 'started',
    turn,
    turnId: 't1',
  });
  t.deepEqual(rb, {
    requestId: b.receipt.requestId,
    duplicate: false,
    state: 'started',
    turnId: 't2',
  });
  t.true(matches(ra, shapes.Receipt));
  t.true(matches(rb, shapes.Receipt));
  queue.enqueueOnce(sub('c'), rid(), NOW);
  queue.hold('restart', holdTexts.restart());
  t.true(matches(queue.view(), shapes.PendingView));
});
