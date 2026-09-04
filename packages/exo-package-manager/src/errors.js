// @ts-check
/// <reference types="ses"/>

import { makeError, q, X } from '@endo/errors';

/**
 * Local error codes for package-manager preflight and policy failures.
 * Setup and policy errors throw before spawn; process outcomes live in
 * `PackageCommandResult`.
 *
 * Under SES, Error instances from `makeError` are hardened, so codes are kept
 * in a module-private WeakMap rather than own-properties on the Error. The
 * accessors support in-realm selection and tests only and are intentionally
 * absent from the package root because this metadata does not survive error
 * marshaling.
 *
 * @typedef {'manager-undetected'
 *   | 'manager-ambiguous'
 *   | 'manager-mismatch'
 *   | 'lockfile-missing'
 *   | 'manager-unavailable'
 *   | 'workspace-invalid'
 *   | 'script-not-declared'
 *   | 'operation-cancelled'
 *   | 'policy-denied'} PackageManagerErrorCode
 */

/**
 * @type {WeakMap<object, { code: PackageManagerErrorCode, details?: Record<string, unknown> }>}
 */
const packageManagerErrorData = new WeakMap();

/**
 * @param {PackageManagerErrorCode} code
 * @param {string} detail
 * @param {Record<string, unknown>} [details]
 * @returns {Error}
 */
export const makePackageManagerError = (code, detail, details = undefined) => {
  const err = makeError(X`${q(code)}: ${detail}`);
  packageManagerErrorData.set(
    err,
    harden({
      code,
      ...(details !== undefined ? { details: harden(details) } : {}),
    }),
  );
  return err;
};
harden(makePackageManagerError);

/**
 * @param {unknown} err
 * @returns {PackageManagerErrorCode | undefined}
 */
export const getPackageManagerErrorCode = err => {
  if (err === null || typeof err !== 'object') {
    return undefined;
  }
  const data = packageManagerErrorData.get(/** @type {object} */ (err));
  return data?.code;
};
harden(getPackageManagerErrorCode);

/**
 * @param {unknown} err
 * @returns {Record<string, unknown> | undefined}
 */
export const getPackageManagerErrorDetails = err => {
  if (err === null || typeof err !== 'object') {
    return undefined;
  }
  const data = packageManagerErrorData.get(/** @type {object} */ (err));
  return data?.details;
};
harden(getPackageManagerErrorDetails);
