// @ts-check

/**
 * The OpenCode storage owner: `@endo/hosted-agent/session-storage.js` over
 * the OpenCode plan parser. See that module for the removal contract.
 *
 * @module
 */

import { makeSessionStorage } from '@endo/hosted-agent/session-storage.js';

import { readSessionPlan } from './opencode-session-plan.js';

/**
 * @param {Omit<Parameters<typeof makeSessionStorage>[0], 'readPlan'>} powers
 */
export const makeOpencodeSessionStorage = powers =>
  makeSessionStorage({ ...powers, readPlan: readSessionPlan });
harden(makeOpencodeSessionStorage);
