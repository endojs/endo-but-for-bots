// @ts-check
/**
 * M2 acceptance 4, 5 and 10 (milestones.md M2; m2-interfaces.md 5; W2.4):
 * the full queue through the daemon, on the scripted backend, from the m1a
 * state template (the real session program).
 *
 * 4. A queue at 100 refuses with the R4-53 text; edit, delete and send-now
 *    work; the same request id twice returns the same id with
 *    `duplicate: true` and one transcript entry.
 * 5. With messages held `restart`, sending a new message or pressing
 *    send-now releases the hold and sends in FIFO order (R4-56).
 * 10. Two clients (two admin connections) see the same queue and
 *    transcript (P-25).
 *
 * Runs only with THIX_HARNESS_INTEGRATION=1, under the run lock:
 *
 *   THIX_HARNESS_INTEGRATION=1 node scripts/run-lock.mjs --label m2-queue -- \
 *     corepack yarn test test/integration/m2-queue.test.js
 *
 * While the queue fills, each Composer submission's round trip is emitted
 * as `queue.enqueue.e2e` (a turn runs; budget 150 ms). The row is W2.9's;
 * this file records what it saw on the way.
 */
import '../unit/_m1a-prelude.js';

import { performance } from 'node:perf_hooks';

import test from 'ava';

import { E } from '@endo/far';

/* eslint-disable import/no-relative-packages */
import { limits } from '../../guest/lib/limits.js';
import { texts, textOf } from '../../guest/lib/interfaces.js';
/* eslint-enable import/no-relative-packages */
import { emit, stats } from '../../perf/_harness.mjs';
import { inputs, sliceScript } from '../fixtures/scripts/m1a-slice.js';
import {
  TEMPLATE_WORKSPACE,
  integrationEnabled,
  startFromTemplate,
  takeIntegrationLock,
} from '../template/index.js';
import { makeSlice, round1, sliceTemplate, waitFor } from './_m1a-slice.js';

takeIntegrationLock(test, 'm2 queue test');

const run = integrationEnabled ? test.serial : test.skip;

/** @type {Awaited<ReturnType<typeof sliceTemplate>> | undefined} */
let template;
/** @param {import('ava').ExecutionContext} t */
const open = async t => {
  template ??= await sliceTemplate();
  const state = await startFromTemplate(template, { t });
  const slice = await makeSlice(state);
  const made = await slice.makeBackend(harden(sliceScript));
  const session = await slice.createSession(made.backend);
  return { state, slice, session, ...made };
};

/** @param {any} pending */
const previews = pending =>
  pending.entries.map((/** @type {any} */ e) => e.preview);

/**
 * Inputs of the session's turns in turn order (`t1`, `t2`, ...), read
 * through history pages (newest first).
 * @param {any} session
 */
const turnInputs = async session => {
  /** @type {{ n: number, input: any, state: string }[]} */
  const turns = [];
  let page = await E(session).getHistoryPage();
  for (;;) {
    for (const tp of page.turns) {
      turns.push({
        n: Number(tp.turnId.slice(1)),
        input: tp.records[0]?.input,
        state: tp.state,
      });
    }
    if (page.next === undefined) break;
    // eslint-disable-next-line no-await-in-loop
    page = await E(session).getHistoryPage(page.next);
  }
  return turns.sort((a, b) => a.n - b.n);
};

/**
 * Wait until every turn is settled and `count` turns exist.
 * @param {any} session
 * @param {number} count
 */
const settledTurns = (session, count) =>
  waitFor(
    async () => {
      const turns = await turnInputs(session);
      return turns.length >= count &&
        turns.every(tp => tp.state !== 'running' && tp.state !== 'cancelling')
        ? turns
        : undefined;
    },
    60_000,
    `${count} settled turns`,
    100,
  );

