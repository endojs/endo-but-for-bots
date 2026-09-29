// @ts-check

/**
 * @typedef {Error & { statusCode: number, reason: string }} RegistryHttpErrorShape
 */

/**
 * Every error `RegistryHttpError` made. The HTTP adapter sends a registry
 * error's status and reason to the client, so recognition is by this
 * brand, not by shape: an error from elsewhere that happens to carry
 * `statusCode` and `reason` stays an internal error.
 *
 * @type {WeakSet<Error>}
 */
const registryHttpErrors = new WeakSet();

/**
 * An error that carries the npm-compatible HTTP status the adapter reports.
 * The message is the stable `reason` in the `{ error, reason }` JSON body.
 *
 * @param {number} statusCode
 * @param {string} reason
 * @returns {RegistryHttpErrorShape}
 */
export const RegistryHttpError = (statusCode, reason) => {
  const error = /** @type {RegistryHttpErrorShape} */ (Error(reason));
  error.statusCode = statusCode;
  error.reason = reason;
  // The brand vouches for the status, so the status must not change.
  harden(error);
  registryHttpErrors.add(error);
  return error;
};
harden(RegistryHttpError);

/**
 * @param {unknown} error
 * @returns {error is RegistryHttpErrorShape}
 */
export const isRegistryHttpError = error =>
  error instanceof Error && registryHttpErrors.has(error);
harden(isRegistryHttpError);

/** @type {Record<number, string>} */
export const STATUS_ERRORS = harden({
  400: 'bad_request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  405: 'method_not_allowed',
  409: 'conflict',
  413: 'payload_too_large',
  500: 'internal_error',
  502: 'bad_gateway',
  504: 'gateway_timeout',
});
