// @ts-check
/**
 * M1b QC regressions in a real daemon (JOURNAL J-0390..J-0393), on the m1b
 * template, through public objects:
 *
 * - The largest round a provider may send, `maxCallsPerMessage` (256) echo
 *   calls, and as many calls to an unknown tool: the session vat does not
 *   halt (J-0362 halted at 100 with HeapExhausted at the old slot ceiling);
 *   64 run, the rest get the too-many-calls text; the session goes on.
 * - An exec body that builds 60,000 fresh keys: the exec vat answers
 *   `exhausted` and the session retires it (`texts.execExhausted`); the next
 *   exec runs on a fresh scope at the usual speed (J-0333, J-0390).
 * - Model code that starts a perpetual loop of sleeps and returns at once:
 *   the call ends `ok`, and the exec vat stops cranking (a sleep asked for
 *   after the call is dead), J-0391.
 *
 *   THIX_HARNESS_INTEGRATION=1 node scripts/run-lock.mjs --label m1b-qc -- \
 *     corepack yarn test test/integration/m1b-qc.test.js
 */
/* eslint-disable no-await-in-loop -- steps of one scenario run in order */
import '../unit/_m1a-prelude.js';

import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';

import test from 'ava';

import { E } from '@endo/far';

/* eslint-disable import/no-relative-packages */
import { texts, textOf } from '../../guest/lib/interfaces.js';
import { limits } from '../../guest/lib/limits.js';
/* eslint-enable import/no-relative-packages */
import {
  crankBudget,
  emit,
  loadAvg,
  runIdentity,
} from '../../perf/_harness.mjs';
import {
  integrationEnabled,
  startFromTemplate,
  takeIntegrationLock,
} from '../template/index.js';
import { makeSlice, round1, waitFor } from './_m1a-slice.js';
import { execTemplate, isExecVat } from './_m1b-exec.js';
import { runTurn, turnRecords } from './_m1b.js';

takeIntegrationLock(test, 'm1b qc test');

const run = integrationEnabled ? test.serial : test.skip;

const usage = {
  inputTokens: 10,
  outputTokens: 5,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  reasoningOutputTokens: 0,
};

const CALLS = limits.maxCallsPerMessage;

const KEYS_CODE = [
  'const o = {};',
  "for (let i = 0; i < 60000; i += 1) o['qcfresh' + i] = i;",
  'return Object.keys(o).length;',
].join('\n');

const LOOP_CODE = [
  'globalThis.ticks = 0;',
  '(async () => {',
  '  for (;;) {',
  '    for (let i = 0; i < 50; i += 1) sleep(600000);',
  '    await sleep(0);',
  '    globalThis.ticks += 1;',
  '  }',
  '})();',
  'return 1;',
].join('\n');

/** @param {string} code */
const execRound = code => ({
  chunks: [{ text: 'exec' }],
  toolCalls: [{ name: 'exec', args: JSON.stringify({ code }) }],
  usage,
});

const script = harden({
  turns: [
    {
      input: 'echo256',
      rounds: [
        {
          chunks: [{ text: 'many calls' }],
          toolCalls: [
            { name: 'echo', args: JSON.stringify({ text: 'e' }), times: CALLS },
          ],
          usage,
        },
        { chunks: [{ text: 'after the calls' }], usage },
      ],
    },
    {
      input: 'unknown256',
      rounds: [
        {
          chunks: [{ text: 'unknown calls' }],
          toolCalls: [{ name: 'nosuchtool', args: '{}', times: CALLS }],
          usage,
        },
        { chunks: [{ text: 'after the unknown calls' }], usage },
      ],
    },
    {
      input: 'keys',
      rounds: [execRound(KEYS_CODE), { chunks: [{ text: 'k' }], usage }],
    },
    {
      input: 'ticks',
      rounds: [
        execRound("return typeof ticks === 'undefined' ? -1 : ticks;"),
        { chunks: [{ text: 't' }], usage },
      ],
    },
    {
      input: 'loop',
      rounds: [execRound(LOOP_CODE), { chunks: [{ text: 'l' }], usage }],
    },
    {
      input: 'trivial',
      rounds: [execRound('return 1;'), { chunks: [{ text: 'x' }], usage }],
    },
    { rounds: [{ chunks: [{ text: 'hello' }], usage }] },
  ],
});

/**
 * The text of a turn's one tool result.
 * @param {any} turn
 */
const resultOf = async turn => {
  const records = await turnRecords(turn);
  return records.find(r => r.kind === 'tool-result')?.result;
};

