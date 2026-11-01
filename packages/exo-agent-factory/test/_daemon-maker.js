// @ts-check

// A test `AgentDriverMaker` caplet. It gives the driver guest the child's
// own guest, the one adapter capability the echo runner needs, and names the
// runner module for the coordinator to formulate.

import { E } from '@endo/eventual-send';
import { Far } from '@endo/far';

const runnerSpecifier = new URL('./_daemon-runner.js', import.meta.url).href;

export const make = () =>
  Far('AgentDriverMaker', {
    /** @param {{ agent: any, driverGuest: any }} context */
    async installDriver({ agent, driverGuest }) {
      await E(driverGuest).storeValue(agent, 'agent');
      return harden({ specifier: runnerSpecifier });
    },
  });
