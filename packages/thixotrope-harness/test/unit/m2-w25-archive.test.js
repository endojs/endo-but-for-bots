// @ts-check
// The record archive's vat side (M2 W2.5; D-M2-1; m2-interfaces.md 4.3-4.10)
// over W2.8's in-memory fake archive: sealing in the settle crank, durable
// before drop, the exact log across seals, the SIGKILL table of 4.5 as the
// vat sees each row, the bounded tail and index, unresolved archived turns,
// Session.findTurn, Turn handles of archived turns, ContextSource from
// sealedTo, RoundRequest.base.archive, and the release of sealed turns'
// Blob handles. Real limits (128 kept turns, 32 per segment).
import './_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';
import v8 from 'node:v8';
import vm from 'node:vm';

/* eslint-disable import/no-relative-packages */
import { messageBytes } from '../../guest/lib/bounded.js';
import { texts } from '../../guest/lib/interfaces.js';
import { limits } from '../../guest/lib/limits.js';
/* eslint-enable import/no-relative-packages */
import {
  drain,
  makeArchiveSession,
  retired,
  stagedText,
  usage,
} from './_m2-w25-session.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { E, Far } = /** @type {GuestGlobals} */ (globalThis);

v8.setFlagsFromString('--expose_gc');
const gc = vm.runInNewContext('gc');

const KEEP = limits.archiveKeepTurns;
const SEG = limits.archiveSegmentTurns;

/**
 * A mix of turns: a tool round with results in reverse call order every 5th
 * turn, a failed turn every 7th.
 * @param {any} s
 * @param {number} n
 */
const mixed = async (s, n) => {
  for (let i = 0; i < n; i += 1) {
    const k = s.runner.archive.state().sealedTurns + s.records.turnIds().length;
    // eslint-disable-next-line no-await-in-loop
    await s.turn(
      k % 5 === 4 ? { calls: 3 } : k % 7 === 6 ? { end: 'failed' } : {},
    );
  }
};

test('seals at 160 kept settled turns, in the settle crank; drops only on the durable answer; the log stays exact', async t => {
  const s = await makeArchiveSession();
  await mixed(s, KEEP + SEG - 1);
  t.is(s.fake.counts().seals, 0, 'no seal below 160 settled turns');
  t.is(s.runner.archive.state().segments, 0);
  t.is(s.records.base(), 0);
  // The 160th settle sends the seal before the next entry is claimed.
  await mixed(s, 1);
  t.is(s.fake.counts().seals, 1);
  const [request] = s.fake.requests();
  t.like(request, {
    from: 0,
    firstTurn: 1,
    turns: SEG,
    firstTurnId: 't1',
    lastTurnId: `t${SEG}`,
    epoch: 0,
    previous: '',
  });
  t.is(request.kinds.length, request.records);
  const state = s.runner.archive.state();
  t.like(state, { sealedTo: request.to, sealedTurns: SEG, segments: 1 });
  t.is(state.digest, s.fake.segments()[0].digest);
  t.is(s.records.base(), request.to);
  t.is(s.records.turnIds().length, KEEP);
  t.is(s.records.messageCount(), KEEP + SEG);
  t.is(await s.checkLog(), undefined);

  // On to 400 turns: one seal per 32 settles; the tail stays 128-159.
  /** @type {number[]} */
  const kept = [];
  for (let n = KEEP + SEG; n < 400; n += 1) {
    // eslint-disable-next-line no-await-in-loop
    await mixed(s, 1);
    kept.push(s.records.turnIds().length);
  }
  t.true(kept.every(k => k >= KEEP && k < KEEP + SEG));
  t.is(s.runner.archive.state().segments, 8);
  t.is(s.runner.archive.entries().length, 8);
  t.is(await s.checkLog(), undefined);
  // The chain: each request names the previous segment's digest.
  const requests = s.fake.requests();
  const entries = s.runner.archive.entries();
  for (let i = 1; i < requests.length; i += 1) {
    t.is(requests[i].previous, entries[i - 1].digest);
    t.is(requests[i].from, entries[i - 1].to);
  }
});