run(
  'M1b QC: big rounds, a key flood and a perpetual loop in real vats',
  async t => {
    t.timeout(5 * 60_000);
    const template = await execTemplate();
    const state = await startFromTemplate(template, { t });
    const slice = await makeSlice(state);
    const made = await slice.makeBackend(script);
    const session = await slice.createSession(made.backend, 'qc');
    const live = await slice.subscribe(session);
    t.teardown(() => live.stop());
    const identity = {
      ...(await runIdentity()),
      crankBudget,
      loadAvg: loadAvg(),
    };

    // ---- 256 echo calls: no halt, 64 run, the rest are refused
    for (const [input, name] of [
      ['echo256', 'echo'],
      ['unknown256', 'nosuchtool'],
    ]) {
      const t0 = performance.now();
      const r = await runTurn(slice, session, live, input, 180_000);
      const turnMs = round1(performance.now() - t0);
      t.is(r.end.status, 'completed', `${input}: the turn completed`);
      const records = await turnRecords(r.turn);
      const intents = records
        .filter(x => x.kind === 'tool-intents')
        .flatMap(x => x.intents);
      const results = records.filter(x => x.kind === 'tool-result');
      t.is(intents.length, CALLS, `${input}: every call is an intent`);
      t.is(results.length, CALLS, `${input}: every call has a result`);
      const tooMany = textOf.tooManyCalls(CALLS, limits.maxCallsPerRound);
      t.is(
        results.filter(x => x.result === tooMany).length,
        CALLS - limits.maxCallsPerRound,
        `${input}: the calls after the first 64 got the too-many-calls text`,
      );
      if (name === 'echo') {
        const started = made
          .log()
          .filter(
            l => l.kind === 'echo-start' && l.opId.startsWith(`${r.turnId}/`),
          );
        t.is(started.length, limits.maxCallsPerRound, 'echo ran 64 times');
      }
      emit({
        metric: `qc.round${CALLS}.${name}`,
        turnMs,
        calls: CALLS,
        ...identity,
      });
    }
    const failedVats = (await slice.workers()).filter(w => w.failure);
    t.deepEqual(
      failedVats.map(w => w.debugLabel),
      [],
      'no vat halted',
    );

    // ---- the key flood: exhausted, retired, a fresh scope
    const execRowsBefore = (await slice.workers()).filter(isExecVat);
    const keys = await runTurn(slice, session, live, 'keys', 120_000);
    t.is(keys.end.status, 'completed');
    t.is(
      await resultOf(keys.turn),
      textOf.errorResult(texts.execExhausted),
      'the exec vat answered exhausted',
    );
    const retired = await waitFor(
      async () => {
        const workers = await slice.workers();
        const execRowsAfter = workers.filter(isExecVat);
        return execRowsBefore.filter(
          w => !execRowsAfter.some(a => a.workerId === w.workerId),
        ).length;
      },
      30_000,
      'a previous exec worker to retire',
      250,
    );
    t.true(retired >= 1, 'the exhausted exec vat was retired');
    const tTrivial = performance.now();
    const trivial = await runTurn(slice, session, live, 'trivial');
    const trivialTurnMs = round1(performance.now() - tTrivial);
    t.is(await resultOf(trivial.turn), '1');
    emit({
      metric: 'qc.keys60k',
      retired,
      nextTrivialTurnMs: trivialTurnMs,
      ...identity,
    });

    // ---- the perpetual loop: the call ends, the exec vat stops cranking
    const loop = await runTurn(slice, session, live, 'loop', 60_000);
    t.is(await resultOf(loop.turn), '1');
    await E(slice.harness).whenSettled();
    // Let the sleeps that were in flight when the call ended come back.
    await delay(1500);
    const cranksOf = async () =>
      (await slice.workers())
        .filter(isExecVat)
        .reduce((sum, w) => sum + Number(w.journalLength ?? 0), 0);
    const before = await cranksOf();
    await delay(5000);
    const after = await cranksOf();
    t.true(
      after - before <= 2,
      `exec vats cranked ${after - before} times in 5 s after the call returned`,
    );
    const ticks = await runTurn(slice, session, live, 'ticks');
    t.true(
      Number(await resultOf(ticks.turn)) <= 1,
      'the background loop took at most the step its sleep in flight resumed',
    );
    emit({
      metric: 'qc.execBackgroundLoop',
      execCranksIn5s: after - before,
      ...identity,
    });

    // The session still works.
    const last = await runTurn(slice, session, live, 'hello?');
    t.is(last.end.status, 'completed');
  },
);
