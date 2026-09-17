// @ts-check

import { makeSessionStorage } from '@endo/hosted-agent/session-storage.js';
import { readCodexSessionPlan } from './codex-session-plan.js';

/** @param {Omit<Parameters<typeof makeSessionStorage>[0], 'readPlan'>} powers */
export const makeCodexSessionStorage = powers =>
  makeSessionStorage({ ...powers, readPlan: readCodexSessionPlan });
harden(makeCodexSessionStorage);
