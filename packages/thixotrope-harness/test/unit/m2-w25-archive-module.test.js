// @ts-check
// guest/session/archive.js and records.js alone (M2 W2.5), with small
// limits and W2.8's in-memory fake archive: the size rule (whole turns; a
// turn over the record or byte bound is a segment of its own), turn spans
// (a TurnResolved between turns belongs to the earlier turn), the segment
// index and its pages, the fence, the segment ceiling, and RecordLog.dropBefore.
import './_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';

/* eslint-disable import/no-relative-packages */
import { texts } from '../../guest/lib/interfaces.js';
import { limits } from '../../guest/lib/limits.js';
import { makeSessionArchive } from '../../guest/session/archive.js';
import { makeContextSource } from '../../guest/session/context-source.js';
import { makeRecordLog } from '../../guest/session/records.js';
/* eslint-enable import/no-relative-packages */
import { makeFakeArchive } from './_m2-fake-archive.js';
import { drain, usage } from './_m2-w25-session.js';

const small = harden({
  ...limits,
  archiveKeepTurns: 2,
  archiveSegmentTurns: 2,
  archiveSegmentRecords: 10,
  archiveSegmentBytes: 2000,
  archiveMaxSegments: 70,
});

/** @param {Record<string, any>} [overrides] */
const setup = (overrides = {}) => {
  const records = makeRecordLog();
  /** @type {string[][]} */
  const dropped = [];
  /** @type {unknown[]} */
  const failures = [];
  let closed = false;
  const archive = makeSessionArchive({
    records,
    limits: harden({ ...small, ...overrides }),
    onSealed: ids => dropped.push(ids),
    onNotSealed: error => failures.push(error),
    fence: harden({ closed: () => closed }),
  });
  const context = makeContextSource({ records, archive });
  const fake = makeFakeArchive();
  const ports = harden({ archive: fake.port });
  let n = 0;
  /**
   * Append one settled turn of `rounds` rounds (3 + rounds records).
   * @param {{ rounds?: number, text?: string }} [options]
   */
  const turn = ({ rounds = 1, text = 'x' } = {}) => {
    n += 1;
    const turnId = `t${n}`;
    records.append({ kind: 'turn-started', turnId, input: text, at: n });
    records.append({ kind: 'dispatched', turnId, round: 0 });
    for (let round = 0; round < rounds; round += 1) {
      records.append({
        kind: 'round-settled',
        turnId,
        round,
        text,
        callCount: 0,
        usage,
        at: n,
      });
    }
    records.append({
      kind: 'turn-settled',
      turnId,
      status: 'completed',
      at: n,
    });
    return turnId;
  };
  const seal = async () => {
    const sent = archive.maybeSeal({ ports, context });
    await drain();
    return sent;
  };
  return {
    /** Close the session's delete fence. */
    closeFence: () => {
      closed = true;
    }, records, archive, context, fake, dropped, failures, turn, seal };
};

