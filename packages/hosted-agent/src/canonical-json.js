// @ts-check

import { Fail, makeError, q, X } from '@endo/errors';

const MAX_DEPTH = 64;

/**
 * Canonically encode capability-free data.
 *
 * A smaller domain than ordinary passable values, encoded with sorted record
 * keys and a tag per value kind, so two records with the same content encode
 * to the same string whatever their key order, bigints survive, and a value
 * carrying a capability, an exotic object or a non-finite number is refused
 * at the trust boundary rather than encoded as something else. Codex's audit
 * journal stores entries in this form and decodes it exactly
 * (`codex-sandbox/src/audit-journal.js`); the execution envelope compares a
 * slice's raw attestation and a broker's evidence against what a session
 * approved with it.
 *
 * @param {unknown} value
 * @param {number} [depth]
 * @returns {string}
 */
export const canonicalJson = (value, depth = 0) => {
  depth <= MAX_DEPTH || Fail`canonical data exceeded ${MAX_DEPTH} levels`;
  if (value === null) return '["null"]';
  if (typeof value === 'boolean') {
    return `["boolean",${JSON.stringify(value)}]`;
  }
  if (typeof value === 'string') {
    return `["string",${JSON.stringify(value)}]`;
  }
  if (typeof value === 'number') {
    Number.isFinite(value) || Fail`canonical data contains a non-finite number`;
    return `["number",${JSON.stringify(
      Object.is(value, -0) ? '-0' : `${value}`,
    )}]`;
  }
  if (typeof value === 'bigint') {
    return `["bigint",${JSON.stringify(`${value}`)}]`;
  }
  if (Array.isArray(value)) {
    return `["array",[${value
      .map(element => canonicalJson(element, depth + 1))
      .join(',')}]]`;
  }
  if (typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value);
    prototype === Object.prototype ||
      prototype === null ||
      Fail`canonical data must contain only copy records, not ${q(
        prototype?.constructor?.name || 'an exotic object',
      )}`;
    return `["record",[${Object.keys(value)
      .sort()
      .map(
        key =>
          `[${JSON.stringify(key)},${canonicalJson(
            /** @type {Record<string, unknown>} */ (value)[key],
            depth + 1,
          )}]`,
      )
      .join(',')}]]`;
  }
  throw makeError(X`canonical data cannot contain ${q(typeof value)} values`);
};
harden(canonicalJson);
