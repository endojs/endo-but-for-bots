// @ts-check
/**
 * M5 acceptance 3, local part (W5.3; designs/m5-interfaces.md 8.1 item 3,
 * 2.4, section 5 kill point K3), and the heaviest-crank check of 2.9, in a
 * real daemon on the m1b template:
 *
 * - `store` a value, SIGKILL right after the turn, restart: `lookup` finds
 *   the value, `list` shows it; `remove` discards it; an unheld label
 *   answers `textOf.unknownLabel`; an unknown argument key answers the
 *   R3-26 text;
 * - the M1b QC shape with `store`: one round of 256 `store` calls settles
 *   (64 run, the rest get the too-many-calls text) and no vat halts at the
 *   template's slot ceiling;
 * - 256 labels held, the 257th `store` is refused (`labelsFull`);
 * - a value over `labelValueBytes` (its arguments over `inlineBytes`, so
 *   staged) is refused with `textOf.argumentsTooLarge`.
 *
 * Rendering an endowed or adopted object (`[remote capability] ...`) is
 * W5.5's part of acceptance 3 (`m5-objects.test.js`).
 *
 *   THIX_AGENT=W5.3 corepack yarn test:integration test/integration/m5-labels.test.js
 */
/* eslint-disable no-await-in-loop -- steps of one scenario run in order */
import '../unit/_m1a-prelude.js';

import { performance } from 'node:perf_hooks';

import test from 'ava';

import { E } from '@endo/far';

/* eslint-disable import/no-relative-packages */
import { textOf } from '../../guest/lib/interfaces.js';
import { textOf as textOfM5 } from '../../guest/lib/interfaces-m5.js';
import { limits } from '../../guest/lib/limits.js';
import { limitsM5 } from '../../guest/lib/limits-m5.js';
/* eslint-enable import/no-relative-packages */
import {
  crankBudget,
  emit,
  loadAvg,
  runIdentity,
} from '../../perf/_harness.mjs';
import {
  integrationEnabled,
  killStrays,
  startFromTemplate,
  takeIntegrationLock,
} from '../template/index.js';
import { makeSlice, round1 } from './_m1a-slice.js';
import { execTemplate } from './_m1b-exec.js';
import { runTurn, turnRecords } from './_m1b.js';

takeIntegrationLock(test, 'm5 labels test');

const run = integrationEnabled ? test.serial : test.skip;

const usage = {
  inputTokens: 10,
  outputTokens: 5,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  reasoningOutputTokens: 0,
};

/** @param {{ name: string, args: string, times?: number }[]} toolCalls */
const callRound = toolCalls => ({
  chunks: [{ text: 'tools' }],
  toolCalls,
  usage,
});
const closing = { chunks: [{ text: 'done' }], usage };

/**
 * `store` calls for labels `f<from>` .. `f<from + count - 1>`.
 * @param {number} from
 * @param {number} count
 */
const stores = (from, count) =>
  Array.from({ length: count }, (_, i) => ({
    name: 'store',
    args: `{"value":${from + i},"petName":"f${from + i}"}`,
  }));

const CALLS = limits.maxCallsPerMessage;

const script = harden({
  turns: [
    {
      input: 'store',
      rounds: [
        callRound([
          { name: 'store', args: '{"value":{"a":[1,2]},"petName":"x"}' },
        ]),
        closing,
      ],
    },
    {
      input: 'read',
      rounds: [
        callRound([
          { name: 'lookup', args: '{"petName":"x"}' },
          { name: 'list', args: '{}' },
          { name: 'lookup', args: '{"petName":"nope"}' },
          { name: 'lookup', args: '{"petName":"x","method":"m"}' },
          { name: 'remove', args: '{"petName":"x"}' },
        ]),
        callRound([{ name: 'lookup', args: '{"petName":"x"}' }]),
        closing,
      ],
    },
    {
      input: 'qc',
      rounds: [
        callRound([
          { name: 'store', args: '{"value":1,"petName":"q"}', times: CALLS },
        ]),
        closing,
      ],
    },
    {
      // 1 label held ("q"): 255 more fill the map, then one is refused.
      input: 'fill',
      rounds: [
        callRound(stores(0, 64)),
        callRound(stores(64, 64)),
        callRound(stores(128, 64)),
        callRound(stores(192, 63)),
        callRound([{ name: 'store', args: '{"value":0,"petName":"over"}' }]),
        closing,
      ],
    },
  ],
});

/** The arguments of a `store` whose value is `labelValueBytes + 1` bytes. */
const bigStore = JSON.stringify({
  value: 'v'.repeat(limitsM5.labelValueBytes - 1),
  petName: 'big',
});
const bigScript = harden({
  turns: [
    {
      input: 'big',
      rounds: [callRound([{ name: 'store', args: bigStore }]), closing],
    },
  ],
});

