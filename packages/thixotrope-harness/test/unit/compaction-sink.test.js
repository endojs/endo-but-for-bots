// @ts-check
// Crank Y in the real session (guest/session/turn.js `TurnSink.compacted`
// and the compaction part's `compacted`; designs/m8-interfaces.md 4.2, 4.4,
// acceptance 7 and 8, the probes of section 14): an accepted boundary is
// recorded with the summary (and the directive when it lies inside the
// turn), the reply carries the cache's next base and append, and every
// later request and context page starts from the boundary; a boundary that
// is not a cut, below the floor, above the ask or not past the current one
// is recorded as skipped; an adapter skip is recorded; `go: false` with
// nothing recorded after settle, for another round, or with no ask out;
// the summary's tokens are charged, its reading is not kept.
import './_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';

/* eslint-disable import/no-relative-packages */
import { compactionTexts } from '../../guest/lib/guards/session.js';
import {
  compactionPart,
  makeContextWindow,
} from '../../guest/session/compaction.js';
import { makeRecordLog } from '../../guest/session/records.js';
/* eslint-enable import/no-relative-packages */
import {
  AT,
  OVER,
  drain,
  makeCompactionSession,
  usageOf,
} from './_compaction-session.js';

/** A session whose second turn's round 0 carries an ask. */
const asking = async () => {
  const s = await makeCompactionSession();
  await s.turn('first', OVER);
  await s.submit('second');
  const req = s.last();
  req.sink.dispatching(0);
  return { s, req, ask: req.compaction };
};

/**
 * @param {any} req
 * @param {Record<string, any>} fields
 */
const compacted = (req, fields) =>
  req.sink.compacted(harden({ round: req.round, at: AT + 5, ...fields }));

/** @param {any} s */
const compactionRecords = s =>
  s.records().filter((/** @type {any} */ r) => r.kind.startsWith('compaction'));

test('an accepted boundary: the record, the reply, the next request and the page start there', async t => {
  const { s, req, ask } = await asking();
  const before = s.phases().length;
  const reply = compacted(req, {
    outcome: 'done',
    boundary: ask.startIndex,
    summary: 'the summary',
  });
  const sent = req.base.count + req.append.length;
  t.deepEqual(reply.base, { count: sent, epoch: 1, boundary: ask.startIndex });
  // `dispatching(0)` recorded `dispatched` after the request went out.
  t.deepEqual(
    reply.append.map((/** @type {any} */ r) => r.kind),
    ['dispatched', 'compaction'],
  );
  t.deepEqual(reply.append[1], {
    kind: 'compaction',
    turnId: 't2',
    round: 0,
    epoch: 1,
    boundary: ask.startIndex,
    summary: 'the summary',
    at: AT + 5,
  });
  await drain();
  t.deepEqual(s.phases().slice(before), ['thinking']);
  // The ContextSource pages from the boundary (4.4).
  t.is(req.context.page().from, ask.startIndex);
  // Round 0 streams; round 1 carries the moved window.
  await s.answer({ usage: usageOf(30, 100), calls: 1 });
  t.like(s.last().base, {
    count: sent + 2,
    epoch: 1,
    boundary: ask.startIndex,
  });
  t.is(s.last().compaction, undefined);
});

test('a boundary inside the turn carries the turn input as the directive', async t => {
  const s = await makeCompactionSession();
  await s.turn('first');
  await s.submit('the directive');
  await s.answer({ calls: 1 });
  await s.answer({ usage: OVER, calls: 1 });
  const req = s.last();
  t.is(req.round, 2);
  // S-5c: with an ask out the runner emits no `thinking` of its own.
  t.deepEqual(s.phases().slice(-2), ['using tools', 'compacting context']);
  req.sink.dispatching(2);
  const cut = s
    .records()
    .findLastIndex(
      (/** @type {any} */ r) => r.kind === 'round-settled' && r.round === 1,
    );
  t.true(cut > Number(req.compaction.startIndex));
  const reply = compacted(req, {
    outcome: 'done',
    boundary: cut,
    summary: 'inside',
  });
  t.like(reply.append.at(-1), {
    kind: 'compaction',
    boundary: cut,
    directive: 'the directive',
  });
});

