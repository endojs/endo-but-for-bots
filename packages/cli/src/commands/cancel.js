import os from 'os';
import { E } from '@endo/eventual-send';
import { withEndoAgent } from '../context.js';
import { parsePetNamePath } from '../pet-name.js';

export const cancelCommand = async ({ name, agentNames, reason }) =>
  withEndoAgent(agentNames, { os, process }, async ({ agent }) => {
    await E(agent).cancel(parsePetNamePath(name), reason);
  });
