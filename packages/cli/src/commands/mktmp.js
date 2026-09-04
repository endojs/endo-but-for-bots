import os from 'os';

import { E } from '@endo/eventual-send';

import { withEndoAgent } from '../context.js';
import { parsePetNamePath } from '../pet-name.js';

/**
 * Create a portable scratch space in the daemon state directory.
 *
 * Unlike `mount`, scratch spaces migrate with the state directory.
 * Unlike `mkdir`, they materialize as files on disk.
 *
 * @param {object} options
 * @param {string} options.name - Pet name for the scratch space.
 * @param {boolean} [options.readOnly] - Whether the mount is read-only.
 * @param {string[]} [options.deniedSegments] - Restricted-segment set that
 *   replaces the mount's default (an empty array disables denial); omit to
 *   keep the default set.
 * @param {string} [options.agentNames] - Agent to act as.
 */
export const mktmp = async ({ name, agentNames, readOnly, deniedSegments }) => {
  const parsedName = parsePetNamePath(name);

  await withEndoAgent(agentNames, { os, process }, async ({ agent }) => {
    await E(agent).provideScratchMount(parsedName, {
      readOnly: readOnly || false,
      // Pass `deniedSegments` only when overridden so the daemon applies its
      // default set otherwise (the guard rejects `deniedSegments: undefined`).
      ...(deniedSegments !== undefined ? { deniedSegments } : {}),
    });
    console.log(`Created scratch space as ${name}`);
  });
};
