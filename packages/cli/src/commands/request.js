import os from 'os';
import { E } from '@endo/eventual-send';
import { withEndoAgent } from '../context.js';
import { parsePetNamePath, parseOptionalPetNamePath } from '../pet-name.js';

export const request = async ({
  description,
  toName,
  resultName,
  agentNames,
}) => {
  await withEndoAgent(agentNames, { os, process }, async ({ agent }) => {
    const result = await E(agent).request(
      parsePetNamePath(toName),
      description,
      parseOptionalPetNamePath(resultName),
    );
    console.log(result);
  });
};
