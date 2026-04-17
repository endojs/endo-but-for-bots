/* global process */
import os from 'os';

import { E } from '@endo/far';

import { withEndoAgent } from '../context.js';
import { parsePetNamePath } from '../pet-name.js';

/**
 * Create an HttpClient capability with an origin allowlist.
 *
 * @param {object} options
 * @param {string} options.name - Pet name for the client.
 * @param {string[]} options.origins - Allowed origin URLs.
 * @param {number} [options.maxRequestsPerMinute] - Rate limit.
 * @param {number} [options.maxResponseBytes] - Max response size.
 * @param {string} [options.agentNames] - Agent to act as.
 */
export const httpClient = async ({
  name,
  origins,
  agentNames,
  maxRequestsPerMinute,
  maxResponseBytes,
}) => {
  const parsedName = parsePetNamePath(name);

  await withEndoAgent(agentNames, { os, process }, async ({ agent }) => {
    const opts = {};
    if (maxRequestsPerMinute !== undefined) {
      opts.maxRequestsPerMinute = Number(maxRequestsPerMinute);
    }
    if (maxResponseBytes !== undefined) {
      opts.maxResponseBytes = Number(maxResponseBytes);
    }
    await E(agent).makeHttpClient(parsedName, origins, opts);
    console.log(
      `Created HttpClient "${name}" with origins: ${origins.join(', ')}`,
    );
  });
};