test('RoundRequest.base.archive, ContextSource from sealedTo, segments()', async t => {
  const s = await makeArchiveSession();
  await s.turns(KEEP + SEG);
  const state = s.runner.archive.state();
  t.is(state.segments, 1);
  await s.turn();
  const req = s.rounds.find(
    (/** @type {any} */ r) =>
      r.turnId === `t${KEEP + SEG + 1}` && r.round === 0,
  );
  t.deepEqual(req.base.archive, state);
  t.true(Number(req.base.count) >= state.sealedTo);
  t.true(Number(req.append.length) > 0);
  // Never a sealed record in an append.
  t.false(
    req.append.some((/** @type {any} */ r) => r.turnId === 't1'),
    'no record of a sealed turn',
  );
  const context = req.context;
  const first = await E(context).page();
  t.is(first.from, state.sealedTo);
  await t.throwsAsync(() => E(context).page('p0'), {
    message: texts.recordsSealed,
  });
  await t.throwsAsync(() => E(context).page(`p${state.sealedTo - 1}`), {
    message: texts.recordsSealed,
  });
  const segments = await E(context).segments();
  t.deepEqual(segments, { segments: s.runner.archive.entries() });
  t.deepEqual(await E(context).segments('s1'), { segments: [] });
  await t.throwsAsync(() => E(context).segments('s2'), {
    message: texts.badCursor,
  });
});

/**
 * The SIGKILL table of m2-interfaces.md 4.5, as the vat sees each row:
 * what reaches the vat after the restart (the answer, or the retired
 * break), and what the adapter holds (W2.8's fake: an orphan segment, or
 * none). After each: nothing lost or duplicated, history shows every turn
 * once, and the next seal succeeds.
 */
const killRows = [
  {
    row: 'nothing of the seal journaled (crank S replayed)',
    reaches: 'answer',
    adapter: 'normal',
  },
  {
    row: 'after S, before A1 (intent and frame committed)',
    reaches: 'break',
    adapter: 'nothing',
  },
  {
    row: 'after A1 (pages pulled)',
    reaches: 'break',
    adapter: 'pages',
  },
  {
    row: 'during A2 (.part written, not renamed)',
    reaches: 'break',
    adapter: 'nothing',
  },
  {
    row: 'after A2 (renamed, fsynced, unacknowledged: an orphan)',
    reaches: 'break',
    adapter: 'orphan',
  },
  {
    row: 'after A3, the answer committed and delivered',
    reaches: 'answer',
    adapter: 'normal',
  },
  {
    row: 'after A3, the retired break delivered instead',
    reaches: 'break',
    adapter: 'orphan',
  },
  {
    row: 'after Z (A4 not done)',
    reaches: 'answer',
    adapter: 'normal',
  },
  {
    row: 'during A4 (context.jsonl or mirror half-written)',
    reaches: 'answer',
    adapter: 'normal',
  },
];

