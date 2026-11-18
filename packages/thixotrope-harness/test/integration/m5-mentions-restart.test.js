// @ts-check
/**
 * M5 acceptance 11a, kill points K3 and K6 for mentions (W5.7;
 * designs/m5-interfaces.md section 5, 8.1 item 11), in a real daemon on
 * the m1a slice template:
 *
 * - K3: SIGKILL right after a turn that `adopt`ed an attachment; after the
 *   restart `list` shows the adopted label (the binding and its result
 *   record exactly once);
 * - K6: SIGKILL while a turn claimed by `enqueueMessageOnce` runs (package
 *   #2) and two entries with attachments wait; after the restart the
 *   claimed turn is settled by recovery and its package is closed (`adopt`
 *   from it answers `noPackage`), the two entries are held `restart` and
 *   keep their attachments; a new message releases them and they run in
 *   order, each with its own package number and R4-29 line.
 *
 *   THIX_AGENT=W5.7 corepack yarn test:integration test/integration/m5-mentions-restart.test.js
 */
import '../unit/_m1a-prelude.js';

import { performance } from 'node:perf_hooks';

import test from 'ava';

import { E } from '@endo/far';

/* eslint-disable import/no-relative-packages */
import { texts, textOf } from '../../guest/lib/interfaces.js';
/* eslint-enable import/no-relative-packages */
import { emit, loadAvg, runIdentity } from '../../perf/_harness.mjs';
import {
  integrationEnabled,
  killStrays,
  startFromTemplate,
  takeIntegrationLock,
} from '../template/index.js';
import {
  makeSlice,
  requestId,
  round1,
  sliceTemplate,
  waitFor,
} from './_m1a-slice.js';
import { runTurn, turnRecords } from './_m1b.js';

takeIntegrationLock(test, 'm5 mentions restart test');

const run = integrationEnabled ? test.serial : test.skip;

const usage = {
  inputTokens: 10,
  outputTokens: 5,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  reasoningOutputTokens: 0,
};
/** @param {{ name: string, args: string }[]} toolCalls */
const callRound = toolCalls => ({
  chunks: [{ text: 'tools' }],
  toolCalls,
  usage,
});
const closing = { chunks: [{ text: 'done' }], usage };
/**
 * @param {number} n
 * @param {string} edge
 * @param {string} pet
 */
const adopt = (n, edge, pet) => ({
  name: 'adopt',
  args: JSON.stringify({ messageNumber: n, edgeName: edge, petName: pet }),
});
const list = { name: 'list', args: '{}' };

// Package numbers: `mention` #1, `stall` #2, `w1` #3, `w2` #4.
const script = harden({
  turns: [
    {
      input: 'mention',
      rounds: [callRound([adopt(1, 'notes', 'n')]), closing],
    },
    { input: 'check', rounds: [callRound([list]), closing] },
    {
      input: 'stall',
      rounds: [{ chunks: [{ text: 'stalling' }], stall: 'untilCancel' }],
    },
    {
      input: 'w1',
      rounds: [callRound([adopt(2, 'a', 'a'), adopt(3, 'b', 'b')]), closing],
    },
    { input: 'w2', rounds: [callRound([list]), closing] },
    { input: 'go', rounds: [closing] },
  ],
});

/**
 * @param {any} slice
 * @param {any} session
 * @param {string} input
 * @param {any[]} attachments
 */
const send = (slice, session, input, attachments) =>
  E(slice.composer).submit(
    session,
    input,
    requestId(),
    harden({ attachments }),
  );

/**
 * The session's turns in order, with their first record and tool results.
 * @param {any} session
 */
const turnsOf = async session => {
  /** @type {any[]} */
  const turns = [];
  let page = await E(session).getHistoryPage();
  for (;;) {
    turns.push(...page.turns);
    if (page.next === undefined) break;
    // eslint-disable-next-line no-await-in-loop
    page = await E(session).getHistoryPage(page.next);
  }
  return turns
    .map(tp => ({
      n: Number(tp.turnId.slice(1)),
      turnId: tp.turnId,
      state: tp.state,
      started: tp.records[0],
      results: tp.records
        .filter((/** @type {any} */ r) => r.kind === 'tool-result')
        .map((/** @type {any} */ r) => [r.result, r.failed]),
    }))
    .sort((a, b) => a.n - b.n);
};

/**
 * @param {any} session
 * @param {number} count
 */