/**
 * The tool results of a turn, in call order.
 * @param {any} turn
 */
const resultsOf = async turn =>
  (await turnRecords(turn)).filter(r => r.kind === 'tool-result');

run(
  'acceptance 3 (local), K3, the 256-call store round, the label bound',
  async t => {
    t.timeout(4 * 60_000);
    const template = await execTemplate();
    const state = await startFromTemplate(template, { t });
    const slice = await makeSlice(state);
    const identity = {
      ...(await runIdentity()),
      crankBudget,
      loadAvg: loadAvg(),
    };
    const made = await slice.makeBackend(script);
    let session = await slice.createSession(made.backend, 'm5 labels');
    const { key } = await E(session).getInfo();
    let live = await slice.subscribe(session);

    // ---- store, then SIGKILL right after the turn (K3)
    const stored = await runTurn(slice, session, live, 'store');
    t.is(stored.end.status, 'completed');
    t.deepEqual(
      (await resultsOf(stored.turn)).map(r => r.result),
      [textOfM5.stored('x')],
    );
    await live.stop();
    await state.kill();
    await killStrays(state.root);
    const restarted = await state.restart();
    await slice.refresh();
    session = await E(slice.factory).findSession(key);
    live = await slice.subscribe(session);

    // ---- lookup after the restart, list, unknown label, R3-26, remove
    const read = await runTurn(slice, session, live, 'read');
    t.is(read.end.status, 'completed');
    t.deepEqual(
      (await resultsOf(read.turn)).map(r => [r.result, r.failed]),
      [
        ['{"a":[1,2]}', false],
        [JSON.stringify(['x'], null, 2), false],
        [textOf.errorResult(textOfM5.unknownLabel('nope')), true],
        [
          textOf.errorResult(
            textOf.unexpectedArgument('method', 'lookup', ['petName']),
          ),
          true,
        ],
        [textOfM5.removed('x'), false],
        [textOf.errorResult(textOfM5.unknownLabel('x')), true],
      ],
    );
    emit({
      metric: 'm5.labels.restart',
      servedMs: restarted.servedMs,
      ...identity,
    });

    // ---- the M1b QC shape with store: 256 calls in one round
    const t0 = performance.now();
    const qc = await runTurn(slice, session, live, 'qc', 180_000);
    const qcMs = round1(performance.now() - t0);
    t.is(qc.end.status, 'completed');
    const qcResults = await resultsOf(qc.turn);
    t.is(qcResults.length, CALLS);
    const tooMany = textOf.tooManyCalls(CALLS, limits.maxCallsPerRound);
    t.is(qcResults.filter(r => r.result === tooMany).length, CALLS - 64);
    // Refusals are recorded when the intents are; results in completion order.
    t.is(qcResults.filter(r => r.result === textOfM5.stored('q')).length, 1);
    t.is(
      qcResults.filter(
        r => r.result === textOf.errorResult(textOfM5.labelTaken('q')),
      ).length,
      limits.maxCallsPerRound - 1,
    );
    const failed = (await slice.workers()).filter(w => w.failure);
    t.deepEqual(
      failed.map(w => w.debugLabel),
      [],
      'no vat halted',
    );
    emit({
      metric: 'm5.qc.round256.store',
      turnMs: qcMs,
      calls: CALLS,
      ...identity,
    });

    // ---- 256 labels, then the 257th is refused
    const fill = await runTurn(slice, session, live, 'fill', 120_000);
    t.is(fill.end.status, 'completed');
    const fillResults = await resultsOf(fill.turn);
    t.is(fillResults.length, 256);
    t.is(fillResults.filter(r => r.failed).length, 1);
    t.deepEqual(
      fillResults.filter(r => r.failed).map(r => r.result),
      [textOf.errorResult(textOfM5.labelsFull(limitsM5.maxLabels))],
    );

    // ---- a value over labelValueBytes: staged arguments, refused
    const bigBackend = await slice.makeBackend(bigScript);
    const other = await slice.createSession(bigBackend.backend, 'm5 big');
    const otherLive = await slice.subscribe(other);
    const big = await runTurn(slice, other, otherLive, 'big');
    t.is(big.end.status, 'completed');
    const [bigResult] = await resultsOf(big.turn);
    t.true(bigResult.failed);
    t.is(
      bigResult.result,
      textOf.errorResult(
        textOfM5.argumentsTooLarge(
          'store',
          Buffer.byteLength(bigStore),
          limits.inlineBytes,
        ),
      ),
    );
    await otherLive.stop();
    await live.stop();
  },
);
