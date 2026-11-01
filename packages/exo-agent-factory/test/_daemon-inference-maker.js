// @ts-check
// prefer-endo-primitives-exempt: Far instances are explicit remotable test doubles.

// A test `AgentDriverMaker` caplet: the package's inference maker over a fake
// `@endo/inference` backend. Each answer names this incarnation and counts
// its calls, so a test can tell a recorded result from a fresh inference.

import { Far } from '@endo/far';

import { makeInferenceAgentDriverMaker } from '../index.js';

export const make = () => {
  const incarnation = `${Date.now()}-${Math.random()}`;
  let calls = 0;
  const backend = /** @type {any} */ (
    Far('FakeInferenceBackend', {
      /** @param {{ prompt: string }} request */
      async infer({ prompt }) {
        calls += 1;
        return harden({
          type: 'ok',
          text: `answer ${calls} from ${incarnation} to ${prompt}`,
        });
      },
    })
  );
  return makeInferenceAgentDriverMaker({
    backend,
    makeGuestToolProjection: () =>
      harden({
        buildMcpServer: Far('buildMcpServer', () => harden({})),
        toolNames: harden([]),
        formulaIdentifier: 'child:fake',
      }),
  });
};
