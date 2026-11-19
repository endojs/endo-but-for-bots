// @ts-check
/**
 * Compaction end to end through the daemon (`designs/m8-interfaces.md` 12;
 * P-36; R4-33..R4-36, R4-100), from the m1a state template (the real
 * session program in a vat) with an Anthropic API backend on the fake
 * provider server and a scripted backend:
 *
 * 1. "crossing 70 % compacts": a turn whose previous request read 150,000
 *    of the 200,000-token window asks; the adapter's summary call carries
 *    the R4-36 instruction and no tools; a `compaction` record holds the
 *    summary with every R4-36 heading; the round's request, and the next
 *    turn's, start with the summary as an assistant message, then the
 *    retained tail. The scripted version uses the forced small window of
 *    the contract (a scripted reading of 80 of 100): the `context` line of
 *    the compacted round starts with the summary message.
 * 7. "usage": the summary call's tokens are charged to the turn and the
 *    session; the context reading after it is the real round's.
 * 8. The phases `compacting context` then `thinking`, in order, on the live
 *    channel.
 * 15. "window": a new Anthropic API session reports a 200,000-token window
 *    in `getUsage().context` after a round.
 * 17. "skipped": a plan whose summary cannot reduce records
 *    `compaction-skipped` with its fixed reason and the turn completes
 *    uncompacted, with no second ask in that turn.
 *
 * The kill points are `compaction-restart.test.js`. Runs only with
 * THIX_HARNESS_INTEGRATION=1, under the run lock:
 *
 *   corepack yarn test:integration test/integration/compaction.test.js
 */
import '../unit/_m1a-prelude.js';

import { createHash } from 'node:crypto';

import test from 'ava';

import { E } from '@endo/far';

/* eslint-disable import/no-relative-packages */
import { compactionTexts } from '../../guest/lib/guards/session.js';
/* eslint-enable import/no-relative-packages */
import {
  compactionSkipTexts,
  scriptedSummary,
  summaryHeadings,
} from '../../resources/agent-host/impl/providers/compaction.js';
import { integrationEnabled, takeIntegrationLock } from '../template/index.js';
import {
  ANTHROPIC_WINDOW,
  OVER_THRESHOLD,
  anthropicSession,
  contentOf,
  filler,
  modelRequestCount,
  modelRequests,
  openCompactionState,
  reply,
  runTurn,
} from './_compaction.js';

takeIntegrationLock(test, 'compaction test');

const run = integrationEnabled ? test.serial : test.skip;

/** A summary the fake model answers: every R4-36 heading, a fact each. */
const SUMMARY = summaryHeadings
  .map(heading => `${heading}\n- kept fact under ${heading.slice(3)}`)
  .join('\n');

/** @type {Awaited<ReturnType<typeof openCompactionState>> | undefined} */
let shared;
/** One served state for the file's tests. */
const open = async () => {
  shared ??= await openCompactionState();
  return shared;
};
test.after.always(() => shared?.cleanup());

/** @param {any} content an Anthropic message's content */
const textOf = content =>
  typeof content === 'string'
    ? content
    : content
        .filter((/** @type {any} */ c) => c.type === 'text')
        .map((/** @type {any} */ c) => c.text)
        .join('');

/** @param {string} text */
const sha16 = text =>
  createHash('sha256').update(text).digest('hex').slice(0, 16);

