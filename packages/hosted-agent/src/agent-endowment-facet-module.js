// @ts-check

import { E } from '@endo/eventual-send';
import { Fail } from '@endo/errors';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';

const AgentEndowmentFacetInterface = M.interface('AgentEndowmentFacet', {
  forTurn: M.callWhen().returns(M.record()),
});
// eslint-disable-next-line @endo/no-harden-pattern-maker
harden(AgentEndowmentFacetInterface);

/**
 * One agent's endowment and nothing else, so a responder does not hold the
 * root agent factory. Its powers are a directory naming that `factory`.
 *
 * @param {any} powers
 * @param {any} _context
 * @param {{ env?: Record<string, string> }} [options]
 */
export const make = async (powers, _context, { env } = {}) => {
  const agentId = env?.AGENT_ID || Fail`Agent endowment facet has no agent`;
  await null;
  return makeExo('AgentEndowmentFacet', AgentEndowmentFacetInterface, {
    forTurn: async () => {
      const factory = await E(powers).lookup('factory');
      const { powers: harnessPowers, inference, model } =
        await E(factory).endowmentFor(agentId);
      return harden({ powers: harnessPowers, inference, model });
    },
  });
};
harden(make);