const settled = (session, count) =>
  waitFor(
    async () => {
      const turns = await turnsOf(session);
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
  '11a: K3 after an adopt, K6 with a claimed package and two waiting',
  async t => {
    t.timeout(4 * 60_000);
    const template = await sliceTemplate();
    const state = await startFromTemplate(template, { t });
    const slice = await makeSlice(state);
    const made = await slice.makeBackend(script);
    const objects = [];
    for (const label of ['notes', 'a', 'b', 'c']) {
      // eslint-disable-next-line no-await-in-loop
      const { backend } = await slice.makeBackend(harden({ turns: [] }));
      objects.push({ label, value: backend });
    }
    const [notes, a, b, c] = objects;
    let session = await slice.createSession(
      made.backend,
      'm5 mentions restart',
    );
    const { key } = await E(session).getInfo();
    const live = await slice.subscribe(session);

    // ---- K3: SIGKILL right after the adopting turn
    await send(slice, session, 'mention', [notes]);
    await settled(session, 1);
    await live.stop();
    const t0 = performance.now();
    await state.kill();
    await killStrays(state.root);
    const first = await state.restart();
    await slice.refresh();
    session = await E(slice.factory).findSession(key);
    let live2 = await slice.subscribe(session);
    const check = await runTurn(slice, session, live2, 'check');
    t.is(check.end.status, 'completed');
    const checkResults = (await turnRecords(check.turn)).filter(
      r => r.kind === 'tool-result',
    );
    t.deepEqual(
      checkResults.map(r => r.result),
      [JSON.stringify(['n'], null, 2)],
    );
    let turns = await turnsOf(session);
    t.deepEqual(turns[0].results, [[textOf.adopted('notes', 1, 'n'), false]]);
    emit({
      metric: 'm5.mentions.restart.k3',
      restartMs: round1(performance.now() - t0),
      ...first,
    });

    // ---- K6: a claimed turn with package #2, two entries with attachments
    const stalled = await send(slice, session, 'stall', [a]);
    t.is(stalled.state, 'started');
    const w1 = await send(slice, session, 'w1', [b]);
    const w2 = await send(slice, session, 'w2', [c]);
    t.is(w1.state, 'queued');
    t.is(w2.state, 'queued');
    await live2.stop();
    await state.kill();
    await killStrays(state.root);
    await state.restart();
    await slice.refresh();
    session = await E(slice.factory).findSession(key);
    const held = await E(session).listPending();
    t.deepEqual(
      held.entries.map((/** @type {any} */ e) => e.preview),
      ['w1', 'w2'],
    );
    t.deepEqual(held.hold, { reason: 'restart', message: texts.holdRestart });
    live2 = await slice.subscribe(session);
    // A new message releases the restart hold; it queues behind the held
    // two, so its receipt carries no turn yet (as in m2-queue.test.js).
    await slice.submit(session, 'go');
    turns = await settled(session, 6);
    t.is(turns[5].state, 'completed');
    t.deepEqual(
      turns.map(tp => tp.started.input),
      ['mention', 'check', 'stall', 'w1', 'w2', 'go'],
    );
    t.true(['interrupted', 'outcome-unknown'].includes(turns[2].state));
    t.deepEqual(turns[2].started.attachments, ['a']);
    t.deepEqual(turns[3].started.attachments, ['b']);
    t.deepEqual(turns[4].started.attachments, ['c']);
    t.false('attachments' in turns[5].started);
    t.deepEqual(turns[3].results, [
      [textOf.errorResult(textOf.noPackage(2)), true],
      [textOf.adopted('b', 3, 'b'), false],
    ]);
    t.deepEqual(turns[4].results, [
      [JSON.stringify(['b', 'n'], null, 2), false],
    ]);

    // Each held entry ran with its own line (scripted `context` digests).
    const contexts = made.log().filter(l => l.kind === 'context');
    /** @param {string} turnId */
    const bytesOf = turnId =>
      contexts.filter(l => l.turnId === turnId).map(l => l.systemBytes);
    const [plain] = bytesOf(turns[5].turnId);
    for (const [i, n, label] of /** @type {const} */ ([
      [3, 3, 'b'],
      [4, 4, 'c'],
    ])) {
      const line = textOf.mentionLine(n, [label]);
      for (const bytes of bytesOf(turns[i].turnId)) {
        t.is(bytes, plain + 2 + Buffer.byteLength(line));
      }
    }
    emit({
      metric: 'm5.mentions.restart.k6',
      ...(await runIdentity()),
      loadAvg: loadAvg(),
    });
    await live2.stop();
  },
);
