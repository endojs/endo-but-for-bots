// @ts-check
/**
 * Compaction kill points through the daemon (`designs/m8-interfaces.md` 8,
 * 12 acceptance 2 and 11), from the m1a state template, with an Anthropic
 * API backend on the fake provider server and a scripted backend; the
 * supervisor is SIGKILLed (`state.kill()`) and the same copy served again.
 *
 * - K1 (scripted, a reading of 80 of 100): crank X is journaled
 *   (`compaction-started` recorded, `startRound` sent) and the adapter
 *   holds the round before `dispatching(0)` (the script's
 *   `dispatchDelayMs`; the scripted round prepares first, so the kill lands
 *   after the prepare, before dispatch). After the restart the turn is
 *   `interrupted` ("Interrupted before dispatch"), with no `dispatched`
 *   record; the started record stays unanswered.
 * - K2 (acceptance 2): the summary call is in flight (the fake server never
 *   answers it). After the restart the turn is `outcome-unknown`, there is
 *   no `compaction` record, and the next turn's model request starts with
 *   the uncompacted history (its own summary is refused, so its round runs
 *   on the context as it stands).
 * - K7 (with K5's outcome): the compaction is recorded and the round after
 *   it is in flight. After the restart the turn is `outcome-unknown`, the
 *   `compaction` record stays (one, never two), and the next turn's request
 *   starts with the summary: the adapter's first prepare after the restart
 *   is a rebuild from the vat's base with `epoch > 0`.
 *
 * K1 and K2 share one kill (two sessions in flight at once). K3, K4 and K6
 * are adapter-level (`test/adapter/context-cache-compaction.test.js`,
 * `compaction-round.test.js`, by fault hooks); a kill cannot be placed
 * between the summary's staging and `compacted` from here.
 *
 * Runs only with THIX_HARNESS_INTEGRATION=1, under the run lock:
 *
 *   corepack yarn test:integration test/integration/compaction-restart.test.js
 */
import '../unit/_m1a-prelude.js';

import test from 'ava';

import { E } from '@endo/far';

/* eslint-disable import/no-relative-packages */
import { compactionTexts } from '../../guest/lib/guards/session.js';
import { texts } from '../../guest/lib/interfaces.js';
/* eslint-enable import/no-relative-packages */
import {
  compactionSkipTexts,
  summaryHeadings,
} from '../../resources/agent-host/impl/providers/compaction.js';
import { integrationEnabled, takeIntegrationLock } from '../template/index.js';
import { waitFor } from './_m1a-slice.js';
import {
  OVER_THRESHOLD,
  anthropicSession,
  contentOf,
  filler,
  killAndRestart,
  modelRequestCount,
  modelRequests,
  openCompactionState,
  reply,
  runTurn,
  untilTurnState,
} from './_compaction.js';

takeIntegrationLock(test, 'compaction restart test');

const run = integrationEnabled ? test.serial : test.skip;

const SUMMARY = summaryHeadings
  .map(heading => `${heading}\n- kept fact under ${heading.slice(3)}`)
  .join('\n');

/** @type {Awaited<ReturnType<typeof openCompactionState>> | undefined} */
let shared;
test.after.always(() => shared?.cleanup());

const counts = {
  inputTokens: 10,
  outputTokens: 5,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  reasoningOutputTokens: 0,
};
/** @param {number} usedTokens */
const usage = usedTokens => ({
  ...counts,
  context: { usedTokens, windowTokens: 100 },
});

/**
 * The kinds of the records of one turn, found by id on the history page.
 * @param {any} session
 * @param {string} turnId
 */
const recordsOf = async (session, turnId) => {
  const page = await E(session).getHistoryPage();
  const preview = page.turns.find(
    (/** @type {any} */ p) => p.turnId === turnId,
  );
  return contentOf(preview.turn);
};

/**
 * @param {any[]} records
 * @param {string} kind
 */
const count = (records, kind) => records.filter(r => r.kind === kind).length;

