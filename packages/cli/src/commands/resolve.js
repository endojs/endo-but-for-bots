import os from 'os';
import { E } from '@endo/eventual-send';
import { withEndoAgent } from '../context.js';
import { parseBigint } from '../number-parse.js';
import { parsePetNamePath } from '../pet-name.js';

export const resolveCommand = async ({
  requestNumberText,
  resolutionName,
  agentNames,
}) =>
  withEndoAgent(agentNames, { os, process }, async ({ agent }) => {
    await E(agent).resolve(
      parseBigint(requestNumberText),
      parsePetNamePath(resolutionName),
    );
  });
