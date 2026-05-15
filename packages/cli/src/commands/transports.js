// @ts-check
/* global process */
import os from 'os';

import { E } from '@endo/far';

import { withEndoAgent } from '../context.js';
import { parsePetNamePath } from '../pet-name.js';

/**
 * `endo transports provide <name>` — request a per-agent Transports
 * capability and bind it under `<name>` in the agent's pet store.
 *
 * SKELETON: see designs/ocapn-daemon-integration.md. Sibling
 * sub-commands (`list`, `revoke`, etc., per Open Question 9) are not
 * implemented; the design has not chosen between the three CLI
 * surface candidates ("endo transports list/add/revoke", "endo
 * agent <name> transports ...", or both).
 *
 * @param {object} options
 * @param {string} options.name - Pet name for the Transports cap.
 * @param {string} [options.agentNames] - Agent to act as.
 */
export const provide = async ({ name, agentNames }) => {
  const parsedName = parsePetNamePath(name);
  await withEndoAgent(agentNames, { os, process }, async ({ agent }) => {
    // GAP #14 (CLI options threading):
    // The design's Open Question 9 asks whether the CLI carries the
    // allowedSchemes / listenPolicy / outboundPolicy options or
    // whether they are configured server-side. We pass an empty
    // options record; once the design answers, the appropriate
    // flags land here.
    await E(agent).provideTransports(parsedName, {});
    console.log(`Provided @transports as ${name}`);
  });
};
