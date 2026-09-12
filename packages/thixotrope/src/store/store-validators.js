// @ts-check
import { Fail, q } from '@endo/errors';
import harden from '@endo/harden';

// Worker ids are host-generated unguessable random hex, never
// user-chosen names: reaching a worker requires a capability (a
// publication, a durable cross-worker link, or a facade), not a string.
const WORKER_ID_PATTERN = /^[0-9a-f]{32}$/;

// Resume tokens arrive over the network and become directory names:
// validate the exact shape the durable netlayer mints before any
// filesystem use.
const SESSION_TOKEN_PATTERN = /^[0-9a-f]{32}$/;

/** @param {string} token */
export const isSessionToken = token =>
  typeof token === 'string' && SESSION_TOKEN_PATTERN.test(token);
harden(isSessionToken);

/** @param {string} token */
export const assertSessionToken = token => {
  isSessionToken(token) ||
    Fail`Session token must match ${q(SESSION_TOKEN_PATTERN.source)}`;
};
harden(assertSessionToken);

/** @param {string} workerId */
export const assertWorkerId = workerId => {
  WORKER_ID_PATTERN.test(workerId) ||
    Fail`Worker id must match ${q(WORKER_ID_PATTERN.source)}, got ${q(
      workerId,
    )}`;
};
harden(assertWorkerId);