test('a boundary that is not a cut, above the ask or not past the current one is skipped', async t => {
  const { req, ask } = await asking();
  // The compaction-started record itself is not a cut.
  const reply = compacted(req, {
    outcome: 'done',
    boundary: ask.askedAt,
    summary: 's',
  });
  t.like(reply, { go: true, base: { epoch: 0 } });
  t.false('boundary' in reply.base);
  t.like(reply.append.at(-1), {
    kind: 'compaction-skipped',
    reason: compactionTexts.invalidBoundary,
  });
  t.is(req.context.page().from, 0);

  // Above askedAt, and at the current boundary (0 = a turn-started).
  for (const boundary of [ask.askedAt + 1, 0]) {
    // eslint-disable-next-line no-await-in-loop
    const other = await asking();
    const answer = compacted(other.req, {
      outcome: 'done',
      boundary,
      summary: 's',
    });
    t.like(answer.append.at(-1), { reason: compactionTexts.invalidBoundary });
  }
});

test('an adapter skip is recorded with its reason; the round runs uncompacted', async t => {
  const { s, req } = await asking();
  const reply = compacted(req, { outcome: 'skipped', reason: 'Nothing to do' });
  t.like(reply.append.at(-1), {
    kind: 'compaction-skipped',
    turnId: 't2',
    round: 0,
    reason: 'Nothing to do',
    at: AT + 5,
  });
  await s.answer();
  t.deepEqual(
    compactionRecords(s).map((/** @type {any} */ r) => r.kind),
    ['compaction-started', 'compaction-skipped'],
  );
});

test('go: false and nothing recorded after settle, for another round, or with no ask out', async t => {
  const { s, req, ask } = await asking();
  const done = { outcome: 'done', boundary: ask.startIndex, summary: 's' };
  t.deepEqual(
    req.sink.compacted(harden({ round: 1, at: AT + 5, ...done })),
    { go: false },
    'another round',
  );
  req.turn.cancel();
  await drain();
  t.deepEqual(compacted(req, done), { go: false }, 'after the settle');
  t.deepEqual(
    compactionRecords(s).map((/** @type {any} */ r) => r.kind),
    ['compaction-started'],
  );

  // A round that never asked.
  const q = await makeCompactionSession();
  await q.turn('first');
  await q.submit('second');
  const plain = q.last();
  t.is(plain.compaction, undefined);
  plain.sink.dispatching(0);
  t.deepEqual(compacted(plain, done), { go: false }, 'no ask out');
  // A second answer to one ask.
  await q.answer({ usage: OVER });
  await q.submit('third');
  const again = q.last();
  again.sink.dispatching(0);
  t.like(compacted(again, { outcome: 'skipped', reason: 'r' }), { go: true });
  t.deepEqual(compacted(again, { outcome: 'skipped', reason: 'r' }), {
    go: false,
  });
  t.deepEqual(compactionRecords(q).length, 2);
});

test('the summary tokens are charged; the reading stays the real rounds', async t => {
  const { s, req, ask } = await asking();
  const before = s.session.getUsage();
  compacted(req, {
    outcome: 'done',
    boundary: ask.startIndex,
    summary: 's',
    usage: usageOf(5, 999),
  });
  const after = s.session.getUsage();
  t.is(after.inputTokens, before.inputTokens + 10);
  t.is(after.outputTokens, before.outputTokens + 2);
  t.deepEqual(after.context, before.context, 'the reading is not the summary');
  await s.answer({ usage: usageOf(30, 100) });
  t.deepEqual(s.session.getUsage().context, {
    usedTokens: 30,
    windowTokens: 100,
  });
});

test('a boundary below the ask floor is skipped (the part, over a real log)', t => {
  const records = makeRecordLog();
  for (const turnId of ['t1', 't2']) {
    records.append({ kind: 'turn-started', turnId, input: 'x', at: 1 });
    records.append({
      kind: 'turn-settled',
      turnId,
      status: 'completed',
      at: 1,
    });
  }
  const window = makeContextWindow({ records });
  const part = compactionPart.make(
    /** @type {any} */ (harden({ contextWindow: window })),
  );
  /** @type {any[]} */
  const appended = [];
  const active = /** @type {any} */ ({
    turnId: 't2',
    info: { input: 'x' },
    compactionAsk: {
      epoch: 1,
      boundary: 0,
      askedAt: 4,
      startIndex: 2,
      floor: 3,
      usedTokens: 80,
      windowTokens: 100,
      thresholdTokens: 70,
    },
  });
  const turn = /** @type {any} */ ({
    active,
    round: 0,
    append: (/** @type {any} */ r) => appended.push(r),
    emit: () => {},
  });
  t.true(window.isCut(2));
  part.compacted(turn, { at: 9, outcome: 'done', boundary: 2, summary: 's' });
  t.like(appended[0], {
    kind: 'compaction-skipped',
    reason: compactionTexts.invalidBoundary,
  });
  t.is(window.epoch(), 0);
});
