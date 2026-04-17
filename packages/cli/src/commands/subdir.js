/* global process */
import os from 'os';

import { E } from '@endo/far';

import { withEndoAgent } from '../context.js';

/**
 * Create a sub-mount rooted at a subdirectory of an existing mount.
 *
 * @param {object} options
 * @param {string} options.mountName - Pet name of the parent mount.
 * @param {string} options.subpath - Relative path within the parent mount.
 * @param {string} options.newName - Pet name for the new sub-mount.
 * @param {string} [options.agentNames] - Agent to act as.
 * @param {boolean} [options.readOnly] - Create read-only sub-mount.
 */
export const subdirCommand = async ({
  mountName,
  subpath,
  newName,
  agentNames,
  readOnly = false,
}) => {
  await withEndoAgent(agentNames, { os, process }, async ({ agent }) => {
    await E(agent).provideSubMount(mountName, subpath, newName, { readOnly });
  });
};
