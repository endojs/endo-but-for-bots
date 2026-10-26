// @ts-check

import { E } from '@endo/eventual-send';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';

import { spawnWorkerLoop } from './agent.js';

const LalDriverInterface = M.interface('LalDriver', {});

/**
 * @param {any} powers
 * @param {Promise<object> | object | undefined} context
 * @param {{ env?: { LAL_HOST?: string, LAL_MODEL?: string, LAL_AUTH_TOKEN?: string } }} [options]
 */
export const make = async (powers, context, { env: environment = {} } = {}) => {
  const start = async () => {
    const agent = await E(powers).lookup('agent');
    await spawnWorkerLoop(agent, context, environment);
  };
  start().catch(error => {
    console.error(
      '[lal-driver] inbox loop error:',
      error instanceof Error ? error.message : String(error),
    );
  });
  return makeExo('LalDriver', LalDriverInterface, {});
};
harden(make);
