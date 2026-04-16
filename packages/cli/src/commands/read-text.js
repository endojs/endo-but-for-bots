/* global process */
import os from 'os';

import { E } from '@endo/far';

import { withEndoAgent } from '../context.js';
import { parsePetNamePath } from '../pet-name.js';

/**
 * Read text content from a path within a mount or blob.
 *
 * For single-segment paths, reads a blob's text.
 * For multi-segment paths like `project/src/index.js`, navigates through
 * mounts via the pet-name directory's `readText` delegation chain.
 *
 * @param {object} options
 * @param {string} options.name - Slash-delimited pet name path.
 * @param {string} [options.agentNames] - Agent to act as.
 */
export const readText = async ({ name, agentNames }) =>
  withEndoAgent(agentNames, { os, process }, async ({ agent }) => {
    const namePath = parsePetNamePath(name);
    const text = await E(agent).readText(namePath);
    process.stdout.write(text);
  });