run(
  'K1, K2 and K7: a kill before dispatch, during the summary call, and after the compaction',
  async t => {
    t.timeout(4.5 * 60_000);
    shared = await openCompactionState();
    const { state, slice, server, anthropic } = shared;

    // Session A (Anthropic): two long turns, the second over 70 %.
    let a = await anthropicSession(slice, anthropic, 'kills');
    const { key: keyA } = await E(a.session).getInfo();
    server.push(reply(filler('one', 8000), { input: 1000 }));
    await runTurn(slice, a.session, a.live, 'first');
    server.push(
      reply(filler('two', 8000), { input: OVER_THRESHOLD, output: 100 }),
    );
    await runTurn(slice, a.session, a.live, 'second');

    // Session B (scripted): one turn at 80 of 100, then one held before
    // dispatch.
    const scripted = await slice.makeBackend(
      harden({
        turns: [
          {
            input: 'b one',
            rounds: [
              { chunks: [{ text: filler('b', 3000) }], usage: usage(80) },
            ],
          },
          {
            input: 'b held',
            rounds: [{ dispatchDelayMs: 600_000, chunks: [{ text: 'x' }] }],
          },
          { rounds: [{ chunks: [{ text: 'after' }], usage: usage(10) }] },
        ],
      }),
    );
    const sessionB = await slice.createSession(scripted.backend, 'k1');
    const { key: keyB } = await E(sessionB).getInfo();
    let liveB = await slice.subscribe(sessionB);
    await runTurn(slice, sessionB, liveB, 'b one');

    // ---- K1 and K2 in flight: B's round held before dispatch, A's summary
    // call unanswered.
    const k1 = await runTurn(slice, sessionB, liveB, 'b held', {
      settle: false,
    });
    await waitFor(
      () =>
        k1
          .events()
          .some(
            (/** @type {any} */ e) =>
              e.type === 'phase' && e.phase === compactionTexts.phase,
          ),
      30_000,
      'B asked to compact',
    );
    await waitFor(
      () =>
        scripted
          .log()
          .some(l => l.kind === 'round-start' && l.turnId === k1.turnId),
      30_000,
      'B round started in the adapter',
    );
    const k2From = modelRequestCount(server);
    server.push({ hang: true });
    const k2 = await runTurn(slice, a.session, a.live, 'k2', { settle: false });
    await waitFor(
      () => modelRequests(server, k2From).some(r => r.summary),
      30_000,
      'the summary call sent',
    );
    t.false(
      scripted.log().some(l => l.kind === 'request' && l.turnId === k1.turnId),
      'B never reached its request',
    );
    await a.live.stop();
    await liveB.stop();
    a = await killAndRestart(state, slice, keyA);
    const sessionB2 = await E(slice.factory).findSession(keyB);
    liveB = await slice.subscribe(sessionB2);

    // K1: interrupted before dispatch; the started record stays unanswered.
    await untilTurnState(sessionB2, k1.turnId, 'interrupted');
    const k1Records = await recordsOf(sessionB2, k1.turnId);
    t.is(count(k1Records, 'compaction-started'), 1);
    t.is(count(k1Records, 'compaction'), 0);
    t.is(count(k1Records, 'dispatched'), 0);
    t.like(k1Records.at(-1), {
      kind: 'turn-settled',
      status: 'interrupted',
      error: texts.interruptedBeforeDispatch,
    });

    // K2 (acceptance 2): outcome-unknown, no compaction record.
    await untilTurnState(a.session, k2.turnId, 'outcome-unknown');
    const k2Records = await recordsOf(a.session, k2.turnId);
    t.is(count(k2Records, 'compaction-started'), 1);
    t.is(count(k2Records, 'compaction'), 0);
    t.is(count(k2Records, 'dispatched'), 1);

    // The next turn's request is the uncompacted context: its own summary
    // is refused (an empty answer), so the round streams as it stands.
    const afterK2From = modelRequestCount(server);
    server.push(
      reply('', { input: 100 }),
      reply('after k2', { input: OVER_THRESHOLD }),
    );
    const afterK2 = await runTurn(slice, a.session, a.live, 'after k2');
    const afterK2Asked = modelRequests(server, afterK2From);
    t.deepEqual(
      afterK2Asked.map(r => r.summary),
      [true, false],
    );
    t.is(afterK2Asked[1].role, 'user');
    t.is(afterK2Asked[1].text, 'first', 'the context starts at turn 1');
    const afterK2Records = await contentOf(afterK2.turn);
    t.is(
      afterK2Records.find(r => r.kind === 'compaction-skipped')?.reason,
      compactionSkipTexts.invalidSummary,
    );
    t.is(afterK2Records.at(-1).status, 'completed');

    // ---- K7: the compaction recorded, the round after it in flight.
    const k7From = modelRequestCount(server);
    server.push(reply(SUMMARY, { input: 3000, output: 400 }), { hang: true });
    const k7 = await runTurn(slice, a.session, a.live, 'k7', { settle: false });
    await waitFor(
      () => modelRequests(server, k7From).some(r => !r.summary),
      30_000,
      'the round after the compaction sent',
    );
    const k7Round = modelRequests(server, k7From).find(r => !r.summary);
    t.is(k7Round?.text, SUMMARY);
    await a.live.stop();
    await liveB.stop();
    a = await killAndRestart(state, slice, keyA);
    t.teardown(() => a.live.stop());
    await untilTurnState(a.session, k7.turnId, 'outcome-unknown');
    const k7Records = await recordsOf(a.session, k7.turnId);
    t.is(count(k7Records, 'compaction'), 1);

    // The next turn starts from the summary. The reading is still the last
    // real round's, so it asks again, but only the unanswered turn K7 lies
    // between the boundary and this turn: the fixed parts alone are over
    // the headroom, so the plan refuses before any summary call.
    const afterK7From = modelRequestCount(server);
    server.push(reply('after k7', { input: 2000 }));
    const afterK7 = await runTurn(slice, a.session, a.live, 'after k7');
    const afterK7Asked = modelRequests(server, afterK7From);
    t.deepEqual(
      afterK7Asked.map(r => r.summary),
      [false],
    );
    t.is(
      (await contentOf(afterK7.turn)).find(r => r.kind === 'compaction-skipped')
        ?.reason,
      compactionSkipTexts.headroomExceeded,
    );
    t.is(afterK7Asked[0].role, 'assistant');
    t.is(afterK7Asked[0].text, SUMMARY, 'the compaction survived the kill');
    t.is((await contentOf(afterK7.turn)).at(-1).status, 'completed');

    // Never two compaction records for one ask: one in the whole session.
    let compactions = 0;
    for (const p of (await E(a.session).getHistoryPage()).turns) {
      // eslint-disable-next-line no-await-in-loop
      compactions += count(await contentOf(p.turn), 'compaction');
    }
    t.is(compactions, 1);
  },
);