for (const { row, reaches, adapter } of killRows) {
  test(`SIGKILL ${row}`, async t => {
    /** @type {string | undefined} */
    let mode;
    /** @type {any} */
    let orphan;
    let sealCalls = 0;
    const s = await makeArchiveSession({
      wrapPort: fake =>
        Far('ArchivePort', {
          seal: async (/** @type {any} */ req) => {
            sealCalls += 1;
            const now = mode;
            mode = undefined;
            if (now === 'nothing') throw retired();
            if (now === 'pages') {
              await E(req.context).page(`p${req.from}`);
              throw retired();
            }
            if (now === 'orphan') {
              orphan = await E(fake).seal(req);
              throw retired();
            }
            return E(fake).seal(req);
          },
        }),
    });
    await s.turns(KEEP + SEG - 1);
    mode = adapter;
    const opensBefore = s.counts.opens;
    await s.turn();
    t.is(sealCalls, 1, 'one seal sent, in the settle crank');
    const state = s.runner.archive.state();
    if (reaches === 'answer') {
      t.is(state.segments, 1, 'sealed');
      // The kill and restart after Z: the adapter validates against the
      // vat's state (the fake acknowledges what the state names).
      await s.restartAdapter();
      t.notThrows(() => s.fake.acknowledge(s.runner.archive.state()));
    } else {
      t.is(state.segments, 0, 'not sealed: every record stays');
      t.is(s.records.base(), 0);
      await s.restartAdapter();
      // The adapter's validation: the vat names no segment, so any orphan
      // is dropped (the real store deletes its file).
      t.notThrows(() => s.fake.acknowledge(undefined));
    }
    t.is(await s.checkLog(), undefined, 'nothing lost or duplicated');
    // History: every turn once, newest first.
    const total = KEEP + SEG;
    const { seen } = s.historyWalk();
    t.deepEqual(
      seen,
      Array.from({ length: total }, (_, i) => `t${total - i}`),
    );
    // The next turn opens fresh ports (a broken seal dropped the held ones;
    // a restart after Z is found by the next claim's lease or open).
    await s.turn();
    t.true(s.counts.opens > opensBefore);
    // The next seal succeeds: after a break, at the eighth settle after it.
    const target = state.segments + 1;
    let extra = 1;
    while (s.runner.archive.state().segments < target && extra < 64) {
      // eslint-disable-next-line no-await-in-loop
      await s.turn();
      extra += 1;
    }
    t.is(s.runner.archive.state().segments, target, 'the next seal succeeds');
    if (reaches === 'break') {
      t.is(extra, limits.archiveSegmentTurns / 4, 'retried 8 settles later');
      if (orphan !== undefined) {
        // The same range sealed again: the same content and digest.
        t.is(s.runner.archive.entries()[0].digest, orphan.digest);
      }
    }
    t.is(await s.checkLog(), undefined);
    const walk = s.historyWalk().seen;
    t.is(new Set(walk).size, walk.length);
    t.is(walk.length, s.records.messageCount());
  });
}

test('a seal answered while later turns run drops only its range', async t => {
  const s = await makeArchiveSession();
  await s.turns(KEEP + SEG - 1);
  const held = s.fake.holdNext();
  await s.turn();
  t.is(s.fake.counts().seals, 1);
  // Three more turns, one of them current when the answer arrives.
  await s.turns(3);
  t.is(s.fake.counts().seals, 1, 'one seal at a time');
  const handle = s.runner.startTurn('in flight', 1_800_000_000_000);
  await drain();
  held.answer();
  await drain();
  t.is(s.runner.archive.state().segments, 1);
  t.is(s.runner.current()?.turn, handle);
  const req = s.lastRound();
  req.sink.dispatching(0);
  req.sink.roundFinal(
    harden({
      round: 0,
      text: 'late',
      toolCalls: harden([]),
      usage,
      at: 1_800_000_000_000,
    }),
  );
  await drain();
  t.is(await s.checkLog(), undefined);
  t.is(s.records.turnIds().length, KEEP + 4);
});

test('a rejected or mismatched seal leaves the records and retries 8 settles later', async t => {
  const s = await makeArchiveSession();
  await s.turns(KEEP + SEG - 1);
  s.fake.rejectNext('disk full');
  await s.turn();
  t.is(s.runner.archive.state().segments, 0);
  t.is(await s.checkLog(), undefined);
  await s.turns(limits.archiveSegmentTurns / 4 - 1);
  t.is(s.fake.counts().seals, 1, 'no retry within 8 settles');
  await s.turn();
  t.is(s.fake.counts().seals, 2);
  t.is(s.runner.archive.state().segments, 1);
  t.is(await s.checkLog(), undefined);
});

