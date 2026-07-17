import makeE from '@endo/eventual-send/src/E.js';
import { makeHandledPromise } from '@endo/eventual-send/src/handled-promise.js';

export const HandledPromise = makeHandledPromise();
export const E = makeE(HandledPromise);
