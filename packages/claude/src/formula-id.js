// @ts-check
//
// The formula id is validated as 64 hex at the harness boundary and carried as a
// branded type thereafter (§ Routing a call to that guest's facet). It flows into
// a JSON `--mcp-config`, into the shim argv, and (HTTP transport) into an
// `Authorization: Bearer` line, so an unvalidated designator carrying a `"`, a
// newline, or a CR would break the JSON, split the argv, or inject a header.
//
// The assertion is applied ONCE, at grant time, in `makeGuestInference`; the
// per-guest `infer` exo it returns carries NO designator at all.

import { makeError, X, q } from '@endo/errors';

/** @import { GuestFormulaId } from './types.js' */

const FORMULA_ID = /^[0-9a-f]{64}$/;

/**
 * Assert a value is a 64-hex formula id and return it branded. Throws (a
 * grant-time deployment error, per the throw-vs-return rule of Design Decision 8)
 * on any non-conforming value.
 *
 * @param {unknown} value
 * @returns {GuestFormulaId}
 */
export const assertGuestFormulaId = value => {
  if (typeof value !== 'string' || !FORMULA_ID.test(value)) {
    throw makeError(
      X`guest formula id must be 64 lowercase hex characters, got ${q(value)}`,
    );
  }
  return /** @type {GuestFormulaId} */ (value);
};
harden(assertGuestFormulaId);

/**
 * Non-throwing predicate form.
 *
 * @param {unknown} value
 * @returns {value is GuestFormulaId}
 */
export const isGuestFormulaId = value =>
  typeof value === 'string' && FORMULA_ID.test(value);
harden(isGuestFormulaId);