test('a stale or mismatched answer is ignored; nothing is dropped', async t => {
  const s = await makeArchiveSession({
    wrapPort: fake =>
      Far('ArchivePort', {
        seal: async (/** @type {any} */ req) => {
          const answer = await E(fake).seal(req);
          return harden({ ...answer, records: answer.records + 1 });
        },
      }),
  });
  await s.turns(KEEP + SEG);
  t.is(s.fake.counts().seals, 1);
  t.is(s.runner.archive.state().segments, 0);
  t.is(s.records.base(), 0);
  t.is(await s.checkLog(), undefined);
});

test('archived turns: findTurn, Turn handles, unresolved outcome-unknown turns (at most 64)', async t => {
  const s = await makeArchiveSession();
  // Turn 1 completes; turns 2..67 end outcome-unknown (66 of them).
  const first = await s.turn();
  /** @type {any[]} */
  const unknownHandles = [];
  for (let i = 0; i < 66; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    unknownHandles.push(await s.turn({ calls: 1, end: 'unknown' }));
  }
  t.is((await unknownHandles[0].getStatus()).state, 'outcome-unknown');
  // Enough turns to seal past turn 67 (three segments: 96 turns).
  await s.turns(KEEP + 3 * SEG - 67);
  t.is(s.runner.archive.state().sealedTurns, 3 * SEG);
  t.is(await s.checkLog(), undefined);

  // A kept turn's handle.
  const keptId = s.records.turnIds()[0];
  t.is((await s.runner.findTurn(keptId).getStatus()).turnId, keptId);
  // An archived completed turn: sealed; an unknown id: unknownTurn.
  t.throws(() => s.runner.findTurn('t1'), { message: texts.turnSealed });
  t.throws(() => s.runner.findTurn('t99999'), { message: texts.unknownTurn });
  t.throws(() => s.runner.findTurn('x1'), { message: texts.unknownTurn });
  t.is(s.runner.turnById('t1'), undefined, 'a receipt names it by id only');
  // A handle handed out before the seal keeps its status; content is sealed.
  t.is((await first.getStatus()).state, 'completed');
  t.is((await first.whenFinished()).state, 'completed');
  t.throws(() => first.getContent(), { message: texts.turnSealed });
  t.throws(() => first.resolve('note'), { message: texts.resolveNotUnknown });
  // 66 archived outcome-unknown turns; the 64 newest stay resolvable.
  t.throws(() => s.runner.findTurn('t2'), { message: texts.turnSealed });
  t.throws(() => s.runner.findTurn('t3'), { message: texts.turnSealed });
  t.throws(() => unknownHandles[0].resolve('late'), {
    message: texts.turnArchivedUnresolvable,
  });
  const handle = s.runner.findTurn('t4');
  t.is(handle, s.runner.findTurn('t4'), 'one handle while kept');
  t.is(s.runner.turnById('t4'), handle);
  handle.resolve('checked by hand');
  t.is((await handle.getStatus()).resolution, 'checked by hand');
  t.throws(() => s.runner.findTurn('t4'), { message: texts.turnSealed });
  t.throws(() => handle.resolve('again'), {
    message: texts.turnAlreadyResolved,
  });
  // The TurnResolved of an archived turn is a kept record, sealed later
  // with the turns around it (it lies in the span of the turn before it).
  const resolvedAt = s.all.length - 1;
  t.like(s.all[resolvedAt], { kind: 'turn-resolved', turnId: 't4' });
  t.is(await s.checkLog(), undefined);
  await s.turns(SEG * 5);
  t.true(s.runner.archive.state().sealedTo > resolvedAt);
  t.is(await s.checkLog(), undefined);
  const { seen } = s.historyWalk();
  t.is(new Set(seen).size, s.records.messageCount());
});

