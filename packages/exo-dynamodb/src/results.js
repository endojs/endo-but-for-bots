// @ts-check
/* eslint-disable max-classes-per-file */

/**
 * Expected failures are values. These constructors build the passable tagged
 * results, and the error classes let validation code unwind to the one place
 * that converts them.
 */

/**
 * @template T
 * @param {T} value
 */
export const ok = value => harden({ type: /** @type {const} */ ('ok'), value });
harden(ok);

/** @param {string} reason */
export const invalid = reason =>
  harden({ type: /** @type {const} */ ('invalid-request'), reason });
harden(invalid);

export const revoked = harden({ type: /** @type {const} */ ('revoked') });

/** @param {'page' | 'transaction' | 'item-size' | 'rate'} limit */
export const limited = limit =>
  harden({
    type: /** @type {const} */ ('limit-exceeded'),
    limit,
    retryable: limit === 'rate',
  });
harden(limited);

/** A caller error whose message is safe to return. */
export class RequestError extends Error {}
harden(RequestError);

/** A resource limit was exceeded. */
export class LimitError extends Error {
  /** @param {'page' | 'transaction' | 'item-size' | 'rate'} limit */
  constructor(limit) {
    super(`${limit} limit exceeded`);
    this.limit = limit;
  }
}
harden(LimitError);

/** A gate in the chain was closed when the request reached dispatch. */
export class RevokedError extends Error {}
harden(RevokedError);

/**
 * Throw a safe caller error. Messages must name only caller-supplied methods
 * or logical fields, never physical resources or ancestor policy.
 *
 * @param {string} reason
 * @returns {never}
 */
export const reject = reason => {
  throw new RequestError(reason);
};
harden(reject);

/**
 * @param {unknown} error
 * @returns {string}
 */
export const safeReason = error =>
  error instanceof RequestError ? error.message : 'malformed request';
harden(safeReason);
