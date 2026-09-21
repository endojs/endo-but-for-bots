// @ts-check

import { Fail } from '@endo/errors';
import { E } from '@endo/eventual-send';

import { makeWorkerFacet } from './worker.js';

/**
 * Bind the existing worker loader to one host-selected module and one attempt.
 * The generic evaluate/makeUnconfined authority never leaves this closure.
 * An unsuccessful or unknown attempt is not permission to instantiate again.
 *
 * @param {{specifier: string, cancel: (reason: Error) => void}} options
 */
export const makeFixedWorker = ({ specifier, cancel }) => {
  new URL(specifier).protocol === 'file:' || Fail`Fixed worker requires a file URL`;
  const worker = makeWorkerFacet({ cancel });
  let attempted = false;
  /**
   * @param {unknown} powers
   * @param {unknown} context
   * @param {Record<string, string>} env
   */
  const instantiate = (powers, context, env) => {
    !attempted || Fail`Fixed worker construction already attempted`;
    attempted = true;
    return E(worker).makeUnconfined(specifier, powers, context, env);
  };
  return harden({ instantiate });
};
harden(makeFixedWorker);
