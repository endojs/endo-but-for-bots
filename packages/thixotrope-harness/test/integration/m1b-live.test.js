// @ts-check
/**
 * M1b acceptance 1, 6 and 9 (milestones.md M1b), observable through the
 * public objects of a real daemon (W1b.6):
 *
 * 1. A second subscriber attached mid-turn receives a fold equal to the
 *    events so far (its snapshot), then the same live events as the first.
 * 6. A round with 100 `echo` calls: 64 run, 36 get the too-many-calls text;
 *    the session keeps working.
 * 9. Two list-feed subscribers see create and rename within 500 ms; a
 *    closed subscriber is dropped (its `next()` answers closed at once and
 *    stays empty). Delete needs M2's `deleteSession` (16.6): that part is a
 *    known failure (`test.failing`) until M2 builds it.
 *
 * State: the m1b template (real session and exec programs, default pool).
 *
 *   THIX_HARNESS_INTEGRATION=1 node scripts/run-lock.mjs --label m1b-live -- \
 *     corepack yarn test test/integration/m1b-live.test.js
 */
/* eslint-disable no-await-in-loop -- steps of one scenario run in order */
import '../unit/_m1a-prelude.js';

import { performance } from 'node:perf_hooks';

import test from 'ava';

import { E } from '@endo/far';

/* eslint-disable import/no-relative-packages */
import { textOf } from '../../guest/lib/interfaces.js';
import { limits } from '../../guest/lib/limits.js';
import {
  makeFoldableStatus,
  makeReplyFold,
} from '../../guest/lib/reply-fold.js';
/* eslint-enable import/no-relative-packages */
import {
  emit,
  loadAvg,
  runIdentity,
  crankBudget,
} from '../../perf/_harness.mjs';
import {
  integrationEnabled,
  startFromTemplate,
  takeIntegrationLock,
} from '../template/index.js';
import { collect, makeSlice, round1, waitFor } from './_m1a-slice.js';
import { execTemplate } from './_m1b-exec.js';
import { runTurn, turnRecords } from './_m1b.js';

takeIntegrationLock(test, 'm1b live test');

const run = integrationEnabled ? test.serial : test.skip;

const usage = {
  inputTokens: 10,
  outputTokens: 5,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  reasoningOutputTokens: 0,
};

const CALLS = 100;

const script = harden({
  turns: [
    {
      // About 3 s of streaming, a tool call, then a second round.
      input: 'stream',
      rounds: [
        {
          chunks: Array.from({ length: 30 }, (_, i) => ({
            text: `w${i} `,
            delayMs: 100,
          })),
          toolCalls: [
            { name: 'echo', args: JSON.stringify({ text: 'e', delayMs: 300 }) },
          ],
          usage,
        },
        {
          chunks: Array.from({ length: 10 }, (_, i) => ({
            text: `r${i} `,
            delayMs: 100,
          })),
          usage,
        },
      ],
    },
    {
      input: 'hundred',
      rounds: [
        {
          chunks: [{ text: 'many calls' }],
          toolCalls: Array.from({ length: CALLS }, (_, i) => ({
            name: 'echo',
            args: JSON.stringify({ text: `t${i}` }),
          })),
          usage,
        },
        { chunks: [{ text: 'after the calls' }], usage },
      ],
    },
    { rounds: [{ chunks: [{ text: 'hello' }], usage }] },
  ],
});

/** @param {import('ava').ExecutionContext} t */
const open = async t => {
  const template = await execTemplate();
  const state = await startFromTemplate(template, { t });
  const slice = await makeSlice(state);
  const made = await slice.makeBackend(script);
  return { state, slice, made };
};

/**
 * The event as the channel's fold reads it (`AH/channels.js` `foldable`):
 * a delta keeps only its text; other events lose `turnId`. (No staged
 * field occurs in this test.)
 * @param {any} event
 */
const foldable = event => {
  if (event.type === 'delta') return { type: 'delta', text: event.text };
  const { turnId: _turnId, ...rest } = event;
  return rest;
};

/** @param {unknown} x */
const plain = x => JSON.parse(JSON.stringify(x));

