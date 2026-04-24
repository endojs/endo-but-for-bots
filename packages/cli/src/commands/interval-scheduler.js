/* global process */
import os from 'os';

import { E } from '@endo/far';

import { withEndoAgent } from '../context.js';
import { parsePetNamePath } from '../pet-name.js';

/**
 * Create an IntervalScheduler capability for an agent.
 *
 * @param {object} options
 * @param {string} options.name - Pet name for the scheduler.
 * @param {number} [options.maxActive] - Max concurrent intervals.
 * @param {number} [options.minPeriodMs] - Minimum interval period in ms.
 * @param {string} [options.agentNames] - Agent to act as.
 */
export const intervalScheduler = async ({
  name,
  agentNames,
  maxActive,
  minPeriodMs,
}) => {
  const parsedName = parsePetNamePath(name);

  await withEndoAgent(agentNames, { os, process }, async ({ agent }) => {
    const opts = {};
    if (maxActive !== undefined) {
      opts.maxActive = Number(maxActive);
    }
    if (minPeriodMs !== undefined) {
      opts.minPeriodMs = Number(minPeriodMs);
    }
    await E(agent).makeIntervalScheduler(parsedName, opts);
    console.log(`Created IntervalScheduler "${name}"`);
  });
};