test('history pages: newest first, at most 32 turns, 48 records and frameBytes; the archive boundary', async t => {
  const s = await makeArchiveSession();
  await mixed(s, 300);
  const state = s.runner.archive.state();
  t.true(state.segments >= 5);
  const { seen, pages } = s.historyWalk();
  t.deepEqual(
    seen,
    Array.from({ length: 300 }, (_, i) => `t${300 - i}`),
  );
  for (const page of pages) {
    t.true(messageBytes(page) <= limits.frameBytes);
    t.true(Number(page.turns.length) <= limits.historyPageTurns);
    const count = page.turns.reduce(
      (/** @type {number} */ n, /** @type {any} */ one) =>
        n + one.records.length,
      0,
    );
    t.true(Number(count) <= limits.historyPageRecords);
    t.deepEqual(page.archive, state);
  }
  const last = pages[pages.length - 1];
  t.is(last.next, `h${state.sealedTurns}`);
  t.true(last.archived);
  // A cursor in the archive: no turns, the same cursor, archived.
  t.deepEqual(s.runner.historyPage(`h${state.sealedTurns}`), {
    archive: state,
    turns: [],
    next: `h${state.sealedTurns}`,
    archived: true,
  });
  t.deepEqual(s.runner.historyPage('h1').turns, []);
  t.throws(() => s.runner.historyPage('h301'), { message: texts.badCursor });
  t.throws(() => s.runner.historyPage('h0'), { message: texts.badCursor });
});

test('a turn over the page record bound shows its first 48 records, cut', async t => {
  const s = await makeArchiveSession();
  await s.turn();
  await s.turn({ calls: 60 });
  const page = s.runner.historyPage();
  t.is(page.turns.length, 1);
  t.is(page.turns[0].turnId, 't2');
  t.is(page.turns[0].records.length, limits.historyPageRecords);
  t.true(page.turns[0].cut);
  t.is(page.next, 'h1');
  t.is(page.archived, undefined);
  t.is(page.archive, undefined);
  const next = s.runner.historyPage(page.next);
  t.is(next.turns[0].turnId, 't1');
  t.is(next.next, undefined);
  // getContent pages the kept turn in full.
  const content = s.runner.findTurn('t2').getContent();
  t.true(Number(content.records.length) > limits.historyPageRecords);
});

test('getCurrentTurn shows the running turn', async t => {
  const s = await makeArchiveSession();
  s.runner.startTurn('now', 1_700_000_100_000);
  await drain();
  const current = /** @type {any} */ (s.runner.currentTurn());
  t.is(current.input, 'now');
  t.is(current.history.turnId, 't1');
  t.is(current.history.state, 'running');
});

test("sealed turns' Blob handles are no longer held by the session", async t => {
  const s = await makeArchiveSession({ tap: false, keepRounds: false });
  /** @type {WeakRef<object>[]} */
  const refs = [];
  const total = KEEP + SEG * 2;
  for (let i = 0; i < total; i += 1) {
    const { blob, staged } = stagedText(`input ${i}`);
    refs.push(new WeakRef(blob));
    // eslint-disable-next-line no-await-in-loop
    await s.turn({ input: staged });
  }
  s.published.length = 0;
  const state = s.runner.archive.state();
  t.is(state.sealedTurns, SEG * 2);
  await drain();
  gc();
  await drain();
  gc();
  const alive = refs.map(ref => ref.deref() !== undefined);
  const sealedAlive = alive.slice(0, state.sealedTurns).filter(Boolean).length;
  const keptAlive = alive.slice(state.sealedTurns).filter(Boolean).length;
  t.is(sealedAlive, 0, 'no sealed turn keeps its input Blob');
  t.is(keptAlive, total - state.sealedTurns, 'every kept turn keeps its Blob');
});

