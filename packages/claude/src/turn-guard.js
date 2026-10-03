// @ts-check
//
// The turn plumbing both backends share: admitting a credential, ending any
// await the moment the limit enforcer terminates the turn, and naming an
// error without quoting it.

import { E } from '@endo/eventual-send';
import { M, matches } from '@endo/patterns';
import {
  CredentialGrantShape,
  CredentialRefusalShape,
} from '@endo/inference/guards.js';

/** @import { ERef } from '@endo/eventual-send' */
/** @import { CredentialGrant, CredentialRefusal, CredentialSource } from '@endo/inference/types.js' */

const AdmissionShape = M.or(CredentialGrantShape, CredentialRefusalShape);

/**
 * @typedef {CredentialGrant | CredentialRefusal | { type: 'failed', detail: string }} Admission
 */

/**
 * Calls `acquire()` once. A malformed grant or a rejection becomes `failed`
 * without its contents: a source's error may carry the very credential it
 * failed to deliver, and the detail reaches the usage record.
 *
 * @param {ERef<CredentialSource>} credentialSource
 * @returns {Promise<Admission>}
 */
export const acquireAdmission = credentialSource =>
  E(credentialSource)
    .acquire()
    .then(
      grant =>
        matches(grant, AdmissionShape)
          ? /** @type {CredentialGrant | CredentialRefusal} */ (grant)
          : harden({
              type: /** @type {const} */ ('failed'),
              detail: 'malformed admission',
            }),
      () =>
        harden({
          type: /** @type {const} */ ('failed'),
          detail: 'acquire rejected',
        }),
    );
harden(acquireAdmission);

/**
 * Names `error` by its code or class, never by its message. Once a credential
 * is in scope an error message may quote it (Node's argument checks repeat
 * the rejected value), and the detail reaches the usage record.
 *
 * @param {unknown} error
 * @returns {string}
 */
export const errorCategory = error => {
  if (typeof error !== 'object' || error === null) return typeof error;
  try {
    const { code, name } = /** @type {{ code?: unknown, name?: unknown }} */ (
      error
    );
    if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code)) {
      return code;
    }
    if (typeof name === 'string' && /^[A-Za-z]{1,64}$/.test(name)) {
      return name;
    }
  } catch {
    // A throwing getter names nothing.
  }
  return 'error';
};
harden(errorCategory);

/**
 * Makes the `terminated` signal a backend hands its limit enforcer, and
 * `untilTerminated`, which ends an await when that signal fires. Every await
 * in a turn goes through it, so no limit depends on the awaited party
 * settling: a binary, broker, guest, or SDK that never answers still lets the
 * turn return. A value that arrives after termination goes to `lateCleanup`,
 * so a grant or a scratch directory is not leaked.
 */
export const makeTerminationRace = () => {
  /** @type {(reason: Error) => void} */
  let reject = () => {};
  /** @type {Promise<never>} */
  const terminated = new Promise((_resolve, rejectTerminated) => {
    reject = rejectTerminated;
  });
  // Nothing may be racing when the turn is terminated.
  terminated.catch(() => {});

  /**
   * @template T
   * @param {T | PromiseLike<T>} promise
   * @param {(value: T) => unknown} [lateCleanup]
   * @returns {Promise<T>}
   */
  const untilTerminated = (promise, lateCleanup) => {
    const settled = Promise.resolve(promise);
    return Promise.race([settled, terminated]).catch(error => {
      if (lateCleanup !== undefined) {
        settled.then(lateCleanup).catch(() => {});
      } else {
        settled.catch(() => {});
      }
      throw error;
    });
  };

  return harden({
    signalTerminated: () => reject(Error('turn terminated')),
    untilTerminated,
  });
};
harden(makeTerminationRace);
