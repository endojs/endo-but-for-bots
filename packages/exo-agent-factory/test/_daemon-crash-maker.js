// @ts-check
// prefer-endo-primitives-exempt: Far instances are explicit remotable test doubles.

// A test `AgentDriverMaker` caplet for the turn-ledger crash cut inside
// `infer`. Its fake backend performs a tool effect, an append to the file
// named by `EFFECTS_PATH`, before it answers. While the file named by
// `HOLD_PATH` exists, `infer` never returns after that effect, so a test can
// restart the daemon with the turn started but no result recorded.

import fs from 'fs';
import { Far } from '@endo/far';

import { makeInferenceAgentDriverMaker } from '../index.js';

/**
 * @param {unknown} _powers
 * @param {unknown} _context
 * @param {{ env?: Record<string, string> }} [options]
 */
export const make = (_powers, _context, { env: environment = {} } = {}) => {
  const { EFFECTS_PATH: effectsPath, HOLD_PATH: holdPath } = environment;
  const backend = /** @type {any} */ (
    Far('FakeToolEffectBackend', {
      /** @param {{ prompt: string }} request */
      async infer({ prompt }) {
        fs.appendFileSync(effectsPath, `${prompt}\n`);
        if (fs.existsSync(holdPath)) {
          return new Promise(() => {});
        }
        return harden({ type: 'ok', text: `done: ${prompt}` });
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
