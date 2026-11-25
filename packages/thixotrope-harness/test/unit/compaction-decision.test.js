// @ts-check
// The compaction decision in the real session (guest/session/compaction.js
// `beforeRound`; designs/m8-interfaces.md 4.1 rules 1-6, acceptance 4 and
// 5): the ask, its record and its phase leave in the crank that sends the
// round; no ask with an unknown or zero reading, below 70 %, with nothing
// before the turn at round 0, after a skip, in the round after a
// compaction, past four compactions in a turn, in the round after a
// `viewImage` result, or after an ask the adapter left unanswered; a
// session that never crosses the threshold sends exactly what it sent
// before compaction existed.
import './_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';

/* eslint-disable import/no-relative-packages */
import { texts } from '../../guest/lib/guards/session.js';
/* eslint-enable import/no-relative-packages */
import {
  AT,
  OVER,
  drain,
  makeCompactionSession,
  usageOf,
} from './_compaction-session.js';
import { requestId } from './_m2-queue-session.js';

/** @param {any} req */
const kindsOf = req => req.append.map((/** @type {any} */ r) => r.kind);

test('round 0 asks from the previous turn reading; record, ask and phase in one crank', async t => {
  const s = await makeCompactionSession();
  await s.turn('first', OVER);
  await s.submit('second');
  const req = s.last();
  t.is(req.round, 0);
  const kinds = kindsOf(req);
  t.deepEqual(kinds.slice(-3), [
    'turn-settled',
    'turn-started',
    'compaction-started',
  ]);
  const startIndex = req.base.count + kinds.indexOf('turn-started');
  const started = req.append[kinds.indexOf('turn-started')];
  t.deepEqual(req.compaction, {
    epoch: 1,
    boundary: 0,
    askedAt: startIndex + 1,
    startIndex,
    floor: 0,
    usedTokens: 80,
    windowTokens: 100,
    thresholdTokens: 70,
  });
  t.like(req.append.at(-1), {
    kind: 'compaction-started',
    turnId: 't2',
    round: 0,
    epoch: 1,
    boundary: 0,
    usedTokens: 80,
    windowTokens: 100,
    at: started.at,
  });
  t.deepEqual(req.base, { count: req.base.count, epoch: 0 });
  t.is(s.phases().at(-1), 'compacting context');
});

test('no ask below the threshold, with no reading, a zero window, or nothing before the turn', async t => {
  const s = await makeCompactionSession();
  // The first turn has nothing before it, whatever the reading says.
  await s.submit('first');
  t.is(s.last().compaction, undefined);
  await s.answer({ usage: usageOf(69, 100) });
  await s.submit('below');
  t.is(s.last().compaction, undefined, '69 of 100');
  await s.answer({ usage: usageOf(90, 0) });
  await s.submit('zero window');
  t.is(s.last().compaction, undefined, 'window 0');
  await s.answer({ usage: usageOf(0, 100) });
  await s.submit('zero used');
  t.is(s.last().compaction, undefined, 'used 0');
  await s.answer({ usage: usageOf(70, 100) });
  await s.submit('at the threshold');
  t.truthy(s.last().compaction, '70 of 100 asks');
});

test('a session below the threshold sends what it sent before: no ask, no record, base epoch 0', async t => {
  const s = await makeCompactionSession();
  await s.turn('one', usageOf(10, 100));
  await s.submit('two');
  await s.answer({ usage: usageOf(20, 100), calls: 1 });
  await s.answer({ usage: usageOf(30, 100) });
  for (const req of s.rounds) {
    t.is(req.compaction, undefined);
    t.deepEqual(Object.keys(req.base), ['count', 'epoch']);
    t.is(req.base.epoch, 0);
  }
  t.false(
    s.records().some((/** @type {any} */ r) => r.kind.startsWith('compaction')),
  );
  t.false(s.phases().includes('compacting context'));
});

test('round r asks from round r - 1; not in the round after a compaction', async t => {
  const s = await makeCompactionSession();
  await s.turn('first');
  await s.submit('second');
  t.is(s.last().compaction, undefined);
  await s.answer({ usage: OVER, calls: 1 });
  const asked = s.last();
  t.is(asked.round, 1);
  t.like(asked.compaction, { epoch: 1, boundary: 0, usedTokens: 80 });
  // The adapter compacts at the turn's own start.
  asked.sink.compacted(
    harden({
      round: 1,
      at: AT + 2,
      outcome: 'done',
      boundary: asked.compaction.startIndex,
      summary: 'summary one',
    }),
  );
  await s.answer({ usage: OVER, calls: 1 });
  t.is(s.last().round, 2);
  t.is(s.last().compaction, undefined, 'a reading newer than the compaction');
  await s.answer({ usage: OVER, calls: 1 });
  t.is(s.last().round, 3);
  t.like(s.last().compaction, {
    epoch: 2,
    boundary: asked.compaction.startIndex,
  });
});