run(
  '1, 7, 8, 15, 17: crossing 70 % compacts on the Anthropic API; usage, phases, window; a plan that cannot reduce skips',
  async t => {
    t.timeout(4 * 60_000);
    const { slice, server, anthropic } = await open();
    const { session, live } = await anthropicSession(slice, anthropic);
    t.teardown(() => live.stop());

    // Two long turns; the second reads 150,000 of 200,000 tokens.
    server.push(reply(filler('one', 8000), { input: 1000 }));
    await runTurn(slice, session, live, 'first');
    // ---- 15: the window the catalogue gave the session at creation.
    const afterFirst = await E(session).getUsage();
    t.is(afterFirst.context.windowTokens, ANTHROPIC_WINDOW);
    t.is(afterFirst.context.usedTokens, 1050);
    server.push(
      reply(filler('two', 8000), { input: OVER_THRESHOLD, output: 100 }),
    );
    await runTurn(slice, session, live, 'second');
    const before = await E(session).getUsage();
    t.is(before.context.usedTokens, OVER_THRESHOLD + 100);

    // ---- 1: the third turn compacts before its round 0.
    const from = modelRequestCount(server);
    server.push(
      reply(SUMMARY, { input: 3000, output: 400 }),
      reply('third answer', { input: 2000, output: 10 }),
    );
    const third = await runTurn(slice, session, live, 'third');
    const asked = modelRequests(server, from);
    t.is(asked.length, 2, 'one summary call, then the round');
    t.true(asked[0].summary, 'the summary call carries the instruction');
    t.is(asked[0].tools, 0, 'the summary call offers no tools');
    for (const heading of summaryHeadings)
      t.true(asked[0].text.includes(heading));
    t.true(asked[0].text.includes('first'), 'the history holds turn 1');
    t.false(asked[1].summary);
    t.is(asked[1].role, 'assistant', 'the round starts with the summary');
    t.is(asked[1].text, SUMMARY);
    t.deepEqual(
      asked[1].messages.slice(1).map((/** @type {any} */ m) => m.role),
      ['user'],
      'then the retained tail: the turn input',
    );
    t.is(textOf(asked[1].messages[1].content), 'third');
    t.false(
      JSON.stringify(asked[1].messages).includes('two: lorem'),
      'turn 2 is summarized, not sent',
    );

    const records = await contentOf(third.turn);
    const started = records.filter(r => r.kind === 'compaction-started');
    const compactions = records.filter(r => r.kind === 'compaction');
    t.is(started.length, 1);
    t.like(started[0], {
      epoch: 1,
      boundary: 0,
      usedTokens: OVER_THRESHOLD + 100,
      windowTokens: ANTHROPIC_WINDOW,
    });
    t.is(compactions.length, 1);
    t.is(compactions[0].epoch, 1);
    t.true(Number(compactions[0].boundary) > 0);
    t.is(compactions[0].summary, SUMMARY);
    for (const heading of summaryHeadings)
      t.true(compactions[0].summary.includes(heading));
    t.is(records.at(-1).kind, 'turn-settled');
    t.is(records.at(-1).status, 'completed');

    // ---- 8: the phases, in order.
    /** @type {string[]} */
    const phases = third
      .events()
      .filter((/** @type {any} */ e) => e.type === 'phase')
      .map((/** @type {any} */ e) => e.phase);
    const compacting = phases.indexOf(compactionTexts.phase);
    t.true(compacting > -1, `phases ${phases.join(', ')}`);
    t.is(phases[compacting + 1], 'thinking');

    // ---- 7: summary tokens charged to the session; the reading is the
    // real round's.
    const after = await E(session).getUsage();
    t.is(after.inputTokens - before.inputTokens, 3000 + 2000);
    t.is(after.outputTokens - before.outputTokens, 400 + 10);
    t.deepEqual(after.context, {
      usedTokens: 2010,
      windowTokens: ANTHROPIC_WINDOW,
    });

    // Later turns start from the summary; no ask under the threshold.
    const fourthFrom = modelRequestCount(server);
    server.push(reply('fourth answer', { input: 2100 }));
    await runTurn(slice, session, live, 'fourth');
    const fourth = modelRequests(server, fourthFrom);
    t.is(fourth.length, 1);
    t.is(fourth[0].text, SUMMARY);
    t.deepEqual(
      fourth[0].messages.map((/** @type {any} */ m) => m.role),
      ['assistant', 'user', 'assistant', 'user'],
    );

    // ---- 17: the summary the model answers is longer than the history it
    // replaces: the checks refuse it, the round runs uncompacted.
    const small = await anthropicSession(slice, anthropic, 'skipped');
    t.teardown(() => small.live.stop());
    server.push(reply(filler('brief', 4000), { input: OVER_THRESHOLD }));
    await runTurn(slice, small.session, small.live, 'brief');
    const skipFrom = modelRequestCount(server);
    server.push(
      reply(`${SUMMARY}\n${filler('long summary', 12_000)}`, {
        input: 300,
        output: 40,
      }),
      reply('fine', { input: OVER_THRESHOLD }),
    );
    const next = await runTurn(slice, small.session, small.live, 'brief next');
    const skipRecords = await contentOf(next.turn);
    const skipped = skipRecords.filter(r => r.kind === 'compaction-skipped');
    t.is(skipped.length, 1, `records ${skipRecords.map(r => r.kind)}`);
    t.is(skipped[0].reason, compactionSkipTexts.noReduction);
    const skipAsked = modelRequests(server, skipFrom);
    t.deepEqual(
      skipAsked.map(r => r.summary),
      [true, false],
      'one summary call, one uncompacted round',
    );
    t.is(skipAsked[1].role, 'user');
    t.is(skipAsked[1].text, 'brief');
    t.false(skipRecords.some(r => r.kind === 'compaction'));
    t.is(skipRecords.at(-1).status, 'completed');
  },
);

run(
  '1 (scripted): a forced small window of 100 tokens compacts with the scripted summary',
  async t => {
    t.timeout(3 * 60_000);
    const { slice } = await open();
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
    const made = await slice.makeBackend(
      harden({
        turns: [
          {
            input: 'big one',
            rounds: [
              { chunks: [{ text: filler('one', 6000) }], usage: usage(30) },
            ],
          },
          {
            input: 'big two',
            rounds: [
              { chunks: [{ text: filler('two', 6000) }], usage: usage(80) },
            ],
          },
          {
            rounds: [{ chunks: [{ text: 'short' }], usage: usage(20) }],
          },
        ],
      }),
    );
    const session = await slice.createSession(made.backend, 'scripted');
    const live = await slice.subscribe(session);
    t.teardown(() => live.stop());
    await runTurn(slice, session, live, 'big one');
    await runTurn(slice, session, live, 'big two');
    const third = await runTurn(slice, session, live, 'after');
    const records = await contentOf(third.turn);
    const compaction = records.find(r => r.kind === 'compaction');
    t.truthy(compaction, `records ${records.map(r => r.kind).join(', ')}`);
    t.is(compaction.summary, scriptedSummary);
    const contexts = made
      .log()
      .filter(l => l.kind === 'context' && l.turnId === third.turnId);
    t.is(contexts.length, 1, 'one context line for the compacted round');
    const summaryDigest = sha16(
      JSON.stringify({
        kind: 'message',
        role: 'assistant',
        content: scriptedSummary,
      }),
    );
    t.is(contexts[0].turnDigests.split(' ')[0], summaryDigest);
    t.is(contexts[0].turnDigests.split(' ').length, 2, 'summary, then turn 3');
    // A later turn starts from the summary too.
    const fourth = await runTurn(slice, session, live, 'later');
    const later = made
      .log()
      .find(l => l.kind === 'context' && l.turnId === fourth.turnId);
    t.is(later.turnDigests.split(' ')[0], summaryDigest);
    t.false(
      (await contentOf(fourth.turn)).some(r => r.kind === 'compaction-started'),
      'no ask under the threshold',
    );
  },
);
