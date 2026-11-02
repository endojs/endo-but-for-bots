// @ts-check

import { Fail } from '@endo/errors';

/**
 * Own acquired resources until their cleanup succeeds. Register each release
 * as soon as its acquisition completes, or before attempting a partial
 * acquisition whose cancellation is idempotent. The caller must retain this
 * scope after a failed run and refuse conflicting acquisitions until it drains.
 *
 * Release in reverse registration order, trying every stage even if another
 * fails. Dependencies belong in the release callbacks (for example, do not
 * unmount a workspace until its process has been reaped).
 * This is cleanup ownership, not a process-stop or authority-revocation policy.
 */
export const makeCleanupScope = () => {
  /** @type {Array<() => Promise<void>>} */
  const releases = [];
  let closing = false;
  /** @type {Promise<void> | undefined} */
  let flight;
  /** @param {() => Promise<void>} release */
  const add = release => {
    !closing || Fail`Cannot acquire resources in a closing cleanup scope`;
    releases.push(release);
  };
  const drain = async () => {
    await null;
    const errors = [];
    for (let index = releases.length - 1; index >= 0; index -= 1) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await releases[index]();
        // Release successful callbacks and their captured resource handles.
        releases.splice(index, 1);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) {
      throw new AggregateError(errors, 'Resource cleanup remains pending');
    }
  };
  const run = () => {
    closing = true;
    if (!flight) {
      flight = drain().finally(() => {
        flight = undefined;
      });
    }
    return flight;
  };
  return harden({ add, run });
};
harden(makeCleanupScope);
