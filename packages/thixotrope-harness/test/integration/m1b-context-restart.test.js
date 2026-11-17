// @ts-check
/**
 * The context cache across a daemon restart, in real vats (M1b W1b.2;
 * milestones.md M1b acceptance 8 in part; `designs/m1b-interfaces.md` 9):
 * a session runs CONTEXT_TURNS turns (default 60) on a scripted backend
 * whose every round has a native context (always staged) and whose turns
 * include a staged 20 KB reply and an echo call; one more turn records the
 * context the fake provider received (its `context` log line). Then the
 * supervisor is SIGKILLed and restarted; the session was idle across the
 * restart, so its next claim goes to dead ports and its round 0 is sent
 * again to fresh ones (contract 7.1 case 3), whose empty cache rebuilds
 * from the session's ContextSource and the manager's `resolveBlobs`.
 *
 * Checks: the provider receives that turn once (one `request`, one
 * `context` line for it); the per-turn digests of every turn before it equal
 * those received before the restart, native contexts and the staged reply
 * included; its own input appears once. Measures `context.rebuild.vat`: the
 * `prepare()` time of that round 0 in the adapter (page cranks of the
 * session vat, manager resolves, file reads, projection), and the same
 * line's time for an in-step round before the restart.
 *
 *   THIX_HARNESS_INTEGRATION=1 node scripts/run-lock.mjs --label m1b-context -- \
 *     corepack yarn test test/integration/m1b-context-restart.test.js
 */
/* eslint-disable no-await-in-loop -- turns of one session run in order */
import '../unit/_m1a-prelude.js';

import { performance } from 'node:perf_hooks';

import test from 'ava';

import { E } from '@endo/far';

import {
  crankBudget,
  delta,
  emit,
  loadAvg,
  runIdentity,
} from '../../perf/_harness.mjs';
import { m1bTemplateOptions } from '../../scripts/provision-steps.js';
import {
  ensureTemplate,
  integrationEnabled,
  startFromTemplate,
  takeIntegrationLock,
} from '../template/index.js';
import { makeSlice, round1, waitFor } from './_m1a-slice.js';

takeIntegrationLock(test, 'm1b context restart test');

const run = integrationEnabled ? test.serial : test.skip;

const TURNS = Number(process.env.CONTEXT_TURNS ?? 60);

const usage = {
  inputTokens: 10,
  outputTokens: 5,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  reasoningOutputTokens: 0,
};

const script = harden({
  turns: [
    {
      input: 'big reply',
      rounds: [
        {
          chunks: [{ text: 'b'.repeat(1024), repeat: 20 }],
          nativeContext: 'native of the big reply',
          usage,
        },
      ],
    },
    {
      input: 'call echo',
      rounds: [
        {
          chunks: [{ text: 'calling' }],
          toolCalls: [{ name: 'echo', args: '{"text":"echoed"}' }],
          nativeContext: 'native before the call',
          usage,
        },
        {
          chunks: [{ text: 'echo done' }],
          nativeContext: 'native after the call',
          usage,
        },
      ],
    },
    {
      rounds: [
        {
          chunks: [{ text: 'a reply of some length '.repeat(8) }],
          nativeContext: `opaque provider state ${'n'.repeat(400)}`,
          usage,
        },
      ],
    },
  ],
});

/** The input of turn `i` (1-based). @param {number} i */
const inputOf = i => {
  if (i === 3) return 'big reply';
  if (i === 5) return 'call echo';
  return `q${i}`;
};

run(
  `a ${TURNS}-turn session rebuilds the same context after a SIGKILL restart`,
  async t => {
    t.timeout(4.5 * 60_000);
    const template = await ensureTemplate(await m1bTemplateOptions({}));
    const state = await startFromTemplate(template, { t });
    const slice = await makeSlice(state);
    const made = await slice.makeBackend(script);
    let session = await slice.createSession(made.backend, 'context');
    const { key } = await E(session).getInfo();
    let live = await slice.subscribe(session);

    /**
     * @param {string} input
     * @param {number} [ms]
     */
    const turn = async (input, ms = 60_000) => {
      const from = live.deliveries.length;
      const receipt = await slice.submit(session, input);
      const { turnId } = await E(receipt.turn).getStatus();
      await waitFor(
        () =>
          live.deliveries.find(
            (/** @type {any} */ d, /** @type {number} */ i) =>
              i >= from && d.event.type === 'end' && d.event.turnId === turnId,
          ),
        ms,
        `turn ${input}: end`,
        10,
      );
      return turnId;
    };
    const t0 = performance.now();
    for (let i = 1; i <= TURNS; i += 1) await turn(inputOf(i));
    const turnsMs = round1(performance.now() - t0);
    const reference = await turn('reference');
    await waitFor(
      () =>
        made
          .log()
          .find(
            (/** @type {any} */ l) =>
              l.kind === 'context' && l.turnId === reference,
          ),
      5000,
      'reference context line',
    );
    const contextLines = (/** @type {string} */ turnId) =>
      made
        .log()
        .filter(
          (/** @type {any} */ l) => l.kind === 'context' && l.turnId === turnId,
        );
    const [before] = contextLines(reference);
    const inStep = made
      .log()
      .filter((/** @type {any} */ l) => l.kind === 'context')
      .slice(-10)
      .map((/** @type {any} */ l) => l.ms);
    await live.stop();

    await state.kill();
    const { servedMs } = await state.restart();
    await slice.refresh();
    // Presences die with the control client: find the session again.
    session = await E(slice.factory).findSession(key);
    live = await slice.subscribe(session);
    t.teardown(() => live.stop());
    const statusBefore = await state.client.call('status');
    const after = await turn('after the restart', 120_000);
    const statusAfter = await state.client.call('status');
    await waitFor(
      () => contextLines(after).length > 0,
      5000,
      'after context line',
    );
    const lines = contextLines(after);
    const requests = made
      .log()
      .filter(
        (/** @type {any} */ l) => l.kind === 'request' && l.turnId === after,
      );
    t.is(requests.length, 1, 'the provider received the turn once');
    t.is(lines.length, 1, 'one context for its round 0');
    const [rebuilt] = lines;
    t.not(rebuilt.pid, before.pid, 'served by the fresh incarnation');
    const priorBefore = before.turnDigests.split(' ');
    const priorAfter = rebuilt.turnDigests.split(' ');
    // Turns 1..TURNS were complete before the reference turn; the
    // reference turn completed afterwards; then this turn.
    t.is(priorBefore.length, TURNS + 1);
    t.is(priorAfter.length, TURNS + 2, 'its own input once');
    t.deepEqual(
      priorAfter.slice(0, TURNS),
      priorBefore.slice(0, TURNS),
      'the same context as before the restart, native contexts included',
    );
    t.true(Number(rebuilt.records) > Number(before.records));
    const row = {
      metric: 'context.rebuild.vat',
      unit: 'ms',
      value: rebuilt.ms,
      timing: rebuilt.timing,
      // Engine counters over the whole turn after the restart (reopen,
      // page cranks, resolves, the turn itself).
      engine: delta(statusBefore.timings, statusAfter.timings),
      level:
        'adapter prepare after restart (session pages, manager resolves, reads, projection)',
      turns: TURNS + 1,
      transcriptRecords: rebuilt.records,
      transcriptBytes: rebuilt.bytes,
      inStepMs: inStep,
      servedMs,
      turnsMs,
      ...(await runIdentity()),
      crankBudget,
      loadAvg: loadAvg(),
    };
    emit(row);
    t.log(row);
  },
);