run(
  '1: a subscriber attached mid-turn gets the fold so far, then the same events',
  async t => {
    t.timeout(4 * 60_000);
    const { slice } = await open(t);
    const session = await slice.createSession(
      (await slice.makeBackend(script)).backend,
      'late join',
    );
    const first = await slice.subscribe(session);
    t.teardown(() => first.stop());
    const receipt = await slice.submit(session, 'stream');
    const { turnId } = await E(receipt.turn).getStatus();
    // Mid-turn: after some deltas, before the end.
    await first.until(
      e =>
        e.type === 'delta' && e.turnId === turnId && e.text.startsWith('w12'),
    );
    const second = collect(await E(slice.live).subscribe(session));
    t.teardown(() => second.stop());
    await first.until(e => e.type === 'end' && e.turnId === turnId, 60_000);
    await second.until(e => e.type === 'end' && e.turnId === turnId, 10_000);

    const [snap, ...rest] = second.deliveries;
    t.is(snap.event.type, 'snapshot');
    t.is(snap.event.turn?.turnId, turnId);
    t.false(snap.event.turn?.settled, 'attached mid-turn');
    // The fold of the first subscriber's events up to the snapshot's seq.
    const fold = makeReplyFold();
    const status = makeFoldableStatus();
    let folding = false;
    for (const d of first.deliveries) {
      if (d.seq > snap.seq) break;
      const { event } = d;
      if (event.type === 'turn-start' && event.turnId === turnId)
        folding = true;
      else if (folding && event.turnId === turnId && event.type !== 'pending')
        fold.apply(status, /** @type {any} */ (foldable(event)));
    }
    t.true(status.streamingText.length > 0 || status.messages.length > 0);
    t.deepEqual(
      plain(snap.event.turn.status),
      plain(status),
      'the snapshot equals the fold of the events so far',
    );
    // Then exactly the same deliveries, same seq, same events.
    const after = first.deliveries.filter(
      d => d.seq > snap.seq && d.seq <= rest[rest.length - 1].seq,
    );
    t.true(after.length > 10, 'live events followed the snapshot');
    t.deepEqual(
      rest.map(d => ({ seq: d.seq, rev: d.rev, event: plain(d.event) })),
      after.map(d => ({ seq: d.seq, rev: d.rev, event: plain(d.event) })),
    );
    t.is(rest[0].seq, snap.seq + 1, 'no gap after the snapshot');
    emit({
      metric: 'm1b.acceptance1',
      snapshotSeq: snap.seq,
      foldedMessages: status.messages.length,
      eventsAfter: rest.length,
      ...(await runIdentity()),
      crankBudget,
      loadAvg: loadAvg(),
    });
  },
);

// J-0362: at Thixotrope's default slot ceiling (1,000,000) the session vat
// halted with HeapExhausted in the crank that records this round; the
// harness serves with 4,000,000 since M1b QC (J-0392). The largest round a
// provider may send (256 calls) is in m1b-qc.test.js.
run(
  '6: 100 echo calls in one round: 64 run, 36 get the too-many-calls text',
  async t => {
    t.timeout(4 * 60_000);
    const { slice, made } = await open(t);
    const session = await slice.createSession(made.backend, 'hundred');
    const live = await slice.subscribe(session);
    t.teardown(() => live.stop());
    const t0 = performance.now();
    const { turn, turnId, end } = await runTurn(
      slice,
      session,
      live,
      'hundred',
      120_000,
    );
    const turnMs = round1(performance.now() - t0);
    t.is(end.status, 'completed');
    const records = await turnRecords(turn);
    const intents = records
      .filter(r => r.kind === 'tool-intents')
      .flatMap(r => r.intents);
    t.is(intents.length, CALLS, 'every call is recorded as an intent');
    const results = records.filter(r => r.kind === 'tool-result');
    t.is(results.length, CALLS, 'every call has a result');
    const order = new Map(intents.map((x, i) => [x.opId, i]));
    results.sort(
      (a, b) => Number(order.get(a.opId)) - Number(order.get(b.opId)),
    );
    const ran = results.slice(0, limits.maxCallsPerRound);
    const refused = results.slice(limits.maxCallsPerRound);
    t.deepEqual(
      ran.map(r => r.result),
      ran.map((_, i) => `t${i}`),
      'the first 64 ran, in call order',
    );
    t.true(ran.every(r => !r.failed));
    const tooMany = textOf.tooManyCalls(CALLS, limits.maxCallsPerRound);
    t.is(refused.length, CALLS - limits.maxCallsPerRound);
    t.true(
      refused.every(r => r.result === tooMany && r.failed === true),
      'the other 36 got the too-many-calls text',
    );
    const started = made
      .log()
      .filter(l => l.kind === 'echo-start' && l.opId.startsWith(`${turnId}/`));
    t.is(started.length, limits.maxCallsPerRound, 'echo ran 64 times');
    // The session keeps working.
    const next = await runTurn(slice, session, live, 'hi');
    t.is(next.end.status, 'completed');
    emit({
      metric: 'm1b.acceptance6',
      turnMs,
      calls: CALLS,
      ran: started.length,
      ...(await runIdentity()),
      crankBudget,
      loadAvg: loadAvg(),
    });
  },
);

/**
 * Two list subscribers and the session list feed.
 * @param {any} slice
 */
const listViewers = async slice => {
  const { rev } = await E(slice.factory).sessionListFeed();
  const a = collect(await E(slice.live).subscribeList(rev));
  const b = collect(await E(slice.live).subscribeList(rev));
  return { rev, a, b };
};

