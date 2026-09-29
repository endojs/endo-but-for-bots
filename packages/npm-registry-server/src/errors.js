// @ts-check

/**
 * @typedef {Error & { statusCode: number, reason: string }} RegistryHttpErrorShape
 */

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
  return error;
};
harden(RegistryHttpError);

/**
 * @param {unknown} error
 * @returns {error is RegistryHttpErrorShape}
 */
export const isRegistryHttpError = error =>
  error instanceof Error &&
  typeof (/** @type {any} */ (error).statusCode) === 'number' &&
  typeof (/** @type {any} */ (error).reason) === 'string';
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