run(
  '4 and 10: a full queue, edit, delete, send-now and duplicates, seen by two clients',
  async t => {
    t.timeout(4 * 60_000);
    const { state, slice, session } = await open(t);
    // A second admin connection: its own client, factory and session presence.
    const client2 = await state.connect({ workspace: TEMPLATE_WORKSPACE });
    t.teardown(() => client2.close());
    const other = await makeSlice({ client: client2, root: state.root });
    const session2 = await E(other.factory).findSession('s1');

    const running = await slice.submit(session, inputs.stall);
    t.is(running.state, 'started');

    // Fill the queue while the turn runs, timing each Composer round trip.
    /** @type {number[]} */
    const samples = [];
    /** @type {any[]} */
    const receipts = [];
    for (let i = 0; i < limits.maxWaiting; i += 1) {
      const t0 = performance.now();
      // eslint-disable-next-line no-await-in-loop
      const receipt = await slice.submit(session, `m${i}`);
      samples.push(performance.now() - t0);
      receipts.push(receipt);
    }
    // The whole sweep (0 to 99 waiting before each) and the shallow end
    // (0 to 9 waiting), both against the budget; the medians per 25 show
    // the cost of the `pending` view each enqueue publishes (it carries
    // every waiting row; J-0454).
    const median = (/** @type {number[]} */ xs) =>
      round1([...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]);
    const byDepth = [0, 25, 50, 75].map(from => ({
      waitingFrom: from,
      medianMs: median(samples.slice(from, from + 25)),
    }));
    await stats('queue.enqueue.e2e', samples, {
      budget: { median: 150 },
      extra: { waitingFrom: 0, waitingTo: 99, byDepth, by: 'W2.4' },
    });
    await stats('queue.enqueue.e2e.shallow', samples.slice(0, 10), {
      budget: { median: 150 },
      extra: { waitingFrom: 0, waitingTo: 9, by: 'W2.4' },
    });
    t.true(receipts.every(r => r.state === 'queued' && !r.duplicate));

    // 4: the 101st is refused with the R4-53 text.
    await t.throwsAsync(() => slice.submit(session, 'one too many'), {
      message: textOf.queueFull(limits.maxWaiting),
    });
    // 10: the other client sees the same 100 entries.
    const seen2 = await E(session2).listPending();
    t.is(seen2.entries.length, limits.maxWaiting);
    t.deepEqual(previews(seen2), previews(await E(session).listPending()));

    // 4: the same request id twice: the same id, duplicate, no new entry.
    const id = receipts[0].requestId;
    const again = await slice.submit(session, 'm0', id);
    t.is(again.requestId, id);
    t.true(again.duplicate);
    t.is((await E(session).listPending()).entries.length, limits.maxWaiting);

    // Delete 96 from the second client (its own presences), keep m0..m3.
    const all2 = (await E(session2).listPending()).entries;
    const cancelled = await Promise.all(
      all2.slice(4).map((/** @type {any} */ row) => E(row.entry).cancel()),
    );
    t.true(cancelled.every(Boolean));
    t.deepEqual(previews(await E(session2).listPending()), [
      'm0',
      'm1',
      'm2',
      'm3',
    ]);

    // Edit through the Composer (client 1); client 2 sees it.
    await E(slice.composer).edit(receipts[1].entry, 'm1 edited');
    // Delete m2 through client 2's presence of the entry.
    const rows2 = (await E(session2).listPending()).entries;
    t.true(await E(rows2[2].entry).cancel());
    t.false(await E(receipts[2].entry).cancel(), 'already gone');
    // Send-now m3 (client 2): it moves to the head and the running turn is
    // cancelled so it goes next (R6-44, PM ruling 9).
    await E(rows2[3].entry).sendNow();
    t.deepEqual(previews(await E(session).listPending()), ['m0', 'm1 edited']);
    await t.throwsAsync(() => E(receipts[2].entry).sendNow(), {
      message: texts.entryGone,
    });

    // m3 ran next, then m0, then the edited m1.
    const turns = await settledTurns(session, 4);
    t.is((await E(running.turn).getStatus()).state, 'cancelled');
    t.deepEqual(
      turns.map(tp => tp.input),
      [inputs.stall, 'm3', 'm0', 'm1 edited'],
    );
    // 10: client 2 reads the same transcript.
    const turns2 = await turnInputs(session2);
    t.deepEqual(
      turns2.map(tp => tp.input),
      turns.map(tp => tp.input),
    );
    // 4: a duplicate after its turn ran: started, the same turn, one entry.
    const dup = await slice.submit(session, 'm0', id);
    t.true(dup.duplicate);
    t.is(dup.state, 'started');
    t.is(dup.turnId, 't3');
    t.is((await turnInputs(session)).filter(tp => tp.input === 'm0').length, 1);
    t.deepEqual((await E(session).listPending()).entries, []);
  },
);

run(
  '5: messages held restart: a new message, or send-now, releases the hold; FIFO',
  async t => {
    t.timeout(4 * 60_000);
    const { state, slice, session } = await open(t);

    // Round 1: a new message releases the hold; the old ones go first.
    await slice.submit(session, inputs.stall);
    await slice.submit(session, 'a');
    await slice.submit(session, 'b');
    const t0 = performance.now();
    await state.kill();
    const restarted = await state.restart();
    await slice.refresh();
    const s1 = await E(slice.factory).findSession('s1');
    const held = await E(s1).listPending();
    emit({
      metric: 'm2.queue.restart',
      unit: 'ms',
      restartMs: round1(performance.now() - t0),
      ...restarted,
    });
    t.deepEqual(previews(held), ['a', 'b']);
    t.deepEqual(held.hold, { reason: 'restart', message: texts.holdRestart });
    t.deepEqual(
      (await turnInputs(s1)).map(tp => tp.input),
      [inputs.stall],
      'nothing is sent with nobody watching',
    );
    await slice.submit(s1, 'c');
    let turns = await settledTurns(s1, 4);
    t.deepEqual(
      turns.map(tp => tp.input),
      [inputs.stall, 'a', 'b', 'c'],
    );
    t.is((await E(s1).listPending()).hold, undefined);

    // Round 2: send-now releases the hold; the rest follow in order.
    await slice.submit(s1, inputs.stall);
    await slice.submit(s1, 'd');
    await slice.submit(s1, 'e');
    await slice.submit(s1, 'f');
    await state.kill();
    await state.restart();
    await slice.refresh();
    const s2 = await E(slice.factory).findSession('s1');
    const held2 = await E(s2).listPending();
    t.deepEqual(previews(held2), ['d', 'e', 'f']);
    t.is(held2.hold?.reason, 'restart');
    await E(held2.entries[1].entry).sendNow();
    turns = await settledTurns(s2, 8);
    t.deepEqual(
      turns.map(tp => tp.input),
      [inputs.stall, 'a', 'b', 'c', inputs.stall, 'e', 'd', 'f'],
    );
    t.deepEqual(await E(s2).listPending(), { entries: [] });
  },
);
