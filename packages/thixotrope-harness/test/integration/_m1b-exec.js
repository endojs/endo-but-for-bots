// @ts-check
/**
 * Helpers of the exec tool integration tests (M1b W1b.4): the m1b state
 * template with the real session and exec programs and the factory's
 * default pool (`m1bTemplateOptions`), a scripted backend whose turns each
 * make one `exec` call, and a turn runner that reads the call's result
 * from the transcript and its timing from a live subscription.
 * AVA skips files starting with an underscore.
 */
import { E } from '@endo/far';

import {
  crankBudget,
  emit,
  loadAvg,
  runIdentity,
} from '../../perf/_harness.mjs';
import { m1bTemplateOptions } from '../../scripts/provision-steps.js';
import { ensureTemplate } from '../template/index.js';
import { round1, waitFor } from './_m1a-slice.js';

const usage = {
  inputTokens: 10,
  outputTokens: 5,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  reasoningOutputTokens: 0,
};

/** Model code of each scripted turn; the turn's input is its key. */
export const execCode = Object.freeze({
  'exec set': 'globalThis.x = 5; return x;',
  'exec get': "return typeof x === 'undefined' ? -1 : x;",
  'exec trivial': 'return 1;',
  'exec sleep30': 'globalThis.x = 5; await sleep(30000); return 30;',
  'exec sleep4': 'await sleep(4000); return 4;',
  // M1b QC (J-0391): what an abandoned call would do after its sleep.
  'exec late99': 'await sleep(4000); globalThis.x = 99; return 99;',
  'exec loop': 'while (true) {}',
  'exec forever': 'await new Promise(() => {});',
  'exec sends': [
    'const all = [];',
    'for (let i = 0; i < 100; i += 1) all.push(sleep(0));',
    'await Promise.all(all);',
    'return all.length;',
  ].join('\n'),
});

/** The rendered value `exec get` returns when `x` is unset. */
export const UNSET = '-1';

/** One turn per input: an exec call, then a closing text round. */
export const execScript = {
  turns: Object.entries(execCode).map(([input, code]) => ({
    input,
    rounds: [
      {
        chunks: [{ text: input }],
        toolCalls: [{ name: 'exec', args: JSON.stringify({ code }) }],
        usage,
      },
      { chunks: [{ text: 'done' }], usage },
    ],
  })),
};

/** The m1b template (shared with W1b.6: same options, same id). */
export const execTemplate = async () => {
  /** @type {any[]} */
  const steps = [];
  const template = await ensureTemplate(
    await m1bTemplateOptions({ onStep: report => steps.push(report) }),
  );
  if (template.built)
    emit({
      metric: 'm1b.template',
      buildMs: template.buildMs,
      steps: steps.map(s => ({ name: s.name, ms: s.ms, skipped: s.skipped })),
      ...(await runIdentity()),
      crankBudget,
      loadAvg: loadAvg(),
    });
  return template;
};

/** @param {any} row */
export const isExecVat = row =>
  /^(spare )?exec \d+$/.test(row.debugLabel ?? '');

/**
 * The tool results of one turn, from the transcript (call order).
 * @param {any} session
 * @param {string} turnId
 */
export const resultsOf = async (session, turnId) => {
  const page = await E(session).getHistoryPage();
  const turn = page.turns.find((/** @type {any} */ tp) => tp.turnId === turnId);
  return {
    state: turn?.state,
    results: (turn?.records ?? [])
      .filter((/** @type {any} */ r) => r.kind === 'tool-result')
      .map((/** @type {any} */ r) => r.result),
  };
};

/**
 * Submit `input`, wait for the exec call's result (or `until`), and return
 * the turn, its id, and the live arrival times of `tool_call` and
 * `tool_result` (client clock, `Date.now()`).
 * @param {any} slice
 * @param {any} session
 * @param {ReturnType<import('./_m1a-slice.js').collect>} live
 * @param {keyof typeof execCode} input
 * @param {{ wait?: 'result' | 'call' | 'end', ms?: number }} [options]
 */
export const execTurn = async (
  slice,
  session,
  live,
  input,
  { wait = 'end', ms = 60_000 } = {},
) => {
  const from = live.deliveries.length;
  const receipt = await slice.submit(session, input);
  const { turnId } = await E(receipt.turn).getStatus();
  const find = (/** @type {string} */ type) => {
    const d = live.deliveries.find(
      (x, i) => i >= from && x.event.type === type && x.event.turnId === turnId,
    );
    return d;
  };
  const type = { result: 'tool_result', call: 'tool_call', end: 'end' }[wait];
  await waitFor(() => find(type), ms, `${input}: ${type}`, 10);
  const call = find('tool_call');
  const result = find('tool_result');
  return {
    turn: receipt.turn,
    turnId,
    callAt: call?.arrivedAt,
    resultAt: result?.arrivedAt,
    callMs:
      call && result ? round1(result.arrivedAt - call.arrivedAt) : undefined,
    result: result?.event.result,
    endStatus: find('end')?.event.status,
  };
};