/**
 * Wait for a `row` event naming `key` that matches, on a list viewer;
 * answer its arrival time (Date.now()).
 * @param {ReturnType<typeof collect>} viewer
 * @param {(row: any) => boolean} match
 */
const rowArrival = async (viewer, match) => {
  const i = await viewer.until(e => e.type === 'row' && match(e.row), 10_000);
  return viewer.deliveries[i].arrivedAt;
};

run(
  '9: two list subscribers see create and rename within 500 ms; a closed one is dropped',
  async t => {
    t.timeout(4 * 60_000);
    const { slice, made, state } = await open(t);
    // Let the pool's start-time refill settle (not part of the push).
    await E(slice.harness).whenSettled();
    const { a, b } = await listViewers(slice);
    t.teardown(() => Promise.all([a.stop(), b.stop()]));
    const [snapA] = await Promise.all([
      a.until(e => e.type === 'list-snapshot').then(i => a.deliveries[i]),
      b.until(e => e.type === 'list-snapshot'),
    ]);
    t.is(snapA.event.type, 'list-snapshot');

    /** @type {Record<string, number>[]} */
    const timings = [];
    for (let i = 0; i < 3; i += 1) {
      const callAt = Date.now();
      const session = await slice.createSession(made.backend, `listed ${i}`);
      const returnedAt = Date.now();
      const { key } = await E(session).getInfo();
      const [ca, cb] = await Promise.all(
        [a, b].map(v => rowArrival(v, row => row.key === key)),
      );
      const renameAt = Date.now();
      await E(session).rename(`renamed ${i}`);
      const [ra, rb] = await Promise.all(
        [a, b].map(v =>
          rowArrival(v, row => row.key === key && row.title === `renamed ${i}`),
        ),
      );
      timings.push({
        createCallMs: returnedAt - callAt,
        createRowAfterReturnMs: Math.max(ca, cb) - returnedAt,
        createRowFromCallMs: Math.max(ca, cb) - callAt,
        renameRowMs: Math.max(ra, rb) - renameAt,
      });
    }
    for (const row of timings) {
      t.true(
        row.createRowAfterReturnMs <= 500,
        `create row ${row.createRowAfterReturnMs} ms after createSession returned`,
      );
      t.true(row.renameRowMs <= 500, `rename row ${row.renameRowMs} ms`);
    }
    // Both saw the same deliveries, in rev order.
    const revs = (/** @type {ReturnType<typeof collect>} */ v) =>
      v.deliveries.filter(d => d.event.type === 'row').map(d => d.rev);
    t.deepEqual(revs(a), revs(b));
    t.deepEqual(
      revs(a),
      [...revs(a)].sort((x, y) => x - y),
    );

    // A closed subscriber is dropped: next() answers closed at once and
    // receives nothing more while the other keeps receiving.
    await b.stop();
    const closedSub = await E(slice.live).subscribeList();
    await E(closedSub).close();
    const t0 = performance.now();
    const closedBatch = await E(closedSub).next();
    const closedMs = round1(performance.now() - t0);
    t.true(closedBatch.closed);
    t.is(closedBatch.reason, 'client');
    t.is(closedBatch.deliveries.length, 0);
    const extra = await slice.createSession(made.backend, 'after close');
    const { key: extraKey } = await E(extra).getInfo();
    await rowArrival(a, row => row.key === extraKey);
    const again = await E(closedSub).next();
    t.true(again.closed);
    t.is(again.deliveries.length, 0, 'nothing reached the closed subscriber');
    const bAfter = b.deliveries.filter(
      d => d.event.type === 'row' && d.event.row.key === extraKey,
    );
    t.is(bAfter.length, 0, 'nothing reached the stopped viewer');
    // The daemon is still healthy.
    t.truthy(await state.client.call('status'));
    const row = {
      metric: 'list.push',
      unit: 'ms',
      timings,
      closedNextMs: closedMs,
      ...(await runIdentity()),
      crankBudget,
      loadAvg: loadAvg(),
    };
    emit(row);
    t.log(row);
  },
);

// Known failure until M2 (W2.7 `deleteSession`, m1b-interfaces.md 16.6):
// there is no delete, so no `row-removed` event can be observed.
(integrationEnabled ? test.failing : test.skip)(
  '9 (delete): list subscribers see a delete within 500 ms [known failure: deleteSession is M2]',
  async t => {
    t.timeout(2 * 60_000);
    const { slice, made } = await open(t);
    const { a } = await listViewers(slice);
    t.teardown(() => a.stop());
    const session = await slice.createSession(made.backend, 'to delete');
    const { key } = await E(session).getInfo();
    await rowArrival(a, row => row.key === key);
    await E(slice.factory).deleteSession(session);
    await waitFor(
      () =>
        a.deliveries.find(
          d => d.event.type === 'row-removed' && d.event.key === key,
        ),
      500,
      'row-removed',
    );
    t.pass();
  },
);
