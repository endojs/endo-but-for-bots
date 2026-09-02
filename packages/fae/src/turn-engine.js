// @ts-check

import { Fail } from '@endo/errors';

/**
 * Run the provider/tool state machine shared by FAE and Floot.
 *
 * Persistence, wire encoding, streaming, and inbox policy stay in the caller.
 * This engine owns the invariant that each model response is followed by all
 * of its tool results before another model call, and that exactly one toolless
 * response ends the logical turn.
 *
 * @param {object} options
 * @param {string} options.leafId
 * @param {number} options.maxRounds
 * @param {(round: number) => Promise<any>} options.getTools
 * @param {(leafId: string) => Promise<readonly any[]>} options.getContext
 * @param {(context: readonly any[], tools: any, round: number) => Promise<{ message?: any }>} options.invoke
 * @param {(message: any) => readonly any[]} options.getToolCalls
 * @param {(calls: readonly any[], tools: any, round: number) => Promise<any>} options.runTools
 * @param {(leafId: string, message: any, results: any) => Promise<string>} options.commitStep
 * @param {(leafId: string, message: any) => Promise<string>} options.commitFinal
 */
export const runAgenticTurn = async ({
  leafId,
  maxRounds,
  getTools,
  getContext,
  invoke,
  getToolCalls,
  runTools,
  commitStep,
  commitFinal,
}) => {
  (Number.isInteger(maxRounds) && maxRounds > 0) ||
    Fail`agentic turn maxRounds must be a positive integer`;
  let currentLeafId = leafId;
  await null;
  for (let round = 0; round < maxRounds; round += 1) {
    // eslint-disable-next-line no-await-in-loop
    const tools = await getTools(round);
    // eslint-disable-next-line no-await-in-loop
    const context = await getContext(currentLeafId);
    // eslint-disable-next-line no-await-in-loop
    const outcome = await invoke(context, tools, round);
    if (!outcome.message) {
      return harden({
        answered: false,
        exhausted: false,
        leafId: currentLeafId,
      });
    }
    const calls = getToolCalls(outcome.message);
    if (calls.length === 0) {
      // eslint-disable-next-line no-await-in-loop
      currentLeafId = await commitFinal(currentLeafId, outcome.message);
      return harden({
        answered: true,
        exhausted: false,
        leafId: currentLeafId,
        message: outcome.message,
      });
    }
    // eslint-disable-next-line no-await-in-loop
    const results = await runTools(calls, tools, round);
    // eslint-disable-next-line no-await-in-loop
    currentLeafId = await commitStep(currentLeafId, outcome.message, results);
  }
  return harden({
    answered: false,
    exhausted: true,
    leafId: currentLeafId,
  });
};
harden(runAgenticTurn);