test('RecordLog.dropBefore keeps absolute indexes and ordinals', t => {
  const { records, turn } = setup();
  turn();
  turn();
  turn();
  t.is(records.count(), 12);
  t.throws(() => records.dropBefore(5), { message: /turn's start/ });
  t.deepEqual(records.dropBefore(8), ['t1', 't2']);
  t.is(records.base(), 8);
  t.is(records.count(), 12);
  t.is(records.at(7), undefined);
  t.is(records.at(8).turnId, 't3');
  t.deepEqual(records.turnIds(), ['t3']);
  t.is(records.messageCount(), 3);
  t.is(records.droppedTurns(), 2);
  t.is(records.since(0).length, 4);
  t.is(records.ofTurn('t1').length, 0);
  t.is(records.startOf('t3'), 8);
  // A dropped turn's resolution is appended, indexed under no kept turn.
  records.append({ kind: 'turn-resolved', turnId: 't1', note: 'ok', at: 9 });
  t.is(records.count(), 13);
  t.is(records.ofTurn('t3').length, 4);
  t.throws(
    () => records.append({ kind: 'dispatched', turnId: 't1', round: 0 }),
    { message: /must be turn-started/ },
  );
});

test('the size rule: whole turns, record and byte bounds, a large turn alone', async t => {
  const s = setup();
  // t1: 4 records; t2: 4; t3: 11 (over the record bound alone); t4..t6.
  s.turn();
  s.turn();
  s.turn({ rounds: 8 });
  s.turn();
  s.turn();
  s.turn();
  t.true(await s.seal());
  t.like(s.fake.segments()[0], { from: 0, to: 8, turns: 2, records: 8 });
  t.deepEqual(s.dropped[0], ['t1', 't2']);
  // Keep 2 + segment 2: 4 kept settled turns needed; t3..t6 are 4.
  t.true(await s.seal());
  // A turn over the record bound alone; its `kinds` is the first
  // archiveSegmentRecords letters (the fake checks against the real
  // limits' 4,096, so with this test's bound of 10 it refuses the seal).
  t.like(s.fake.requests()[1], { from: 8, to: 19, turns: 1, records: 11 });
  t.is(s.fake.requests()[1].kinds, 'sdrrrrrrrr');
  t.is(s.failures.length, 1);
  t.is(s.records.base(), 8, 'a refused seal drops nothing');
  t.is(s.archive.state().segments, 1);
  t.is(s.archive.state().sealedTurns, 2);
  // The byte bound: a new session; two turns of 600-byte texts are over 2,000.
  const bytes = setup({ archiveSegmentRecords: 4096 });
  const big = 'y'.repeat(600);
  bytes.turn({ text: big });
  bytes.turn({ text: big });
  bytes.turn();
  bytes.turn();
  t.true(await bytes.seal());
  t.like(bytes.fake.segments()[0], { turns: 1, records: 4 });
  t.true(Number(bytes.fake.segments()[0].bytes) <= small.archiveSegmentBytes);
  // ... and a single turn over the byte bound is a segment of its own.
  const huge = setup({ archiveSegmentRecords: 4096 });
  huge.turn({ text: 'z'.repeat(1500) });
  huge.turn();
  huge.turn();
  huge.turn();
  t.true(await huge.seal());
  t.like(huge.fake.segments()[0], { turns: 1, records: 4 });
  t.true(Number(huge.fake.segments()[0].bytes) > small.archiveSegmentBytes);
});

test('turn spans: a TurnResolved between turns is sealed with the turn before it', async t => {
  const s = setup();
  s.turn();
  s.turn();
  // t1's resolution lands between t2 and t3.
  s.records.append({ kind: 'turn-resolved', turnId: 't1', note: 'n', at: 3 });
  s.turn();
  s.turn();
  t.true(await s.seal());
  const [entry] = s.fake.segments();
  t.like(entry, { from: 0, to: 9, turns: 2, records: 9 });
  t.like(s.fake.recordsOf(1)?.at(-1), { kind: 'turn-resolved', turnId: 't1' });
  t.is(s.records.at(9).kind, 'turn-started');
});

test('only settled turns are sealed', async t => {
  const s = setup();
  s.turn();
  s.turn();
  s.turn();
  s.turn();
  // t5 started, not settled: still only t1..t4 count; t1, t2 sealable.
  s.records.append({ kind: 'turn-started', turnId: 't5', input: 'x', at: 5 });
  t.true(await s.seal());
  t.like(s.fake.segments()[0], { turns: 2 });
});

test('segments() pages the index; the ceiling stops sealing; the fence', async t => {
  const s = setup();
  for (let i = 0; i < 2 * 70 + 4; i += 1) s.turn();
  for (let i = 0; i < 70; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    t.true(await s.seal());
  }
  t.false(await s.seal(), 'archiveMaxSegments reached');
  const first = await s.context.segments();
  t.is(first.segments.length, limits.segmentPageEntries);
  t.is(first.next, `s${limits.segmentPageEntries}`);
  const second = await s.context.segments(first.next);
  t.is(second.segments.length, 70 - limits.segmentPageEntries);
  t.is(second.next, undefined);
  t.deepEqual([...first.segments, ...second.segments], s.archive.entries());
  t.throws(() => s.context.segments('s71'), { message: texts.badCursor });

  const fenced = setup();
  for (let i = 0; i < 6; i += 1) fenced.turn();
  fenced.closeFence();
  t.false(await fenced.seal());
});

test('a seal in flight blocks another; its answer is applied once', async t => {
  const s = setup();
  for (let i = 0; i < 8; i += 1) s.turn();
  const held = s.fake.holdNext();
  t.true(
    s.archive.maybeSeal({
      ports: harden({ archive: s.fake.port }),
      context: s.context,
    }),
  );
  t.false(
    s.archive.maybeSeal({
      ports: harden({ archive: s.fake.port }),
      context: s.context,
    }),
  );
  t.truthy(s.archive.sealing());
  held.answer();
  await drain();
  t.is(s.archive.sealing(), undefined);
  t.is(s.archive.state().segments, 1);
  // A replayed or late copy of the same answer is ignored.
  t.is(s.archive.sealed(s.fake.segments()[0]), undefined);
  t.is(s.archive.state().segments, 1);
});

test('without an archive port, nothing is sealed', async t => {
  const s = setup();
  for (let i = 0; i < 6; i += 1) s.turn();
  t.false(s.archive.maybeSeal({ ports: harden({}), context: s.context }));
  t.false(s.archive.maybeSeal({ ports: undefined, context: s.context }));
});

test('unresolved archived turns: kept by id, at most maxUnresolvedTurns, gone once resolved', t => {
  const s = setup({ maxUnresolvedTurns: 2 });
  const infos = [1, 2, 3].map(n => ({ turnId: `t${n}` }));
  for (const info of infos) s.archive.keepUnresolved(info.turnId, info);
  t.is(s.archive.unresolvedInfo('t1'), undefined, 'the oldest went');
  t.is(s.archive.unresolvedInfo('t2'), infos[1]);
  t.is(s.archive.unresolvedInfo('t3'), infos[2]);
  s.archive.resolve('t2');
  t.is(s.archive.unresolvedInfo('t2'), undefined);
  t.is(s.archive.unresolvedInfo('t3'), infos[2]);
  t.false('unresolved' in s.archive, 'the map is not reachable');
});