test('postponed one round after a viewImage result; the round after may ask', async t => {
  const s = await makeCompactionSession();
  await s.turn('first');
  await s.submit('second');
  // A `viewImage` result recorded in round 0.
  s.part().imageSeen('t2');
  await s.answer({ usage: OVER, calls: 1 });
  t.is(s.last().round, 1);
  t.is(s.last().compaction, undefined, 'postponed');
  await s.answer({ usage: OVER, calls: 1 });
  t.is(s.last().round, 2);
  t.truthy(s.last().compaction, 'the flag was cleared');
});

test('a skip ends the asks of its turn; the next turn may ask again', async t => {
  const s = await makeCompactionSession();
  await s.turn('first', OVER);
  await s.submit('second');
  const asked = s.last();
  asked.sink.compacted(
    harden({ round: 0, at: AT + 2, outcome: 'skipped', reason: 'no' }),
  );
  for (let round = 1; round <= 3; round += 1) {
    // eslint-disable-next-line no-await-in-loop
    await s.answer({ usage: OVER, calls: 1 });
    t.is(s.last().compaction, undefined, `round ${round}`);
  }
  await s.answer({ usage: OVER });
  await s.submit('third');
  t.truthy(s.last().compaction);
});

test('at most four compactions end done in one turn', async t => {
  const s = await makeCompactionSession();
  await s.turn('first');
  await s.submit('second');
  /** @type {number[]} */
  const askedRounds = [];
  let boundary = 0;
  for (let round = 1; round <= 10; round += 1) {
    // eslint-disable-next-line no-await-in-loop
    await s.answer({ usage: OVER, calls: 1 });
    const req = s.last();
    /** @type {{ askedAt: number, startIndex: number } | undefined} */
    const ask = req.compaction;
    if (ask !== undefined) {
      askedRounds.push(req.round);
      // Each compaction cuts at the newest round-settled the ask allows.
      const records = s.records();
      const cut = records.findLastIndex(
        (/** @type {any} */ r, /** @type {number} */ i) =>
          i < ask.askedAt && r.kind === 'round-settled' && Number(r.round) > 0,
      );
      boundary = cut > boundary ? cut : ask.startIndex;
      req.sink.compacted(
        harden({
          round: req.round,
          at: AT + 2,
          outcome: 'done',
          boundary,
          summary: `summary ${req.round}`,
        }),
      );
    }
  }
  t.deepEqual(askedRounds, [1, 3, 5, 7]);
  t.is(
    s.records().filter((/** @type {any} */ r) => r.kind === 'compaction')
      .length,
    4,
  );
});

test('an ask the adapter left unanswered is not sent again and ends the asks of the turn', async t => {
  const s = await makeCompactionSession();
  await s.turn('first', OVER);
  await s.submit('second');
  t.truthy(s.last().compaction);
  // An adapter that does not compact streams the round.
  await s.answer({ usage: OVER, calls: 1 });
  t.is(s.last().round, 1);
  t.is(s.last().compaction, undefined);
  await s.answer({ usage: OVER, calls: 1 });
  t.is(s.last().compaction, undefined);
  // The late answer for round 0 changes nothing.
  t.deepEqual(
    s.rounds[1].sink.compacted(
      harden({ round: 0, at: AT + 3, outcome: 'skipped', reason: 'late' }),
    ),
    { go: false },
  );
});

test('a compaction round during a spoken turn carries no spoken note; the system text is the typed one (M11 9.1)', async t => {
  const s = await makeCompactionSession();
  await s.turn('typed first', OVER);
  const typedSystem = s.rounds[0].system;
  s.session.enqueueOnce(
    harden({ text: 'spoken second' }),
    requestId(),
    AT,
    harden({ spoken: true, dictated: true }),
  );
  await drain();
  const req = s.last();
  t.truthy(req.compaction, 'the round asks for a compaction');
  t.is(req.system, typedSystem, 'byte-identical');
  for (const note of [texts.readAloudTurnNote, texts.dictatedTurnNote]) {
    t.false(JSON.stringify(req.system ?? '').includes(note.slice(0, 40)));
  }
  t.like(req.append[kindsOf(req).indexOf('turn-started')], {
    spoken: true,
    dictated: true,
  });
});
