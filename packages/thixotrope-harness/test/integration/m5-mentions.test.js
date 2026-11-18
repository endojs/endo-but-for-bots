// @ts-check
/**
 * M5 acceptance 7, mentions (W5.7; designs/m5-interfaces.md 8.1 item 7,
 * 2.6; P-40, R3-8, R4-29, R4-99), in a real daemon on the m1a slice
 * template:
 *
 * - a submission with two attachments through the Composer: every round of
 *   that turn carries the R4-29 line (the scripted `context` line's system
 *   digest is the stored prompt and the line joined), the next turn's do
 *   not; `TurnStarted.attachments` holds the labels;
 * - the model `adopt`s one; `list` shows it next turn; `adopt` of the other
 *   after the turn answers `textOf.noPackage`;
 * - 33 attachments are refused by the Composer's guard and nothing runs.
 *
 * `adoptTool` of a fixture tool in a daemon is not here (it needs W5.5's
 * fixture template and W5.6's grants in one daemon; the unit file
 * `m5-w57-packages.test.js` covers it with a fake grants part).
 *
 *   THIX_AGENT=W5.7 corepack yarn test:integration test/integration/m5-mentions.test.js
 */
import '../unit/_m1a-prelude.js';

import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import test from 'ava';

import { E } from '@endo/far';

/* eslint-disable import/no-relative-packages */
import { textOf } from '../../guest/lib/interfaces.js';
/* eslint-enable import/no-relative-packages */
import { emit, loadAvg, runIdentity } from '../../perf/_harness.mjs';
import {
  integrationEnabled,
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

takeIntegrationLock(test, 'm5 mentions test');

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

const script = harden({
  turns: [
    {
      input: 'mention',
      rounds: [callRound([adopt(1, 'notes', 'n')]), closing],
    },
    {
      input: 'after',
      rounds: [
        callRound([adopt(1, 'calc', 'c'), { name: 'list', args: '{}' }]),
        closing,
      ],
    },
  ],
});

/** @param {string} text */
const digestOf = text =>
  createHash('sha256').update(text).digest('hex').slice(0, 16);

/**
 * Submit with attachments through the Composer and wait for the turn's end.
 * @param {any} slice
 * @param {any} session
 * @param {any} live
 * @param {string} input
 * @param {any[]} attachments
 */
const runMention = async (slice, session, live, input, attachments) => {
  const from = /** @type {number} */ (live.deliveries.length);
  const t0 = performance.now();
  const receipt = await E(slice.composer).submit(
    session,
    input,
    requestId(),
    harden({ attachments }),
  );
  const submitMs = round1(performance.now() - t0);
  const { turnId } = await E(receipt.turn).getStatus();
  await waitFor(
    () =>
      live.deliveries.find(
        (/** @type {any} */ d, /** @type {number} */ i) =>
          i >= from &&
          (d.event.type === 'end' || d.event.type === 'abort') &&
          d.event.turnId === turnId,
      ),
    60_000,
    `turn ${input}: end`,
    10,
  );
  return { turn: receipt.turn, turnId, submitMs };
};

/**
 * Tool results of a turn: [result, failed].
 * @param {any} turn
 */
const resultsOf = async turn =>
  (await turnRecords(turn))
    .filter(r => r.kind === 'tool-result')
    .map(r => [r.result, r.failed]);

run('acceptance 7: mentions through the Composer', async t => {
  t.timeout(4 * 60_000);
  const template = await sliceTemplate();
  const state = await startFromTemplate(template, { t });
  const slice = await makeSlice(state);
  const made = await slice.makeBackend(script);
  // Two daemon objects to attach (any remotable the session may hold).
  const notes = (await slice.makeBackend(harden({ turns: [] }))).backend;
  const calc = (await slice.makeBackend(harden({ turns: [] }))).backend;
  const session = await slice.createSession(made.backend, 'm5 mentions');
  const live = await slice.subscribe(session);

  const first = await runMention(slice, session, live, 'mention', [
    { label: 'notes', value: notes },
    { label: 'calc', value: calc },
  ]);
  const records = await turnRecords(first.turn);
  t.deepEqual(records[0].attachments, ['notes', 'calc']);
  t.deepEqual(await resultsOf(first.turn), [
    [textOf.adopted('notes', 1, 'n'), false],
  ]);

  const second = await runTurn(slice, session, live, 'after');
  t.is(second.end.status, 'completed');
  t.deepEqual(await resultsOf(second.turn), [
    [textOf.errorResult(textOf.noPackage(1)), true],
    [JSON.stringify(['n'], null, 2), false],
  ]);
  const secondRecords = await turnRecords(second.turn);
  t.false('attachments' in secondRecords[0]);

  // The R4-29 line: on both rounds of the first turn, on none of the next.
  const contexts = made.log().filter(l => l.kind === 'context');
  /** @param {string} turnId */
  const systemsOf = turnId =>
    contexts
      .filter(l => l.turnId === turnId)
      .map(l => [l.round, l.systemBytes, l.systemDigest]);
  const firstSystems = systemsOf(first.turnId);
  const plainSystems = systemsOf(second.turnId);
  t.deepEqual(
    firstSystems.map(s => s[0]),
    [0, 1],
  );
  t.deepEqual(
    plainSystems.map(s => s[0]),
    [0, 1],
  );
  const line = textOf.mentionLine(1, ['notes', 'calc']);
  const [, plainBytes] = plainSystems[0];
  t.true(plainSystems.every(s => s[2] === plainSystems[0][2]));
  for (const [, bytes, digest] of firstSystems) {
    t.is(bytes, plainBytes + 2 + Buffer.byteLength(line));
    t.not(digest, plainSystems[0][2]);
  }
  t.true(firstSystems.every(s => s[2] === firstSystems[0][2]));

  // 33 attachments: refused by the Composer's guard; nothing runs.
  const many = Array.from({ length: 33 }, (_, i) => ({
    label: `a${i}`,
    value: notes,
  }));
  await t.throwsAsync(() =>
    E(slice.composer).submit(
      session,
      'too many',
      requestId(),
      harden({ attachments: many }),
    ),
  );
  t.deepEqual((await E(session).listPending()).entries, []);
  t.is((await E(session).getCurrentTurn()) ?? undefined, undefined);

  emit({
    metric: 'm5.mentions.acceptance7',
    submitMs: first.submitMs,
    lineDigest: digestOf(line),
    ...(await runIdentity()),
    loadAvg: loadAvg(),
  });
  await live.stop();
});