test('seams for W2.6: system prompt, output tokens, context window, turn deadline', async t => {
  const s = await makeArchiveSession({
    config: {
      systemPrompt: 'be brief',
      maxOutputTokens: 512,
      contextLength: 200_000,
      turnDeadlineMs: 5000,
    },
  });
  await s.turn();
  const req = s.rounds[0];
  t.is(req.system, 'be brief');
  t.is(req.options.maxOutputTokens, 512);
  t.is(s.runner.usage().context.windowTokens, 200_000);
  t.like(s.armed[0], { opId: 't1/deadline', ms: 5000 });
  // The deadline fires while a call runs: cancel, wait for the call, failed.
  s.runner.startTurn('slow', 1_700_000_500_000);
  await drain();
  const round0 = s.lastRound();
  round0.sink.dispatching(0);
  round0.sink.roundFinal(
    harden({
      round: 0,
      text: '',
      toolCalls: harden([harden({ callId: 'c', name: 'echo', args: '{}' })]),
      usage,
      at: 1_700_000_500_000,
    }),
  );
  await drain();
  round0.sink.deadline(harden({ opId: 't1/deadline' }));
  t.is(s.runner.current()?.turnId, 't2', "another turn's deadline is ignored");
  round0.sink.deadline(harden({ opId: 't2/deadline' }));
  await drain();
  t.is(s.cancels.length, 1);
  t.is(s.runner.current()?.state, 'cancelling');
  s.toolCalls.splice(0)[0].kit.resolve(harden({ status: 'ok', text: 'done' }));
  await drain();
  t.is(s.runner.current(), undefined);
  const settled = s.all.findLast(
    (/** @type {any} */ r) => r.kind === 'turn-settled',
  );
  t.like(settled, {
    status: 'failed',
    error: 'The turn ran longer than its 5000 ms deadline and was stopped',
  });
});

test('seams for W2.7: beginDelete, importTurns, importEnd, importUsage', async t => {
  const source = await makeArchiveSession();
  await mixed(source, 200);

  // importTurns: the whole log, in chunks; the new session seals as it goes.
  const copy = await makeArchiveSession();
  const all = source.all;
  for (let i = 0; i < all.length; i += 300) {
    copy.runner.importTurns(all.slice(i, i + 300));
    // eslint-disable-next-line no-await-in-loop
    await drain();
  }
  t.true(copy.runner.archive.state().segments >= 1);
  t.is(copy.records.messageCount(), 200);
  t.is(copy.records.count(), all.length);
  await copy.turn();
  t.is(await copy.checkLog(), undefined);
  t.is(copy.records.turnIds().at(-1), 't201');
  // The seal digests match the source's for the same ranges.
  const common = Math.min(
    copy.runner.archive.entries().length,
    source.runner.archive.entries().length,
  );
  t.deepEqual(
    copy.runner.archive.entries().slice(0, common),
    source.runner.archive.entries().slice(0, common),
  );

  // importUsage: the totals as exported.
  const totalsCopy = await makeArchiveSession();
  totalsCopy.runner.importUsage(source.runner.usage());
  t.deepEqual(totalsCopy.runner.usage(), source.runner.usage());

  // J-9493: a turn exported while it ran is settled outcome-unknown at the
  // end of the import, so it can be resolved and sealed past.
  const settledAt = all.findIndex(record => record.kind === 'turn-settled');
  const midTurn = await makeArchiveSession();
  midTurn.runner.importTurns(all.slice(0, settledAt));
  midTurn.runner.importEnd();
  t.is(
    (await midTurn.runner.findTurn('t1').getStatus()).state,
    'outcome-unknown',
  );
  t.is(midTurn.runner.usage().incompleteTurns, 1);
  // A settle outside its turn's span is refused.
  const misplaced = await makeArchiveSession();
  const t1 = all.slice(0, settledAt);
  const t2Start = all.findIndex(
    record => record.kind === 'turn-started' && record.turnId === 't2',
  );
  t.throws(() =>
    misplaced.runner.importTurns([...t1, all[t2Start], all[settledAt]]),
  );
  const twice = await makeArchiveSession();
  t.throws(() =>
    twice.runner.importTurns([...all.slice(0, settledAt + 1), all[settledAt]]),
  );

  // beginDelete: the current turn is cancelled at once; nothing new starts.
  source.runner.startTurn('going', 1_800_000_000_000);
  await drain();
  source.runner.beginDelete();
  t.is(source.runner.current(), undefined);
  t.true(source.runner.deleting());
  t.throws(() => source.runner.startTurn('more', 1_800_000_000_001), {
    message: texts.sessionDeleting,
  });
});
