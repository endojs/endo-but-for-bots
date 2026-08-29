import os from 'os';
import { E } from '@endo/eventual-send';
import { withEndoAgent } from '../context.js';
import { parsePetNamePath } from '../pet-name.js';

/**
 * @param {object} options
 * @param {'map' | 'set'} options.kind
 * @param {string} options.name
 * @param {string | undefined} options.agentNames
 */
export const makeCollectionStore = async ({ kind, name, agentNames }) =>
  withEndoAgent(agentNames, { os, process }, async ({ agent }) => {
    await null;
    const namePath = parsePetNamePath(name);
    if (kind === 'map') {
      await E(agent).makeMapStore(namePath);
    } else {
      await E(agent).makeSetStore(namePath);
    }
  });
