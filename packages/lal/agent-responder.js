// @ts-check

import { makeAgentResponderCaplet } from '@endo/hosted-agent/agent-responder-module.js';

import { makeBrokeredModel, makeWorkerPiAgent } from './agent.js';
import { runRound } from './round-runner.js';

/**
 * One Lal conversation answering one prompt at a time. The transcript lasts
 * this worker's lifetime, as `spawnWorkerLoop`'s does. A failed turn is rolled
 * out of it, so a retried message is not sent after its own failure.
 *
 * @param {{ powers: any, inference: any, model: string, maxTokens?: number }} endowment
 */
export const makeLalTurnRunner = async ({
  powers,
  inference,
  model,
  maxTokens,
}) => {
  await null;
  const {
    model: brokeredModel,
    piOptions,
    dispose,
  } = makeBrokeredModel({
    LAL_INFERENCE: inference,
    LAL_MODEL: model,
    ...(maxTokens === undefined ? {} : { LAL_MAX_TOKENS: `${maxTokens}` }),
  });
  const piAgent = makeWorkerPiAgent(powers, brokeredModel, piOptions);
  return harden({
    /**
     * @param {string} prompt
     * @param {AbortSignal} signal
     */
    runTurn: async (prompt, signal) => {
      const before = [...piAgent.state.messages];
      const abort = () => piAgent.abort();
      signal.addEventListener('abort', abort, { once: true });
      await null;
      try {
        return harden({ text: await runRound(piAgent, prompt) });
      } catch (error) {
        piAgent.state.messages = before;
        throw error;
      } finally {
        signal.removeEventListener('abort', abort);
      }
    },
    dispose,
  });
};
harden(makeLalTurnRunner);

export const make = makeAgentResponderCaplet(makeLalTurnRunner);
