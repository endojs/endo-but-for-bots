import path from 'path';
import os from 'os';

import { E } from '@endo/eventual-send';

import { withEndoAgent } from '../context.js';
import { parsePetNamePath } from '../pet-name.js';

/**
 * Mount an external filesystem directory.
 *
 * @param {object} options
 * @param {string} options.sourcePath - Local directory to mount.
 * @param {string} options.name - Pet name for the mount.
 * @param {boolean} [options.readOnly] - Whether the mount is read-only.
 * @param {string[]} [options.deniedSegments] - Restricted-segment set that
 *   replaces the mount's default (an empty array disables denial); omit to
 *   keep the default set.
 * @param {string} [options.agentNames] - Agent to act as.
 */
export const mount = async ({
  sourcePath,
  name,
  agentNames,
  readOnly,
  deniedSegments,
}) => {
  const parsedName = parsePetNamePath(name);
  const resolvedPath = path.resolve(sourcePath);

  await withEndoAgent(agentNames, { os, process }, async ({ agent }) => {
    await E(agent).provideMount(resolvedPath, parsedName, {
      readOnly: readOnly || false,
      // Pass `deniedSegments` only when overridden so the daemon applies its
      // default set otherwise (the guard rejects `deniedSegments: undefined`).
      ...(deniedSegments !== undefined ? { deniedSegments } : {}),
    });
    console.log(`Mounted ${resolvedPath} as ${name}`);
  });
};
