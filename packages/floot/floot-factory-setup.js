// @ts-check
/* global process */
import { setupSessionFactory } from '@endo/fae/setup-session-factory.js';

/** Install the speech-enabled controller at its persistent Floot URL.
 * @param {any} agent */
export const main = agent =>
  setupSessionFactory(agent, {
    directory: process.env.FLOOT_DIR || process.env.ENDO_FLOOT_DIR || 'floot',
    spokenSeed: true,
    localSpecifier: new URL('./agent.js', import.meta.url).href,
    releaseModule: 'packages/floot/agent.js',
  });
harden(main);
