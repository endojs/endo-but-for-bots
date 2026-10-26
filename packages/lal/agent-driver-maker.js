// @ts-check

import { E } from '@endo/eventual-send';
import { makeExo } from '@endo/exo';
import { AgentDriverMakerInterface } from '@endo/exo-agent-factory';

/**
 * Make the descriptor adapter for Lal's landed worker loop.
 *
 * @param {object} options
 * @param {{ LAL_HOST?: string, LAL_MODEL?: string, LAL_AUTH_TOKEN?: string }} options.workerEnvironment
 * @param {string} [options.driverSpecifier]
 */
export const makeLalAgentDriverMaker = ({
  workerEnvironment,
  driverSpecifier = new URL('./driver.js', import.meta.url).href,
}) =>
  makeExo('LalAgentDriverMaker', AgentDriverMakerInterface, {
    /** @param {{ agent: any, driverGuest: any }} context */
    async installDriver({ agent, driverGuest }) {
      await E(driverGuest).storeValue(agent, 'agent');
      return harden({
        specifier: driverSpecifier,
        env: harden({ ...workerEnvironment }),
      });
    },
  });
harden(makeLalAgentDriverMaker);
