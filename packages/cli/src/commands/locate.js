import os from 'os';
import { E } from '@endo/eventual-send';
import { assertAgentHoldsLocators, withEndoAgent } from '../context.js';
import { parsePetNamePath } from '../pet-name.js';

export const locate = async ({ name, agentNames }) =>
  withEndoAgent(agentNames, { os, process }, async ({ agent }) => {
    const namePath = parsePetNamePath(name);
    await assertAgentHoldsLocators(agent, '`endo locate`');
    const locator = await E(agent).locate(...namePath);
    if (locator === undefined) {
      console.error(`${name}: not found`);
      process.exitCode = 1;
      return;
    }
    console.log(locator);
  });
